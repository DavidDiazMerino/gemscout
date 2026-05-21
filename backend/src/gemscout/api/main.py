"""
GemScout FastAPI backend.

Preserves all OpenMercat endpoints and adds the /agent/* routes
that power the Google Cloud Agent Builder integration.
"""

from __future__ import annotations

import json as _json
import logging
from collections import defaultdict, deque
from time import monotonic, perf_counter
from typing import Any

import httpx

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from gemscout.agent.tools import (
    PlayerResult,
    build_scouting_prompt,
    filter_players,
    get_player_details,
    semantic_player_search,
)
from gemscout.db.mongodb import (
    PLAYERS_COLLECTION,
    TEMPLATES_COLLECTION,
    close_connections,
    get_async_db,
)
from gemscout.settings import settings

logger = logging.getLogger("gemscout.api")

app = FastAPI(
    title="GemScout API",
    version="0.1.0",
    description="AI football scouting agent — Google Cloud Rapid Agent Hackathon 2026",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    pass  # Gemini auth via Vertex AI Workload Identity (no API key needed on Cloud Run)


@app.on_event("shutdown")
async def shutdown():
    await close_connections()


@app.middleware("http")
async def timing_middleware(request: Request, call_next):
    started = perf_counter()
    response = await call_next(request)
    elapsed_ms = (perf_counter() - started) * 1000
    response.headers["X-Process-Time-Ms"] = f"{elapsed_ms:.2f}"
    if elapsed_ms >= settings.slow_request_ms:
        logger.warning("slow_request %s %s %.2fms", request.method, request.url.path, elapsed_ms)
    return response


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok", "service": "gemscout"}


@app.get("/ready")
async def ready():
    db = get_async_db()
    count = await db[PLAYERS_COLLECTION].count_documents({})
    return {"status": "ok", "players_indexed": count}


# ---------------------------------------------------------------------------
# Player listings (OpenMercat-compatible endpoints, now backed by MongoDB)
# ---------------------------------------------------------------------------

@app.get("/players/count")
async def player_count(season: str = "2025-26"):
    db = get_async_db()
    count = await db[PLAYERS_COLLECTION].count_documents({"season": season})
    return {"count": count, "season": season}


@app.get("/seasons")
async def seasons():
    db = get_async_db()
    seasons_list = await db[PLAYERS_COLLECTION].distinct("season")
    return sorted(seasons_list, reverse=True)


@app.get("/players")
async def list_players(
    season: str = "2025-26",
    position: str | None = None,
    league: str | None = None,
    search: str | None = None,
    sort_by: str = "xg",
    limit: int = Query(default=50, le=200),
    offset: int = 0,
):
    db = get_async_db()
    query: dict[str, Any] = {"season": season}
    if position and position != "ALL":
        query["position"] = position.upper()
    if league:
        query["league_slug"] = league
    if search and len(search) >= 2:
        query["name"] = {"$regex": search, "$options": "i"}

    sort_key = f"metrics_normalized.{sort_by}" if sort_by not in ("age", "market_value_eur") else sort_by
    total = await db[PLAYERS_COLLECTION].count_documents(query)
    cursor = (
        db[PLAYERS_COLLECTION]
        .find(query, {"embedding": 0})
        .sort(sort_key, -1)
        .skip(offset)
        .limit(limit)
    )
    players = []
    async for doc in cursor:
        doc["id"] = doc.pop("_id")
        players.append(doc)

    return {"players": players, "total": total, "offset": offset, "limit": limit}


@app.get("/players/{qid}")
async def get_player(qid: str):
    db = get_async_db()
    doc = await db[PLAYERS_COLLECTION].find_one({"_id": qid}, {"embedding": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Player not found")
    doc["id"] = doc.pop("_id")
    return doc


# ---------------------------------------------------------------------------
# Rankings (OpenMercat-compatible — weighted scoring)
# ---------------------------------------------------------------------------

_METRIC_LABELS: dict[str, str] = {
    "xg": "xG", "xa": "xA", "goals": "Goles", "assists": "Asistencias",
    "key_passes": "Pases clave", "xg_chain": "xG chain", "xg_buildup": "xG buildup",
    "shots": "Tiros", "npg": "Goles NP", "npxg": "npxG", "minutes": "Minutos",
    "save_percent": "Save %", "goals_prevented": "Goles evitados",
    "clean_sheets": "Porterías a 0", "rating": "Rating",
}


_TREND_KEYS_BY_POSITION: dict[str, list[str]] = {
    "GK":  ["save_percent", "goals_prevented", "clean_sheets", "minutes"],
    "DEF": ["xg_chain", "xg_buildup", "key_passes", "minutes"],
    "MID": ["xa", "key_passes", "xg_chain", "xg_buildup"],
    "FWD": ["xg", "goals", "npxg", "xa"],
}
_TREND_KEYS_DEFAULT = ["xg", "xa", "key_passes", "xg_chain"]


def _position_score(norm: dict, position: str) -> float:
    """Simple position-aware percentile score (0-100) for trend computation."""
    keys = _TREND_KEYS_BY_POSITION.get(position or "", _TREND_KEYS_DEFAULT)
    values = [float(norm[k]) for k in keys if norm.get(k) is not None]
    return round(sum(values) / len(values), 2) if values else 0.0


def _compute_trend(
    current_score: float,
    current_season: str,
    history: dict,
    position: str,
    current_minutes: float | None,
) -> dict:
    """Build the trend dict using historical seasons."""
    values_by_season: dict[str, float] = {current_season: current_score}
    minutes_by_season: dict[str, float | None] = {current_season: current_minutes}

    for season, data in sorted(history.items(), reverse=True):
        h_norm = data.get("metrics_normalized") or {}
        h_stats = data.get("stats") or {}
        h_score = _position_score(h_norm, position)
        values_by_season[season] = h_score
        minutes_by_season[season] = h_stats.get("minutes")

    # Determine direction: compare current vs most recent historical season
    seasons_sorted = sorted(values_by_season.keys(), reverse=True)
    if len(seasons_sorted) < 2:
        direction = "insufficient"
    else:
        diff = values_by_season[seasons_sorted[0]] - values_by_season[seasons_sorted[1]]
        if diff >= 3:
            direction = "up"
        elif diff <= -3:
            direction = "down"
        else:
            direction = "flat"

    return {
        "direction": direction,
        "values_by_season": values_by_season,
        "minutes_by_season": minutes_by_season,
    }


def _doc_to_player_row(doc: dict, score: float, weights: dict[str, float]) -> dict:
    """Map a raw MongoDB player document to the PlayerRow shape the Explorer frontend expects."""
    stats = doc.get("stats", {})
    norm = doc.get("metrics_normalized", {})
    history = doc.get("history", {})
    position = doc.get("position", "")
    minutes = stats.get("minutes") or 0

    if minutes >= 1800:
        confidence_label = "Alta"
    elif minutes >= 900:
        confidence_label = "Media"
    else:
        confidence_label = "Baja"

    drivers = []
    for metric, weight in sorted(weights.items(), key=lambda x: x[1], reverse=True):
        percentile = norm.get(metric)
        if percentile is not None and weight > 0:
            drivers.append({
                "metric": metric,
                "label": _METRIC_LABELS.get(metric, metric),
                "percentile": round(float(percentile)),
                "weight": round(float(weight), 3),
                "impact": round(float(weight) * float(percentile)),
            })
        if len(drivers) >= 4:
            break

    season = doc.get("season", "2025-26")
    trend = _compute_trend(
        _position_score(norm, position), season, history, position, stats.get("minutes")
    )

    return {
        "id": doc.get("_id") or doc.get("id"),
        "name": doc.get("name", ""),
        "position": position,
        "position_detail": None,
        "age": doc.get("age"),
        "team_name": doc.get("current_team"),
        "league_name": doc.get("league"),
        "season": season,
        "value": round(score, 2),
        "goals": stats.get("goals"),
        "assists": stats.get("assists"),
        "minutes": stats.get("minutes"),
        "xg": stats.get("xg"),
        "xa": stats.get("xa"),
        "metrics": stats,
        "metrics_normalized": norm,
        "stats_source": "fbref",
        "stats_fetched_at": None,
        "om_value_eur": None,
        "tm_value_eur": doc.get("market_value_eur"),
        "tm_value_date": None,
        "tm_fetched_at": None,
        "tm_delta_eur": None,
        "explanation": {
            "summary": f"{doc.get('name', '')} — puntuación calculada con tus pesos personalizados.",
            "drivers": drivers,
            "penalties": [],
        },
        "confidence_label": confidence_label,
        "confidence_reasons": [],
        "trend": trend,
        "market_reading": {
            "label": "En precio" if doc.get("market_value_eur") else "Sin datos",
            "summary": "",
            "notes": [],
        },
    }


class RankingPreviewRequest(BaseModel):
    weights: dict[str, float]
    season: str = "2025-26"
    position: str | None = None
    league_slug: str | None = None
    limit: int = Field(default=50, le=200)


@app.post("/rankings/preview")
async def rankings_preview(body: RankingPreviewRequest):
    """
    Compute weighted rankings on-the-fly from user-defined metric weights.
    Preserves the OpenMercat slider experience in the frontend.
    """
    db = get_async_db()
    query: dict[str, Any] = {"season": body.season}
    if body.position and body.position != "ALL":
        query["position"] = body.position.upper()
    if body.league_slug:
        query["league_slug"] = body.league_slug

    total_weight = sum(body.weights.values())
    if total_weight == 0:
        raise HTTPException(status_code=400, detail="weights must sum to a positive number")
    normalised = {k: v / total_weight for k, v in body.weights.items()}

    cursor = db[PLAYERS_COLLECTION].find(query, {"embedding": 0}).limit(1000)

    results = []
    async for doc in cursor:
        norm = doc.get("metrics_normalized", {})
        score = sum(
            (norm.get(metric) or 0) * weight
            for metric, weight in normalised.items()
        )
        results.append(_doc_to_player_row(doc, score, normalised))

    results.sort(key=lambda x: x["value"], reverse=True)
    return {"players": results[: body.limit], "total": len(results)}


# ---------------------------------------------------------------------------
# Templates (stub endpoints — Explorer expects these to exist)
# ---------------------------------------------------------------------------

@app.get("/templates/curated")
async def templates_curated(season: str = "2025-26", league_slug: str | None = None):
    return []


@app.get("/templates")
async def templates_list(limit: int = 6):
    return []


@app.get("/templates/{template_id}")
async def get_template(template_id: str):
    raise HTTPException(status_code=404, detail="Template not found")


@app.get("/players/{qid}/history")
async def player_history(qid: str, template_id: str | None = None):
    db = get_async_db()
    doc = await db[PLAYERS_COLLECTION].find_one({"_id": qid}, {"history": 1, "stats": 1, "metrics_normalized": 1, "season": 1, "position": 1})
    if not doc:
        return []

    position = doc.get("position", "")
    current_season = doc.get("season", "2025-26")
    current_norm = doc.get("metrics_normalized") or {}
    current_stats = doc.get("stats") or {}
    history = doc.get("history") or {}

    rows = [
        {
            "season": current_season,
            "value": _position_score(current_norm, position),
            "metrics": current_stats,
            "metrics_normalized": current_norm,
        }
    ]
    for season in sorted(history.keys(), reverse=True):
        h = history[season]
        h_norm = h.get("metrics_normalized") or {}
        rows.append({
            "season": season,
            "value": _position_score(h_norm, position),
            "metrics": h.get("stats") or {},
            "metrics_normalized": h_norm,
        })

    return rows


# ---------------------------------------------------------------------------
# AGENT ENDPOINTS — the new GemScout brain
# ---------------------------------------------------------------------------

class ScoutRequest(BaseModel):
    query: str = Field(min_length=5, max_length=500)
    position: str | None = None
    max_age: int | None = None
    min_age: int | None = None
    league_tier_max: int | None = None
    league_tier_min: int | None = None
    league_slug: str | None = None
    season: str = "2025-26"
    world_cup_context: bool = True
    limit: int = Field(default=5, le=10)
    debug_mode: bool = False


import re as _re

_POSITION_PATTERNS = [
    (r"\b(striker|forward|winger|centre.forward|cf\b)", "FWD"),
    (r"\b(midfielder|midfield|box.to.box|b2b|cam|cdm|cm\b)", "MID"),
    (r"\b(defender|centre.back|cb\b|full.back|fullback|rb\b|lb\b)", "DEF"),
    (r"\b(goalkeeper|keeper|gk\b)", "GK"),
]
_AGE_PATTERN = _re.compile(r"\bunder\s*(\d{2})\b", _re.I)

# Only match explicit league references — NOT "South American player" (nationality).
# americas?\b requires a word boundary AFTER "america(s)", so "American" won't match.
_AMERICAS_LEAGUE_PATTERN = _re.compile(
    r"\b(americas?\b|mls|liga\s*mx|brasileir[ao]|conmebol|south\s*american\s*league)", _re.I
)

_LEAGUE_PATTERNS = [
    (r"\bpremier\s*league\b", "premier-league"),
    (r"\bla\s*liga\b", "la-liga"),
    (r"\bbundesliga\b", "bundesliga"),
    (r"\bserie\s*a\b", "serie-a"),
    (r"\bligue\s*1\b", "ligue-1"),
    (r"\beredivisie\b", "eredivisie"),
]


def _parse_query_intent(query: str) -> dict:
    """Extract structured filters from natural language query text."""
    hints: dict = {}

    for pattern, pos in _POSITION_PATTERNS:
        if _re.search(pattern, query, _re.I):
            hints["position"] = pos
            break

    m = _AGE_PATTERN.search(query)
    if m:
        hints["max_age"] = int(m.group(1)) - 1

    if _AMERICAS_LEAGUE_PATTERN.search(query):
        hints["league_tier_min"] = 3
        hints["league_tier_max"] = 3
        hints["americas_requested"] = True

    for pattern, slug in _LEAGUE_PATTERNS:
        if _re.search(pattern, query, _re.I):
            hints["league_slug"] = slug
            break

    return hints


class ReasoningStep(BaseModel):
    step: int
    action: str
    detail: str
    result_summary: str | None = None


class DebugInfo(BaseModel):
    query_intent: dict
    filters_applied: dict
    semantic_candidates: list[dict]
    quant_candidates_count: int
    final_ranking: list[dict]
    timing_ms: dict
    vector_index: str
    embedding_model: str
    llm_model: str


class ScoutResponse(BaseModel):
    query: str
    reasoning_steps: list[ReasoningStep]
    players: list[dict]
    scouting_report: str
    tool_calls: list[str]
    debug_info: DebugInfo | None = None


_rate_limit: dict[str, deque] = defaultdict(deque)
RATE_WINDOW = 60
RATE_MAX = 30


def _check_rate_limit(client_ip: str) -> None:
    now = monotonic()
    hits = _rate_limit[client_ip]
    while hits and now - hits[0] > RATE_WINDOW:
        hits.popleft()
    if len(hits) >= RATE_MAX:
        raise HTTPException(status_code=429, detail="Rate limit exceeded — try again in 60s")
    hits.append(now)


# ── ADK Agent integration ────────────────────────────────────────────────────
# The main scouting flow routes through the ADK agent (Gemini 2.5 Flash)
# which uses the official @mongodb-js/mongodb-mcp-server partner MCP server
# to query MongoDB Atlas. This is the real product flow for the hackathon.

ADK_AGENT_BASE = "https://gemscout-agent-377689698254.europe-west3.run.app"


async def _call_adk_scout(
    query: str,
    position: str | None,
    max_age: int | None,
    min_age: int | None,
    league_slug: str | None,
    league_tier_max: int | None,
    debug_mode: bool,
) -> "ScoutResponse":
    """
    Calls the GemScout ADK agent on Cloud Run.
    The agent uses MCP (official @mongodb-js/mongodb-mcp-server) to search
    MongoDB Atlas and Gemini 2.5 Flash to write the scouting report.

    Returns a ScoutResponse with players (from MCP tool responses),
    scouting_report (from Gemini), and tool_calls (the MCP calls made).
    """
    # Build a natural-language message that includes any structured filters
    # so the agent embeds them in the compound.$search pipeline.
    parts = [query.strip()]
    if position:
        parts.append(f"Position filter: {position}.")
    if max_age:
        parts.append(f"Max age: {max_age}.")
    if min_age:
        parts.append(f"Min age: {min_age}.")
    if league_slug:
        parts.append(f"League: {league_slug}.")
    if league_tier_max:
        parts.append(f"Max league tier: {league_tier_max} (1=Big-5, 2=Strong EU, 3=Americas).")
    user_message = " ".join(parts)

    async with httpx.AsyncClient(timeout=90.0) as client:
        # 1. Create a throwaway session for this request
        sess = await client.post(
            f"{ADK_AGENT_BASE}/apps/gemscout_agent/users/gemscout/sessions",
            json={},
        )
        sess.raise_for_status()
        session_id = sess.json()["id"]

        # 2. Run the agent — Gemini orchestrates MCP tool calls
        run = await client.post(
            f"{ADK_AGENT_BASE}/run",
            json={
                "app_name": "gemscout_agent",
                "user_id": "gemscout",
                "session_id": session_id,
                "new_message": {
                    "role": "user",
                    "parts": [{"text": user_message}],
                },
            },
        )
        run.raise_for_status()
        events: list[dict] = run.json()

    # 3. Parse ADK events into our ScoutResponse format
    reasoning: list[ReasoningStep] = []
    tool_calls_list: list[str] = []
    players_raw: list[dict] = []
    scouting_report = ""
    step = 0
    seen_qids: set[str] = set()

    for event in events:
        author = event.get("author", "")
        for part in event.get("content", {}).get("parts", []):

            if "functionCall" in part:
                fc = part["functionCall"]
                step += 1
                tool_calls_list.append(fc["name"])
                args_preview = _json.dumps(fc.get("args", {}))[:300]
                reasoning.append(ReasoningStep(
                    step=step,
                    action=f"mcp:{fc['name']}",
                    detail=f"MCP tool call → {fc['name']}({args_preview})",
                ))

            elif "functionResponse" in part:
                resp_data = part["functionResponse"]
                tool_name = resp_data.get("name", "")
                content_items = resp_data.get("response", {}).get("content", [])
                summary = ""
                for item in content_items:
                    text = item.get("text", "")
                    if not text:
                        continue
                    if text.startswith("{") and '"name"' in text:
                        # Each document comes as a separate JSON string
                        try:
                            doc = _json.loads(text)
                            qid = doc.get("_id") or doc.get("qid", "")
                            if qid and qid not in seen_qids:
                                seen_qids.add(qid)
                                players_raw.append(doc)
                        except Exception:
                            pass
                    elif text.startswith("Found"):
                        summary = text
                if reasoning and summary:
                    reasoning[-1].result_summary = summary

            elif "text" in part and author == "gemscout":
                scouting_report += part["text"]

    # 4. Convert raw MongoDB docs → player dicts using existing helpers
    players_out: list[dict] = []
    for doc in players_raw:
        qid = doc.get("_id") or doc.get("qid", "")
        norm = doc.get("metrics_normalized") or {}
        position_doc = doc.get("position", "")
        history = doc.get("history") or {}
        stats = doc.get("stats") or {}
        season_doc = doc.get("season", "2025-26")

        trend = _compute_trend(
            _position_score(norm, position_doc),
            season_doc,
            history,
            position_doc,
            stats.get("minutes"),
        )
        players_out.append({
            "id": qid,
            "name": doc.get("name", ""),
            "age": doc.get("age", 0),
            "position": position_doc,
            "nationality": doc.get("nationality", ""),
            "current_team": doc.get("current_team", ""),
            "league": doc.get("league", ""),
            "league_tier": doc.get("league_tier", 0),
            "season": season_doc,
            "stats": stats,
            "metrics_normalized": norm,
            "market_value_eur": doc.get("market_value_eur"),
            "vector_score": None,
            "profile_text": doc.get("profile_text", ""),
            "trend": trend,
        })

    debug_info = None
    if debug_mode:
        debug_info = DebugInfo(
            query_intent={"mode": "ADK agent + MCP", "user_message": user_message},
            filters_applied={"position": position, "max_age": max_age, "league_slug": league_slug},
            semantic_candidates=[{"name": p["name"], "team": p["current_team"], "league": p["league"], "age": p["age"], "position": p["position"], "vector_score": 0} for p in players_out],
            quant_candidates_count=0,
            final_ranking=[{"name": p["name"], "team": p["current_team"], "vector_score": 0, "stat_score": 0, "combined_score": 0} for p in players_out],
            timing_ms={"adk_agent": -1},
            vector_index="player_text_index (Atlas Search via MCP)",
            embedding_model="none — MCP $search on profile_text",
            llm_model="gemini-2.5-flash (ADK agent)",
        )

    return ScoutResponse(
        query=query,
        reasoning_steps=reasoning,
        players=players_out[:5],
        scouting_report=scouting_report,
        tool_calls=tool_calls_list,
        debug_info=debug_info,
    )


@app.post("/agent/scout", response_model=ScoutResponse)
async def agent_scout(body: ScoutRequest, request: Request):
    """
    Main GemScout scouting endpoint.

    Routes through the ADK agent (Gemini 2.5 Flash) which uses the official
    @mongodb-js/mongodb-mcp-server partner MCP server to query MongoDB Atlas.
    All MongoDB operations go through the partner MCP server.
    """
    client_ip = request.client.host if request.client else "unknown"
    _check_rate_limit(client_ip)

    intent = _parse_query_intent(body.query)
    position = body.position or intent.get("position")
    max_age = body.max_age if body.max_age is not None else intent.get("max_age")
    min_age = body.min_age
    league_tier_max = body.league_tier_max if body.league_tier_max is not None else intent.get("league_tier_max")
    league_slug = body.league_slug or intent.get("league_slug")

    try:
        return await _call_adk_scout(
            query=body.query,
            position=position,
            max_age=max_age,
            min_age=min_age,
            league_slug=league_slug,
            league_tier_max=league_tier_max,
            debug_mode=body.debug_mode,
        )
    except Exception as exc:
        logger.error("ADK agent call failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Agent unavailable: {exc}")

    # ── Legacy fallback (kept for reference, never reached) ──────────────────
    americas_requested = intent.get("americas_requested", False)
    reasoning: list[ReasoningStep] = []
    tool_calls: list[str] = []
    step_timing: dict[str, float] = {}
    step = 0

    # Step 1: Semantic search via Voyage AI + Atlas Vector Search
    step += 1
    detail_parts = [
        f"Translating query to a tactical embedding via Voyage AI (voyage-3-large), "
        f"querying MongoDB Atlas Vector Search (index: player_embedding_index, "
        f"numCandidates: {body.limit * 2 * 20}, post-filtering)"
    ]
    if position:
        detail_parts.append(f"— position filter: {position}")
    if max_age:
        detail_parts.append(f"— age filter: ≤{max_age}")
    if league_slug:
        detail_parts.append(f"— league: {league_slug}")
    reasoning.append(ReasoningStep(
        step=step,
        action="semantic_player_search",
        detail=" ".join(detail_parts),
    ))
    tool_calls.append("semantic_player_search")

    _t = perf_counter()
    try:
        semantic_results = await semantic_player_search(
            query=body.query,
            position=position,
            max_age=max_age,
            min_age=min_age,
            league_tier_max=league_tier_max,
            league_tier_min=league_tier_min,
            league_slug=league_slug,
            season=body.season,
            limit=body.limit * 2,
        )
        top_score = semantic_results[0].vector_score if semantic_results else 0
        reasoning[-1].result_summary = (
            f"Atlas returned {len(semantic_results)} semantic matches. "
            f"Top: {semantic_results[0].name} (similarity {top_score:.3f})"
            if semantic_results else "No semantic matches"
        )
    except Exception as exc:
        logger.warning("semantic_search failed: %s", exc)
        semantic_results = []
        reasoning[-1].result_summary = f"Vector search unavailable — falling back to quantitative filter ({exc})"
    step_timing["semantic_search"] = round((perf_counter() - _t) * 1000, 1)

    # Step 2: Quantitative cross-validation
    step += 1
    filter_desc_parts = ["Applying hard filters to cross-validate semantic candidates:"]
    if position:
        filter_desc_parts.append(f"position={position}")
    if max_age:
        filter_desc_parts.append(f"max_age={max_age}")
    if league_slug:
        filter_desc_parts.append(f"league={league_slug}")
    filter_desc_parts.append("sorted by statistical dominance")
    reasoning.append(ReasoningStep(
        step=step,
        action="filter_players",
        detail=" ".join(filter_desc_parts),
    ))
    tool_calls.append("filter_players")

    _t = perf_counter()
    quant_results = await filter_players(
        position=position,
        max_age=max_age,
        min_age=min_age,
        league_tier_max=league_tier_max,
        league_tier_min=league_tier_min,
        league_slug=league_slug,
        season=body.season,
        limit=20,
    )
    step_timing["quant_filter"] = round((perf_counter() - _t) * 1000, 1)

    seen_qids = {p.qid for p in semantic_results}
    merged = list(semantic_results)
    for p in quant_results:
        if p.qid not in seen_qids:
            merged.append(p)
    final_players = merged[: body.limit]

    reasoning[-1].result_summary = (
        f"Quantitative filter: {len(quant_results)} players. "
        f"Semantic-only: {len(semantic_results)}, quant-only additions: {len(merged) - len(semantic_results)}. "
        f"Final pool: {len(final_players)} candidates."
    )

    # Step 3: Rank by combined score
    step += 1
    reasoning.append(ReasoningStep(
        step=step,
        action="rank_candidates",
        detail="Combined score = 60% semantic similarity + 40% position-specific stat percentile",
    ))
    tool_calls.append("rank_candidates")

    def combined_score(p: PlayerResult) -> float:
        norm = p.metrics_normalized
        if p.position == "GK":
            keys = ["save_percent", "goals_prevented", "clean_sheets"]
        elif p.position == "DEF":
            keys = ["xg_chain", "xg_buildup", "key_passes", "minutes"]
        elif p.position == "MID":
            keys = ["xa", "key_passes", "xg_chain", "xg_buildup"]
        else:
            keys = ["xg", "xa", "key_passes", "xg_chain"]
        stat_score = sum(norm.get(k) or 0 for k in keys) / len(keys)
        vec = (p.vector_score or 0) * 100
        return vec * 0.6 + stat_score * 0.4

    final_players.sort(key=combined_score, reverse=True)
    top3 = final_players[:3]

    reasoning[-1].result_summary = (
        f"Final ranking: "
        + ", ".join(
            f"{p.name} ({combined_score(p):.1f})"
            for p in top3
        )
    )

    # Step 4: Generate Gemini scouting report
    step += 1
    reasoning.append(ReasoningStep(
        step=step,
        action="generate_scouting_report",
        detail=f"Sending top-3 profiles to {settings.gemini_model} — structured scouting dossier format",
    ))
    tool_calls.append("generate_scouting_report")

    data_note = (
        "Database covers European leagues (2025-26 season). "
        "No Americas/CONMEBOL league data indexed. "
        "South American players shown are based at European clubs."
    ) if americas_requested else ""

    _t = perf_counter()
    scouting_report = await _generate_scouting_report(
        body.query, top3, body.world_cup_context, data_note=data_note
    )
    step_timing["report_generation"] = round((perf_counter() - _t) * 1000, 1)

    reasoning[-1].result_summary = (
        f"Dossier generated — {len(scouting_report)} chars, "
        f"{step_timing['report_generation']}ms"
    )

    players_out = [_player_to_dict(p) for p in final_players]

    # Build debug info for judges panel
    debug_info = None
    if body.debug_mode:
        def _stat_score_debug(p: PlayerResult) -> float:
            if p.position == "GK":
                keys = ["save_percent", "goals_prevented", "clean_sheets"]
            elif p.position == "DEF":
                keys = ["xg_chain", "xg_buildup", "key_passes", "minutes"]
            elif p.position == "MID":
                keys = ["xa", "key_passes", "xg_chain", "xg_buildup"]
            else:
                keys = ["xg", "xa", "key_passes", "xg_chain"]
            vals = [float(p.metrics_normalized.get(k) or 0) for k in keys]
            return round(sum(vals) / len(vals), 1)

        debug_info = DebugInfo(
            query_intent={
                "detected_position": intent.get("position") or "—",
                "applied_position": position or "—",
                "detected_max_age": intent.get("max_age") or "—",
                "applied_max_age": max_age or "—",
                "detected_league": intent.get("league_slug") or "—",
                "applied_league": league_slug or "—",
                "americas_league_flag": intent.get("americas_requested", False),
            },
            filters_applied={
                "position": position,
                "max_age": max_age,
                "league_tier_max": league_tier_max,
                "league_tier_min": league_tier_min,
                "league_slug": league_slug,
                "season": body.season,
                "db_pool": "~2,200 players (Big-5 + Mid-Europe, 2025-26)",
            },
            semantic_candidates=[
                {
                    "name": p.name,
                    "team": p.team,
                    "league": p.league,
                    "age": p.age,
                    "position": p.position,
                    "vector_score": round(p.vector_score or 0, 4),
                }
                for p in semantic_results
            ],
            quant_candidates_count=len(quant_results),
            final_ranking=[
                {
                    "name": p.name,
                    "team": p.team,
                    "vector_score": round(p.vector_score or 0, 4),
                    "stat_score": _stat_score_debug(p),
                    "combined_score": round(combined_score(p), 2),
                }
                for p in final_players
            ],
            timing_ms=step_timing,
            vector_index="player_embedding_index",
            embedding_model="voyage-3-large",
            llm_model=settings.gemini_model,
        )

    return ScoutResponse(
        query=body.query,
        reasoning_steps=reasoning,
        players=players_out,
        scouting_report=scouting_report,
        tool_calls=tool_calls,
        debug_info=debug_info,
    )


async def _generate_scouting_report(
    query: str,
    players: list[PlayerResult],
    world_cup_context: bool,
    data_note: str = "",
) -> str:
    if not players:
        return "No players found matching the scouting criteria."

    prompt = build_scouting_prompt(query, players, world_cup_context, data_note=data_note)

    try:
        if settings.google_cloud_project:
            return await _gemini_rest(settings.google_cloud_project, prompt)
        else:
            import google.generativeai as genai
            genai.configure(api_key=settings.gemini_api_key)
            model = genai.GenerativeModel(settings.gemini_model)
            response = model.generate_content(
                prompt,
                generation_config=genai.GenerationConfig(temperature=0.4, max_output_tokens=2048),
            )
            return response.text
    except Exception as exc:
        logger.error("Gemini generation failed: %s", exc)
        # Fallback: structured text report
        lines = [f"SCOUTING REPORT — {query}\n"]
        for i, p in enumerate(players, 1):
            norm = p.metrics_normalized
            lines.append(f"\n{'='*60}\nCANDIDATE {i}: {p.name}")
            lines.append(f"Age: {p.age} | Position: {p.position} | Nationality: {p.nationality}")
            lines.append(f"Club: {p.team} ({p.league})")
            for metric, label in [("xg", "xG"), ("xa", "xA"), ("key_passes", "Key passes")]:
                pct = norm.get(metric)
                if pct is not None:
                    lines.append(f"  {label}: {int(pct)}th percentile")
        return "\n".join(lines)


async def _gemini_rest(project: str, prompt: str) -> str:
    """
    Call Gemini 2.5 Flash via the Vertex AI REST API using Workload Identity.
    Bypasses the Python SDK's response.text issue with thinking traces.
    """
    import asyncio
    import google.auth
    import google.auth.transport.requests
    import httpx

    # Refresh credentials (sync call — runs in thread pool to avoid blocking event loop)
    def _get_token() -> str:
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds.refresh(google.auth.transport.requests.Request())
        return creds.token

    token = await asyncio.get_event_loop().run_in_executor(None, _get_token)

    url = (
        f"https://us-central1-aiplatform.googleapis.com/v1/projects/{project}"
        f"/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent"
    )
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.4, "maxOutputTokens": 2048},
    }

    async with httpx.AsyncClient(timeout=45) as client:
        resp = await client.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=body,
        )
        resp.raise_for_status()
        data = resp.json()

    # Extract the final response text, skipping any thinking-trace parts (thought=True)
    for candidate in data.get("candidates", []):
        parts = candidate.get("content", {}).get("parts", [])
        for part in reversed(parts):
            if not part.get("thought", False) and part.get("text"):
                return part["text"]

    raise ValueError(f"No text in Gemini response: {data}")


