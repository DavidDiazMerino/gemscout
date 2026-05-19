"""
migrate_history.py

Migrates historical seasons (2024-25, 2023-24) from OpenMercat PostgreSQL
into the `history.{season}` field of existing MongoDB player documents.

Does NOT overwrite the current-season document — only adds history subdocs
for players that already exist in MongoDB (matched by QID).

Usage:
    python scripts/migrate_history.py
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend" / "src"))

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

import psycopg
from psycopg.rows import dict_row
from pymongo import MongoClient, UpdateOne

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("migrate_history")

POSTGRES_DSN = os.environ["POSTGRES_DSN"]
MONGODB_URI = os.environ.get("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DB = os.environ.get("MONGODB_DB", "gemscout")

SEASONS_TO_MIGRATE = ["2024-25", "2023-24"]

QUERY = """
SELECT
  p.qid_wikidata                          AS qid,
  ps.season,
  ps.xg,
  ps.xa,
  ps.minutes,
  ps.goals,
  ps.assists,
  ps.metrics,
  ps.metrics_normalized
FROM players p
JOIN player_stats ps ON ps.player_id = p.id
WHERE ps.season = %s
  AND p.qid_wikidata IS NOT NULL
ORDER BY p.qid_wikidata, ps.fetched_at DESC
"""


def main() -> None:
    client = MongoClient(MONGODB_URI)
    collection = client[MONGODB_DB]["players"]

    # Only update players that already exist (current-season docs)
    existing_qids: set[str] = set(
        str(doc["_id"]) for doc in collection.find({}, {"_id": 1})
    )
    logger.info("%d players already in MongoDB", len(existing_qids))

    with psycopg.connect(POSTGRES_DSN, row_factory=dict_row) as conn:
        for season in SEASONS_TO_MIGRATE:
            logger.info("Migrating history for season %s ...", season)
            rows = conn.execute(QUERY, (season,)).fetchall()
            logger.info("  %d rows from PostgreSQL", len(rows))

            seen: set[str] = set()
            ops: list[UpdateOne] = []
            skipped = 0

            for row in rows:
                qid = row["qid"]
                if not qid or qid in seen:
                    continue
                seen.add(qid)

                if qid not in existing_qids:
                    skipped += 1
                    continue  # only enrich players we already know

                stats: dict = {
                    "xg": float(row["xg"]) if row["xg"] is not None else None,
                    "xa": float(row["xa"]) if row["xa"] is not None else None,
                    "goals": row["goals"],
                    "assists": row["assists"],
                    "minutes": row["minutes"],
                }
                if row["metrics"]:
                    for k, v in row["metrics"].items():
                        if v is not None:
                            try:
                                stats[k] = float(v)
                            except (TypeError, ValueError):
                                stats[k] = v

                norm = dict(row["metrics_normalized"]) if row["metrics_normalized"] else {}

                ops.append(
                    UpdateOne(
                        {"_id": qid},
                        {"$set": {
                            f"history.{season}": {
                                "stats": stats,
                                "metrics_normalized": norm,
                            }
                        }},
                    )
                )

                if len(ops) >= 500:
                    result = collection.bulk_write(ops)
                    logger.info(
                        "  Batch: matched=%d modified=%d",
                        result.matched_count, result.modified_count,
                    )
                    ops = []

            if ops:
                result = collection.bulk_write(ops)
                logger.info(
                    "  Final batch: matched=%d modified=%d",
                    result.matched_count, result.modified_count,
                )

            logger.info("  Season %s done (skipped %d not in MongoDB)", season, skipped)

    logger.info("History migration complete.")


if __name__ == "__main__":
    main()
