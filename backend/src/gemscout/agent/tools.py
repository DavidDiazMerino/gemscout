"""
GemScout Agent Tools — called by Google Cloud Agent Builder via the FastAPI backend.

Each tool is a pure async function that performs one focused task.
The agent orchestrates them to answer scouting queries.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from gemscout.db.mongodb import PLAYERS_COLLECTION, VECTOR_INDEX_NAME, get_async_db
from gemscout.embeddings.voyage import embed_query
from gemscout.settings import settings

logger = logging.getLogger("gemscout.agent.tools")

# Leagues by tier for World Cup 2026 narrative
LEAGUE_TIERS: dict[str, int] = {
    # Tier 1 — Big 5 Europe
    "premier-league": 1, "la-liga": 1, "bundesliga": 1,
    "serie-a": 1, "ligue-1": 1,
    # Tier 2 — Strong Europe
    "eredivisie": 2, "primeira-liga": 2, "scottish-premiership": 2,
    "pro-league": 2, "super-lig": 2, "serie-a-bra": 2,
    # Tier 3 — Americas & Rest
    "brasileiro-serie-a": 3, "liga-mx": 3, "mls": 3,
    "primera-division-arg": 3, "primera-division-col": 3,
    "primera-division-chi": 3,
}

# Positions with World Cup squad role context
POSITION_CONTEXT = {
    "FWD": "striker or wide forward, evaluated on goals and xG",
    "MID": "midfielder, evaluated on creativity, pressing, and ball progression",
    "DEF": "defender, evaluated on defensive intensity and build-up contribution",
    "GK": "goalkeeper, evaluated on saves, goals prevented, and distribution",
}


@dataclass
class PlayerResult:
    qid: str
    name: str
    age: int
    position: str
    nationality: str
    team: str
    league: str
    league_tier: int
    season: str
    stats: dict
    metrics_normalized: dict
    market_value_eur: int | None
    vector_score: float | None
    profile_text: str
    history: dict = None  # {"2024-25": {"stats": {...}, "metrics_normalized": {...}}, ...}

    def __post_init__(self):
        if self.history is None:
            self.history = {}


async def semantic_player_search(
    query: str,
    position: str | None = None,
    max_age: int | None = None,
    min_age: int | None = None,
    league_tier_max: int | None = None,
    league_tier_min: int | None = None,
    league_slug: str | None = None,
    season: str = "2025-26",
    limit: int = 10,
) -> list[PlayerResult]:
    """
    Translates a natural language scouting query into a MongoDB Atlas Vector Search,
    then post-filters by position, age, and league tier.

    This is the core 'money shot' of GemScout — semantic search over tactical profiles.
    """
    db = get_async_db()
    collection = db[PLAYERS_COLLECTION]

    logger.info("semantic_search query=%r position=%s max_age=%s", query, position, max_age)

    query_vector = embed_query(query)

    # Build inline MQL filter for $vectorSearch.
    # All fields here are declared as {"type":"filter"} in the player_embedding_index,
    # so filtering happens INSIDE the ANN search — no post-$match needed.
    filter_clauses: list[dict] = [{"season": {"$eq": season}}]
    if position:
        filter_clauses.append({"position": {"$eq": position.upper()}})
    if max_age is not None and min_age is not None:
        filter_clauses.append({"age": {"$gte": min_age, "$lte": max_age}})
    elif max_age is not None:
        filter_clauses.append({"age": {"$lte": max_age}})
    elif min_age is not None:
        filter_clauses.append({"age": {"$gte": min_age}})
    tier_cond: dict = {}
    if league_tier_max is not None:
        tier_cond["$lte"] = league_tier_max
    if league_tier_min is not None:
        tier_cond["$gte"] = league_tier_min
    if tier_cond:
        filter_clauses.append({"league_tier": tier_cond})
    if league_slug:
        filter_clauses.append({"league_slug": {"$eq": league_slug}})

    inline_filter = {"$and": filter_clauses} if len(filter_clauses) > 1 else filter_clauses[0]

    pipeline = [
        {
            "$vectorSearch": {
                "index": VECTOR_INDEX_NAME,
                "path": "embedding",
                "queryVector": query_vector,
                "numCandidates": 200,
                "limit": limit,
                "filter": inline_filter,  # pre-filter inside $vectorSearch — no post-$match
            }
        },
        {"$addFields": {"vector_score": {"$meta": "vectorSearchScore"}}},
    ]

    results = []
    async for doc in collection.aggregate(pipeline):
        results.append(
            PlayerResult(
                qid=doc["_id"],
                name=doc.get("name", ""),
                age=doc.get("age", 0),
                position=doc.get("position", ""),
                nationality=doc.get("nationality", ""),
                team=doc.get("current_team", ""),
                league=doc.get("league", ""),
                league_tier=doc.get("league_tier", 3),
                season=doc.get("season", season),
                stats=doc.get("stats", {}),
                metrics_normalized=doc.get("metrics_normalized", {}),
                market_value_eur=doc.get("market_value_eur"),
                vector_score=doc.get("vector_score"),
                profile_text=doc.get("profile_text", ""),
                history=doc.get("history", {}),
            )
        )

    logger.info("semantic_search found %d results", len(results))
    return results


async def filter_players(
    position: str | None = None,
    max_age: int | None = None,
    min_age: int | None = None,
    league_tier_max: int | None = None,
    league_tier_min: int | None = None,
    league_slug: str | None = None,
    min_percentile: dict[str, float] | None = None,
    season: str = "2025-26",
    sort_by: str = "xg",
    limit: int = 20,
) -> list[PlayerResult]:
    """
    Quantitative filter: find players matching strict criteria.
    Used when the agent needs to verify or cross-reference semantic results.
    """
    db = get_async_db()
    collection = db[PLAYERS_COLLECTION]

    match_conditions: dict = {"season": season}
    if position:
        match_conditions["position"] = position.upper()
    if max_age is not None:
        match_conditions["age"] = {"$lte": max_age}
    if min_age is not None:
        match_conditions.setdefault("age", {})["$gte"] = min_age
    tier_cond: dict = {}
    if league_tier_max is not None:
        tier_cond["$lte"] = league_tier_max
    if league_tier_min is not None:
        tier_cond["$gte"] = league_tier_min
    if tier_cond:
        match_conditions["league_tier"] = tier_cond
    if league_slug:
        match_conditions["league_slug"] = league_slug
    if min_percentile:
        for metric, threshold in min_percentile.items():
            match_conditions[f"metrics_normalized.{metric}"] = {"$gte": threshold}

    sort_key = f"metrics_normalized.{sort_by}" if sort_by != "age" else "age"
    sort_dir = 1 if sort_by == "age" else -1

    cursor = (
        collection.find(match_conditions)
        .sort(sort_key, sort_dir)
        .limit(limit)
    )

    results = []
    async for doc in cursor:
        results.append(
            PlayerResult(
                qid=doc["_id"],
                name=doc.get("name", ""),
                age=doc.get("age", 0),
                position=doc.get("position", ""),
                nationality=doc.get("nationality", ""),
                team=doc.get("current_team", ""),
                league=doc.get("league", ""),
                league_tier=doc.get("league_tier", 3),
                season=doc.get("season", season),
                stats=doc.get("stats", {}),
                metrics_normalized=doc.get("metrics_normalized", {}),
                market_value_eur=doc.get("market_value_eur"),
                vector_score=None,
                profile_text=doc.get("profile_text", ""),
                history=doc.get("history", {}),
            )
        )

    return results


async def get_player_details(qid: str) -> PlayerResult | None:
    """Fetch complete player profile by Wikidata QID."""
    db = get_async_db()
    doc = await db[PLAYERS_COLLECTION].find_one({"_id": qid})
    if not doc:
        return None
    return PlayerResult(
        qid=doc["_id"],
        name=doc.get("name", ""),
        age=doc.get("age", 0),
        position=doc.get("position", ""),
        nationality=doc.get("nationality", ""),
        team=doc.get("current_team", ""),
        league=doc.get("league", ""),
        league_tier=doc.get("league_tier", 3),
        season=doc.get("season", ""),
        stats=doc.get("stats", {}),
        metrics_normalized=doc.get("metrics_normalized", {}),
        market_value_eur=doc.get("market_value_eur"),
        vector_score=None,
        profile_text=doc.get("profile_text", ""),
    )


_TREND_KEYS_BY_POSITION: dict[str, list[str]] = {
    "GK":  ["save_percent", "goals_prevented", "clean_sheets"],
    "DEF": ["xg_chain", "xg_buildup", "key_passes"],
    "MID": ["xa", "key_passes", "xg_chain", "xg_buildup"],
    "FWD": ["xg", "goals", "xa"],
}
_TREND_KEYS_DEFAULT = ["xg", "xa", "key_passes", "xg_chain"]


def _avg_score(norm: dict, keys: list[str]) -> float:
    vals = [float(norm.get(k) or 0) for k in keys if norm.get(k) is not None]
    return sum(vals) / len(vals) if vals else 0.0


def _build_history_block(p: PlayerResult) -> str:
    """Build a World Cup cycle trajectory block for the Gemini prompt."""
    trend_keys = _TREND_KEYS_BY_POSITION.get(p.position, _TREND_KEYS_DEFAULT)

    # Collect all seasons in chronological order (oldest first, current last)
    historical_seasons = sorted(p.history.keys())
    all_seasons = historical_seasons + [p.season]

    season_rows: list[str] = []
    for season in all_seasons:
        if season == p.season:
            norm = p.metrics_normalized
            stats = p.stats
        else:
            data = p.history.get(season, {})
            norm = data.get("metrics_normalized", {})
            stats = data.get("stats", {})
        if not norm:
            continue
        parts = []
        for key in trend_keys:
            pct = norm.get(key)
            val = stats.get(key)
            if pct is not None:
                tag = "↑" if pct >= 80 else ("↓" if pct <= 20 else "")
                parts.append(f"{key.replace('_', ' ')}: {val} ({int(pct)}th{tag})")
        if parts:
            label = " ← CURRENT SEASON" if season == p.season else ""
            season_rows.append(f"  {season}: {', '.join(parts)}{label}")

    if not season_rows:
        return ""

    # Trend direction: compare current vs most recent previous season
    direction_text = ""
    if historical_seasons:
        prev_norm = p.history[historical_seasons[-1]].get("metrics_normalized", {})
        current_avg = _avg_score(p.metrics_normalized, trend_keys)
        prev_avg = _avg_score(prev_norm, trend_keys)
        diff = current_avg - prev_avg
        if diff >= 5:
            direction_text = "RAPIDLY IMPROVING — major step-up vs last season"
        elif diff >= 2:
            direction_text = "IMPROVING — clear progression"
        elif diff <= -5:
            direction_text = "DECLINING — significant regression vs last season"
        elif diff <= -2:
            direction_text = "DECLINING — moderate regression"
        else:
            direction_text = "STABLE — consistent output across the WC cycle"

    lines = ["World Cup cycle trajectory (3-season data):"] + season_rows
    if direction_text:
        lines.append(f"  → Trend: {direction_text}")
    return "\n".join(lines)


_METRICS_BY_POSITION: dict[str, list[tuple[str, str]]] = {
    "GK": [
        ("save_percent", "Save % (shots stopped)"),
        ("goals_prevented", "Goals prevented (vs xG faced)"),
        ("clean_sheets", "Clean sheets"),
        ("rating", "Match rating"),
        ("minutes", "Minutes played"),
    ],
    "FWD": [
        ("xg", "xG (expected goals)"),
        ("goals", "Goals"),
        ("npxg", "npxG (non-penalty xG)"),
        ("xa", "xA (expected assists)"),
        ("xg_chain", "xG chain (pressing/involvement)"),
        ("shots", "Shots"),
    ],
    "MID": [
        ("xa", "xA (expected assists)"),
        ("key_passes", "Key passes"),
        ("xg_chain", "xG chain (pressing/involvement)"),
        ("xg_buildup", "xG buildup (progressive play)"),
        ("xg", "xG (expected goals)"),
        ("assists", "Assists"),
    ],
    "DEF": [
        ("xg_chain", "xG chain (progressive involvement)"),
        ("xg_buildup", "xG buildup (build-up play)"),
        ("key_passes", "Key passes"),
        ("xa", "xA (expected assists)"),
        ("minutes", "Minutes played"),
        ("assists", "Assists"),
    ],
}

_DEFAULT_METRICS: list[tuple[str, str]] = [
    ("xg", "xG (expected goals)"),
    ("xa", "xA (expected assists)"),
    ("key_passes", "Key passes"),
    ("xg_chain", "xG chain (pressing/involvement)"),
    ("xg_buildup", "xG buildup (progressive play)"),
    ("goals", "Goals"),
    ("assists", "Assists"),
]


def build_scouting_prompt(
    original_query: str,
    players: list[PlayerResult],
    world_cup_context: bool = True,
    data_note: str = "",
) -> str:
    """
    Build the Gemini prompt for generating professional scouting dossiers.
    Structured like a real UEFA Pro Licence scout report.
    """
    player_sections = []
    for p in players[:3]:
        norm = p.metrics_normalized
        stats = p.stats

        metrics_to_show = _METRICS_BY_POSITION.get(p.position, _DEFAULT_METRICS)
        stat_lines = []
        for metric, label in metrics_to_show:
            pct = norm.get(metric)
            val = stats.get(metric)
            if pct is not None:
                qualifier = ""
                if pct >= 90:
                    qualifier = " ← elite"
                elif pct >= 80:
                    qualifier = " ← very good"
                elif pct <= 20:
                    qualifier = " ← concern"
                stat_lines.append(f"  - {label}: {val}  ({int(pct)}th pct{qualifier})")

        stats_block = (
            "\n".join(stat_lines)
            if stat_lines
            else "  - Full statistical profile not available for this season"
        )

        value_str = (
            f"€{p.market_value_eur / 1_000_000:.1f}M"
            if p.market_value_eur
            else "not valued"
        )
        tier_desc = {1: "Big-5 European", 2: "Mid-tier European", 3: "Americas/Other"}.get(
            p.league_tier, "Unknown"
        )

        history_block = _build_history_block(p)
        history_section = f"\n\n{history_block}" if history_block else ""

        player_sections.append(
            f"=== {p.name.upper()} ===\n"
            f"Position: {p.position} | Age: {p.age} | Nationality: {p.nationality}\n"
            f"Club: {p.team} — {p.league} ({tier_desc} league)\n"
            f"Market value: {value_str} | Season: {p.season}\n\n"
            f"Statistical profile (current season):\n{stats_block}"
            f"{history_section}"
        )

    players_text = "\n\n".join(player_sections)

    wc_section = (
        "\n\nWORLD CUP 2026 VERDICT:\n"
        "Assess the player's realistic World Cup 2026 role: starting XI candidate, impact substitute, "
        "or squad depth? Which phase of the tournament suits them best (group stage pressing, knockout "
        "game management, set-piece threat)? If they play outside the Big-5, note the visibility gap "
        "traditional scouts face and why it's an opportunity."
        if world_cup_context
        else ""
    )

    data_note_block = f"\n⚠ DATA COVERAGE: {data_note}\n" if data_note else ""

    return f"""You are a senior football scout with a UEFA Pro Licence, writing a confidential pre-World Cup scouting dossier for a national team director.

