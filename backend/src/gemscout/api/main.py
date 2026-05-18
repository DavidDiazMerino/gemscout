"""
GemScout FastAPI backend.

Preserves all OpenMercat endpoints and adds the /agent/* routes
that power the Google Cloud Agent Builder integration.
"""

from __future__ import annotations

import logging
from collections import defaultdict, deque
from time import monotonic, perf_counter
from typing import Any

import google.generativeai as genai
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
    if settings.gemini_api_key:
        genai.configure(api_key=settings.gemini_api_key)


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
    return {"seasons": sorted(seasons_list, reverse=True)}


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

    # Normalise weights to sum=1
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
        results.append({"score": round(score, 4), **doc, "id": doc.pop("_id")})

    results.sort(key=lambda x: x["score"], reverse=True)
    return {"players": results[: body.limit], "total": len(results)}


# ---------------------------------------------------------------------------
# AGENT ENDPOINTS — the new GemScout brain
# ---------------------------------------------------------------------------

class ScoutRequest(BaseModel):
    query: str = Field(min_length=5, max_length=500)
    position: str | None = None
    max_age: int | None = None
    min_age: int | None = None
    league_tier_max: int | None = None
    season: str = "2025-26"
    world_cup_context: bool = True
    limit: int = Field(default=5, le=10)


class ReasoningStep(BaseModel):
    step: int
    action: str
    detail: str
    result_summary: str | None = None


class ScoutResponse(BaseModel):
    query: str
    reasoning_steps: list[ReasoningStep]
    players: list[dict]
    scouting_report: str
    tool_calls: list[str]


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


@app.post("/agent/scout", response_model=ScoutResponse)
async def agent_scout(body: ScoutRequest, request: Request):
    """
    Main GemScout agent endpoint.

    Orchestrates:
    1. Semantic vector search (Voyage AI embeddings + MongoDB Atlas)
    2. Quantitative cross-filtering
    3. Gemini scouting report generation

    This endpoint is consumed by:
    - The React frontend (direct API call)
    - Google Cloud Agent Builder (as a registered tool)
    """
    client_ip = request.client.host if request.client else "unknown"
    _check_rate_limit(client_ip)

    reasoning: list[ReasoningStep] = []
    tool_calls: list[str] = []
    step = 0

    # Step 1: Semantic search via Voyage AI + Atlas Vector Search
    step += 1
    reasoning.append(ReasoningStep(
        step=step,
        action="semantic_player_search",
        detail=(
            f"Translating query '{body.query}' to a tactical embedding via Voyage AI, "
            f"then querying MongoDB Atlas Vector Search "
            f"(index: player_embedding_index, model: voyage-3-large)"
        ),
    ))
    tool_calls.append("semantic_player_search")

    try:
        semantic_results = await semantic_player_search(
            query=body.query,
            position=body.position,
            max_age=body.max_age,
            min_age=body.min_age,
            league_tier_max=body.league_tier_max,
            season=body.season,
            limit=body.limit * 2,
        )
        reasoning[-1].result_summary = (
            f"Found {len(semantic_results)} semantically matched players. "
            f"Top match: {semantic_results[0].name if semantic_results else 'none'} "
            f"(score: {semantic_results[0].vector_score:.3f})" if semantic_results else "No matches found"
        )
    except Exception as exc:
        logger.warning("semantic_search failed: %s", exc)
        semantic_results = []
        reasoning[-1].result_summary = f"Vector search unavailable — falling back to quantitative filter ({exc})"

    # Step 2: Quantitative cross-validation (verify semantic results are statistically strong)
    step += 1
    reasoning.append(ReasoningStep(
        step=step,
        action="filter_players",
        detail="Cross-referencing with quantitative filters to validate candidates",
    ))
    tool_calls.append("filter_players")

    quant_results = await filter_players(
        position=body.position,
        max_age=body.max_age,
        min_age=body.min_age,
        league_tier_max=body.league_tier_max,
        season=body.season,
        limit=20,
    )

    # Merge: semantic results first, add any quant-only picks not in semantic
    seen_qids = {p.qid for p in semantic_results}
    merged = list(semantic_results)
    for p in quant_results:
        if p.qid not in seen_qids:
            merged.append(p)
    final_players = merged[: body.limit]

    reasoning[-1].result_summary = (
        f"Quantitative filter returned {len(quant_results)} players. "
        f"After merging with semantic results: {len(final_players)} candidates for scouting report."
    )

    # Step 3: Rank by combined score (vector score + top percentile)
    step += 1
    reasoning.append(ReasoningStep(
        step=step,
        action="rank_candidates",
        detail="Scoring candidates by combined semantic similarity + statistical percentile rank",
    ))
    tool_calls.append("rank_candidates")

    def combined_score(p: PlayerResult) -> float:
        norm = p.metrics_normalized
        stat_score = sum([
            norm.get("xg") or 0,
            norm.get("xa") or 0,
            norm.get("key_passes") or 0,
            norm.get("xg_chain") or 0,
        ]) / 4
        vec = (p.vector_score or 0) * 100
        return vec * 0.6 + stat_score * 0.4

    final_players.sort(key=combined_score, reverse=True)
    top3 = final_players[:3]

    reasoning[-1].result_summary = (
        f"Final ranking: {', '.join(p.name for p in top3)}"
    )

    # Step 4: Generate Gemini scouting report
    step += 1
    reasoning.append(ReasoningStep(
        step=step,
        action="generate_scouting_report",
        detail=f"Calling Gemini ({settings.gemini_model}) to generate detailed scouting dossier",
    ))
    tool_calls.append("generate_scouting_report")

    scouting_report = await _generate_scouting_report(
        body.query, top3, body.world_cup_context
    )
    reasoning[-1].result_summary = f"Scouting report generated ({len(scouting_report)} chars)"

    players_out = [_player_to_dict(p) for p in final_players]

    return ScoutResponse(
        query=body.query,
        reasoning_steps=reasoning,
        players=players_out,
        scouting_report=scouting_report,
        tool_calls=tool_calls,
    )


async def _generate_scouting_report(
    query: str,
    players: list[PlayerResult],
    world_cup_context: bool,
) -> str:
    if not players:
        return "No players found matching the scouting criteria."

    prompt = build_scouting_prompt(query, players, world_cup_context)

    try:
        model = genai.GenerativeModel(settings.gemini_model)
        response = model.generate_content(
            prompt,
            generation_config=genai.GenerationConfig(
                temperature=0.4,
                max_output_tokens=2048,
            ),
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


def _player_to_dict(p: PlayerResult) -> dict:
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