def _player_to_dict(p: PlayerResult) -> dict:
    trend = _compute_trend(
        _position_score(p.metrics_normalized, p.position),
        p.season,
        p.history,
        p.position,
        p.stats.get("minutes"),
    )
    return {
        "id": p.qid,
        "name": p.name,
        "age": p.age,
        "position": p.position,
        "nationality": p.nationality,
        "current_team": p.team,
        "league": p.league,
        "league_tier": p.league_tier,
        "season": p.season,
        "stats": p.stats,
        "metrics_normalized": p.metrics_normalized,
        "market_value_eur": p.market_value_eur,
        "vector_score": p.vector_score,
        "profile_text": p.profile_text,
        "trend": trend,
    }


# ---------------------------------------------------------------------------
# Individual Agent Builder tools
# These are the granular endpoints that Agent Builder's Gemini model calls
# directly — it decides when and how to use each one.
# ---------------------------------------------------------------------------

class SearchPlayersRequest(BaseModel):
    query: str = Field(min_length=3, max_length=500, description="Tactical description of the player profile")
    position: str | None = Field(None, description="FWD, MID, DEF or GK")
    max_age: int | None = Field(None, description="Maximum player age (inclusive)")
    min_age: int | None = Field(None, description="Minimum player age (inclusive)")
    league_tier_max: int | None = Field(None, description="1=Big-5 Europe, 2=Mid Europe, 3=Americas/Other")
    league_slug: str | None = Field(None, description="Specific league slug e.g. premier-league, la-liga")
    season: str = Field("2025-26", description="Season to search")
    limit: int = Field(10, le=20, description="Max players to return")