DIRECTOR'S REQUEST: "{original_query}"
{data_note_block}
GemScout's semantic + statistical engine has ranked these players from a pool of 2,200+. Your job is to turn the numbers into scout intelligence.

{players_text}

Write a structured SCOUTING REPORT for each player. Use EXACTLY this format:

## [Full player name]

TACTICAL VERDICT:
[One sentence — your immediate scout's take. Opinionated. E.g., "A technically gifted playmaker who dominates possession pockets but needs a protection screen to unlock his best football."]

KEY STRENGTHS:
- [Strength 1: tactical description backed by a specific stat — e.g., "Leads the press from the front: 89th percentile xG chain means he's constantly in the action off the ball"]
- [Strength 2]
- [Strength 3]

RISK FLAGS:
- [Risk 1: be honest — league level gap, age curve, injury history, consistency, adaptation concerns]
- [Risk 2 if applicable]

WORLD CUP CYCLE TREND:
- [Comment on the 3-season trajectory using the data above: Is the player peaking now for the tournament? Rising through the cycle? Plateauing? Use specific percentile changes across seasons to justify your assessment.]
{wc_section}

RECOMMENDATION: [SIGN NOW / TRACK CLOSELY / MONITOR / PASS]
CONFIDENCE: [HIGH / MEDIUM / LOW] — [one-sentence reason]

---

Rules: use concrete football language (pressing traps, half-spaces, build-up triangles, etc.). Quote percentile ranks where they tell the real story. Never write "good player" or "works hard". This document is confidential and goes directly to the director before a major transfer window."""
