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


async def semantic_player_search(
    query: str,
    position: str | None = None,
    max_age: int | None = None,
    min_age: int | None = None,
    league_tier_max: int | None = None,
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

    # Build Atlas Vector Search pipeline
    vector_stage = {
        "$vectorSearch": {
            "index": VECTOR_INDEX_NAME,
            "path": "embedding",
            "queryVector": query_vector,
            "numCandidates": 200,
            "limit": limit * 4,  # Over-fetch to allow post-filtering
        }
    }

    # Post-filter stage
    match_conditions: dict = {"season": season}
    if position:
        match_conditions["position"] = position.upper()
    if max_age is not None:
        match_conditions["age"] = {"$lte": max_age}
    if min_age is not None:
        match_conditions.setdefault("age", {})["$gte"] = min_age
    if league_tier_max is not None:
        match_conditions["league_tier"] = {"$lte": league_tier_max}

    pipeline = [
        vector_stage,
        {"$addFields": {"vector_score": {"$meta": "vectorSearchScore"}}},
    ]
    if match_conditions:
        pipeline.append({"$match": match_conditions})
    pipeline.append({"$limit": limit})

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
            )
        )

    logger.info("semantic_search found %d results", len(results))
    return results


async def filter_players(
    position: str | None = None,
    max_age: int | None = None,
    min_age: int | None = None,
    league_tier_max: int | None = None,
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
    if league_tier_max is not None:
        match_conditions["league_tier"] = {"$lte": league_tier_max}
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


def build_scouting_prompt(
    original_query: str,
    players: list[PlayerResult],
    world_cup_context: bool = True,
) -> str:
    """
    Build the Gemini prompt for generating scouting reports.
    Produces rich, actionable reports per player — not just a list.
    """
    player_sections = []
    for i, p in enumerate(players[:3], 1):
        norm = p.metrics_normalized
        stats = p.stats

        # Format top metrics
        metric_lines = []
        for metric, label in [
            ("xg", "xG (expected goals)"),
            ("xa", "xA (expected assists)"),
            ("key_passes", "Key passes"),
            ("xg_chain", "xG chain (pressing/involvement)"),
            ("xg_buildup", "xG buildup (progressive play)"),
            ("goals", "Goals"),
            ("assists", "Assists"),
        ]:
            pct = norm.get(metric)
            val = stats.get(metric)
            if pct is not None:
                metric_lines.append(f"  - {label}: {val} ({int(pct)}th percentile)")

        value_str = (
            f"€{p.market_value_eur / 1_000_000:.1f}M"
            if p.market_value_eur
            else "market value unknown"
        )
        tier_desc = {1: "Big-5 Europe", 2: "Mid-tier Europe", 3: "Americas/Other"}.get(
            p.league_tier, "Unknown"
        )

        player_sections.append(
            f"PLAYER {i}: {p.name}\n"
            f"Age: {p.age} | Position: {p.position} | Nationality: {p.nationality}\n"
            f"Club: {p.team} ({p.league}, {tier_desc})\n"
            f"Market value: {value_str}\n"
            f"Key stats ({p.season}):\n" + "\n".join(metric_lines)
        )

    players_text = "\n\n".join(player_sections)

    wc_instruction = (
        "\nAlso assess their World Cup 2026 readiness: "
        "could they make a national squad impact, and what role would they play? "
        "If they're in a non-European league, explicitly note why they could be overlooked "
        "by traditional scouts — and why they shouldn't be."
        if world_cup_context
        else ""
    )

    return f"""You are GemScout, an elite football scout AI preparing a World Cup 2026 scouting dossier.

The scouting director asked: "{original_query}"

Based on semantic and statistical analysis of 2,200+ players, here are the top candidates:

{players_text}

Generate a detailed SCOUTING REPORT for each player. For each one:
1. Start with a one-sentence tactical verdict (e.g., "A relentless pressing midfielder with elite chance-creation — exactly the profile the director is looking for")
2. Explain their strongest qualities in tactical terms (not just numbers)
3. Identify any weaknesses or risks
4. Justify the ranking — why this player over other candidates
5. Give a confidence rating: HIGH / MEDIUM / LOW{wc_instruction}

Format each report clearly with player name as header. Be direct and specific — this goes to a national team director."""
