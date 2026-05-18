from __future__ import annotations

import voyageai

from gemscout.settings import settings

_client: voyageai.Client | None = None

# voyage-3-large gives 1024-dim vectors — best accuracy for semantic player search
VOYAGE_MODEL = "voyage-3-large"
EMBEDDING_DIM = 1024


def get_client() -> voyageai.Client:
    global _client
    if _client is None:
        _client = voyageai.Client(api_key=settings.voyage_api_key)
    return _client


def embed_query(query: str) -> list[float]:
    """Embed a natural language scouting query (query input_type for retrieval)."""
    result = get_client().embed([query], model=VOYAGE_MODEL, input_type="query")
    return result.embeddings[0]


def embed_documents(texts: list[str]) -> list[list[float]]:
    """Embed a batch of player profile texts (document input_type)."""
    result = get_client().embed(texts, model=VOYAGE_MODEL, input_type="document")
    return result.embeddings


def build_profile_text(player: dict) -> str:
    """
    Build a rich natural language profile for a player.
    This text is embedded and stored in MongoDB — it's what makes
    semantic search work. It must capture tactical qualities, not just raw numbers.
    """
    name = player.get("name", "Unknown")
    age = player.get("age", "?")
    position = player.get("position", "?")
    nationality = player.get("nationality", "")
    team = player.get("current_team", "")
    league = player.get("league", "")
    season = player.get("season", "2025-26")

    norm = player.get("metrics_normalized", {})
    stats = player.get("stats", {})

    # Tactical quality descriptors based on percentile thresholds
    qualities: list[str] = []

    xg_pct = norm.get("xg")
    if xg_pct is not None:
        if xg_pct >= 90:
            qualities.append("elite finishing (top 10% xG)")
        elif xg_pct >= 75:
            qualities.append("strong finisher (top 25% xG)")

    xa_pct = norm.get("xa")
    if xa_pct is not None:
        if xa_pct >= 90:
            qualities.append("elite chance creator (top 10% xA)")
        elif xa_pct >= 75:
            qualities.append("creative playmaker (top 25% xA)")

    kp_pct = norm.get("key_passes")
    if kp_pct is not None:
        if kp_pct >= 90:
            qualities.append("elite key passer (top 10%)")
        elif kp_pct >= 75:
            qualities.append("strong key passer")

    xgc_pct = norm.get("xg_chain")
    if xgc_pct is not None:
        if xgc_pct >= 85:
            qualities.append("high pressing intensity and involvement in build-up")
        elif xgc_pct >= 70:
            qualities.append("active in pressing and transitions")

    xgb_pct = norm.get("xg_buildup")
    if xgb_pct is not None:
        if xgb_pct >= 85:
            qualities.append("progressive ball carrier")
        elif xgb_pct >= 70:
            qualities.append("contributes to build-up play")

    goals = stats.get("goals", 0) or 0
    assists = stats.get("assists", 0) or 0
    minutes = stats.get("minutes", 0) or 0

    position_desc = {
        "FWD": "forward",
        "MID": "midfielder",
        "DEF": "defender",
        "GK": "goalkeeper",
    }.get(position, position)

    # Determine league tier for World Cup narrative
    league_tier = player.get("league_tier", 3)
    if league_tier == 1:
        league_context = f"in a top-5 European league ({league})"
    elif league_tier == 2:
        league_context = f"in a mid-tier European league ({league})"
    else:
        league_context = f"in a non-European league ({league}) — a potential hidden gem"

    qualities_text = (
        ", ".join(qualities) if qualities else "solid technical profile"
    )

    profile = (
        f"{name} is a {age}-year-old {position_desc} from {nationality}, "
        f"playing for {team} {league_context} in the {season} season. "
        f"In {minutes} minutes played, they contributed {goals} goals and {assists} assists. "
        f"Key tactical qualities: {qualities_text}. "
    )

    # Add percentile summary for top metrics
    top_percentiles = []
    for metric, label in [
        ("xg", "xG"),
        ("xa", "xA"),
        ("key_passes", "key passes"),
        ("xg_chain", "pressing/xG chain"),
        ("xg_buildup", "progressive play"),
    ]:
        pct = norm.get(metric)
        if pct is not None and pct >= 60:
            top_percentiles.append(f"{int(pct)}th percentile {label}")

    if top_percentiles:
        profile += f"Percentile rankings among {position_desc}s: {', '.join(top_percentiles)}."

    return profile
