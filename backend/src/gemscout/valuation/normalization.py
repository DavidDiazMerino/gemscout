"""
Percentile normalization — adapted from openmercat, now operating on MongoDB documents.
Groups players by position and computes percentile ranks for each metric.
"""

from __future__ import annotations

from collections import defaultdict

NORMALIZED_METRICS = (
    "xg", "xa", "xg_chain", "xg_buildup",
    "minutes", "goals", "assists", "shots", "key_passes", "npg", "npxg",
)

SOFASCORE_GK_METRICS = (
    "save_percent", "goals_prevented", "clean_sheets",
    "minutes", "rating", "saves", "goals_conceded",
)


def percentile_rank(value: float | None, sorted_values: list[float]) -> float | None:
    if value is None or not sorted_values:
        return None
    if len(sorted_values) == 1:
        return 100.0
    lower_or_equal = sum(1 for v in sorted_values if v <= value)
    return round(((lower_or_equal - 1) / (len(sorted_values) - 1)) * 100, 4)


def normalize_player_batch(players: list[dict]) -> list[dict]:
    """
    Given a list of player dicts (each with a 'stats' and 'position' key),
    compute percentile_normalized for each metric within position groups.
    Returns the same list with 'metrics_normalized' populated in-place.
    """
    # Group by position
    by_position: dict[str, list[dict]] = defaultdict(list)
    for p in players:
        pos = p.get("position")
        if pos:
            by_position[pos].append(p)

    metrics_for_pos = (
        SOFASCORE_GK_METRICS
        if True  # we'll branch per position below
        else NORMALIZED_METRICS
    )

    for position, group in by_position.items():
        metrics = SOFASCORE_GK_METRICS if position == "GK" else NORMALIZED_METRICS

        values_by_metric: dict[str, list[float]] = defaultdict(list)
        for p in group:
            stats = p.get("stats", {})
            for metric in metrics:
                val = stats.get(metric)
                if val is not None:
                    try:
                        values_by_metric[metric].append(float(val))
                    except (TypeError, ValueError):
                        pass

        for values in values_by_metric.values():
            values.sort()

        for p in group:
            stats = p.get("stats", {})
            norm: dict[str, float | None] = {"position": position}
            for metric in metrics:
                val = stats.get(metric)
                try:
                    fval = float(val) if val is not None else None
                except (TypeError, ValueError):
                    fval = None
                norm[metric] = percentile_rank(fval, values_by_metric[metric])
            p["metrics_normalized"] = norm

    return players