@app.post("/agent/tools/search_players")
async def tool_search_players(body: SearchPlayersRequest, request: Request):
    """
    **Tool: search_players**

    Searches the GemScout database of 2,200+ players using two complementary methods:

    1. **Semantic search** — Voyage AI embeds your query into a 1536-dim vector and
       runs MongoDB Atlas Vector Search (cosine similarity) to find players whose
       tactical profiles best match the description.

    2. **Quantitative filter** — applies hard constraints (position, age, league tier)
       and sorts by position-specific statistical percentile scores.

    Returns up to `limit` ranked players with full stats, percentile scores (0-100),
    market values, and a 3-season World Cup cycle trend.

    Call this first when the director gives you a player profile to find.
    """
    client_ip = request.client.host if request.client else "unknown"
    _check_rate_limit(client_ip)

    intent = _parse_query_intent(body.query)
    position = body.position or intent.get("position")
    max_age = body.max_age if body.max_age is not None else intent.get("max_age")
    min_age = body.min_age
    league_tier_max = body.league_tier_max if body.league_tier_max is not None else intent.get("league_tier_max")
    league_tier_min = intent.get("league_tier_min")
    league_slug = body.league_slug or intent.get("league_slug")

    _t = perf_counter()
    semantic_results = await semantic_player_search(
        query=body.query,
        position=position,
        max_age=max_age,
        min_age=min_age,
        league_tier_max=league_tier_max,
        league_tier_min=league_tier_min,
        league_slug=league_slug,
        season=body.season,
        limit=body.limit * 2,
    )
    quant_results = await filter_players(
        position=position,
        max_age=max_age,
        min_age=min_age,
        league_tier_max=league_tier_max,
        league_tier_min=league_tier_min,
        league_slug=league_slug,
        season=body.season,
        limit=15,
    )
    search_ms = round((perf_counter() - _t) * 1000, 1)

    seen = {p.qid for p in semantic_results}
    merged = list(semantic_results) + [p for p in quant_results if p.qid not in seen]

    def _combined(p: PlayerResult) -> float:
        norm = p.metrics_normalized
        keys = (
            ["save_percent", "goals_prevented", "clean_sheets"] if p.position == "GK"
            else ["xg_chain", "xg_buildup", "key_passes", "minutes"] if p.position == "DEF"
            else ["xa", "key_passes", "xg_chain", "xg_buildup"] if p.position == "MID"
            else ["xg", "xa", "key_passes", "xg_chain"]
        )
        stat_score = sum(norm.get(k) or 0 for k in keys) / len(keys)
        return (p.vector_score or 0) * 100 * 0.6 + stat_score * 0.4

    merged.sort(key=_combined, reverse=True)
    top = merged[: body.limit]

    return {
        "query": body.query,
        "filters_applied": {
            "position": position, "max_age": max_age, "min_age": min_age,
            "league_tier_max": league_tier_max, "league_slug": league_slug,
            "season": body.season,
        },
        "search_ms": search_ms,
        "total_candidates": len(merged),
        "players": [_player_to_dict(p) for p in top],
    }


@app.get("/agent/tools/player_profile/{qid}")
async def tool_player_profile(qid: str):
    """
    **Tool: player_profile**

    Returns the complete profile for a single player identified by their Wikidata QID.

    Use this after `search_players` when you want to investigate a specific candidate
    in more depth — full stat breakdown, 3-season World Cup cycle trajectory, market
    value context, and the raw tactical profile text used for semantic indexing.

    The `trend.values_by_season` field gives you the position-specific percentile score
    for each season so you can describe whether the player is peaking now or declining.
    """
    db = get_async_db()
    doc = await db[PLAYERS_COLLECTION].find_one({"_id": qid}, {"embedding": 0})
    if not doc:
        raise HTTPException(status_code=404, detail=f"Player {qid} not found")

    position = doc.get("position", "")
    norm = doc.get("metrics_normalized", {})
    history = doc.get("history", {})
    stats = doc.get("stats", {})
    season = doc.get("season", "2025-26")

    trend = _compute_trend(_position_score(norm, position), season, history, position, stats.get("minutes"))

    return {
        "qid": qid,
        "name": doc.get("name"),
        "age": doc.get("age"),
        "position": doc.get("position"),
        "nationality": doc.get("nationality"),
        "current_team": doc.get("current_team"),
        "league": doc.get("league"),
        "league_tier": doc.get("league_tier"),
        "season": season,
        "market_value_eur": doc.get("market_value_eur"),
        "stats": stats,
        "metrics_normalized": norm,
        "profile_text": doc.get("profile_text", ""),
        "trend": trend,
        "history_seasons_available": sorted(history.keys()),
    }


# ---------------------------------------------------------------------------
# Agent Builder tool manifest (Google Cloud Agent Builder reads this)
# ---------------------------------------------------------------------------

@app.get("/agent/tools")
async def agent_tools_manifest():
    """Returns the tool definitions for Google Cloud Agent Builder."""
    return {
        "tools": [
            {
                "name": "scout_players",
                "description": (
                    "Find football players matching a natural language scouting request. "
                    "Uses semantic search (MongoDB Atlas Vector Search + Voyage AI) combined "
                    "with statistical filtering. Returns ranked candidates with a Gemini-generated "
                    "scouting report for the top 3 players."
                ),
                "endpoint": "/agent/scout",
                "method": "POST",
                "parameters": {
                    "query": "Natural language description of the player profile you're looking for",
                    "position": "Optional: FWD, MID, DEF, or GK",
                    "max_age": "Optional: maximum player age",
                    "league_tier_max": "Optional: 1=Big5Europe, 2=MidEurope, 3=Americas/Other",
                    "world_cup_context": "Optional: include World Cup 2026 readiness assessment",
                },
            }
        ]
    }
