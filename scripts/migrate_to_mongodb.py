"""
migrate_to_mongodb.py

Migrates player data from OpenMercat's PostgreSQL to MongoDB Atlas.

Usage:
    python scripts/migrate_to_mongodb.py --season 2025-26

Reads from POSTGRES_DSN and writes to MONGODB_URI / MONGODB_DB in .env
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend" / "src"))

import typer
from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne

load_dotenv(Path(__file__).parent.parent / ".env")

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("migrate")

app = typer.Typer()

# League tier mapping (slug → tier)
LEAGUE_TIERS: dict[str, int] = {
    "premier-league": 1, "la-liga": 1, "bundesliga": 1,
    "serie-a": 1, "ligue-1": 1,
    "eredivisie": 2, "primeira-liga": 2, "scottish-premiership": 2,
    "pro-league": 2, "super-lig": 2,
    "brasileiro-serie-a": 3, "liga-mx": 3, "mls": 3,
    "primera-division-arg": 3, "primera-division-col": 3,
    "primera-division-chi": 3, "primera-division-per": 3,
    "primera-division-uru": 3, "primera-division-ecu": 3,
}


@app.command()
def migrate(
    season: str = typer.Option("2025-26", help="Season to migrate"),
    dry_run: bool = typer.Option(False, help="Print stats without writing to MongoDB"),
    batch_size: int = typer.Option(500, help="Number of docs per bulk write"),
):
    import psycopg
    from psycopg.rows import dict_row

    postgres_dsn = os.environ.get("POSTGRES_DSN")
    mongodb_uri = os.environ.get("MONGODB_URI", "mongodb://localhost:27017")
    mongodb_db = os.environ.get("MONGODB_DB", "gemscout")

    if not postgres_dsn:
        typer.echo("ERROR: POSTGRES_DSN not set in .env", err=True)
        raise typer.Exit(1)

    logger.info("Connecting to PostgreSQL...")
    pg_conn = psycopg.connect(postgres_dsn, row_factory=dict_row)

    if not dry_run:
        logger.info("Connecting to MongoDB Atlas...")
        mongo_client = MongoClient(mongodb_uri)
        db = mongo_client[mongodb_db]
        collection = db["players"]
        collection.create_index("season")
        collection.create_index("position")
        collection.create_index("age")
        collection.create_index("league_slug")

    rows = pg_conn.execute(
        """
        SELECT
          p.qid_wikidata                          AS qid,
          p.name,
          EXTRACT(YEAR FROM AGE(p.birth_date))::int AS age,
          p.birth_date,
          p.position,
          p.nationality,
          t.name                                  AS current_team,
          l.name                                  AS league,
          l.slug                                  AS league_slug,
          ps.season,
          ps.xg,
          ps.xa,
          ps.minutes,
          ps.goals,
          ps.assists,
          ps.metrics,
          ps.metrics_normalized,
          pv.value_eur                            AS market_value_eur,
          p.id_transfermarkt,
          p.id_understat,
          p.id_sofascore
        FROM players p
        JOIN player_stats ps ON ps.player_id = p.id
        LEFT JOIN teams t    ON t.id = p.current_team_id
        LEFT JOIN leagues l  ON l.id = t.current_league_id
        LEFT JOIN LATERAL (
          SELECT value_eur FROM player_valuations
          WHERE player_id = p.id
          ORDER BY snapshot_date DESC
          LIMIT 1
        ) pv ON TRUE
        WHERE ps.season = %s
          AND p.qid_wikidata IS NOT NULL
        ORDER BY p.qid_wikidata
        """,
        (season,),
    ).fetchall()

    logger.info("Fetched %d player-season rows from PostgreSQL", len(rows))

    operations = []
    skipped = 0

    for row in rows:
        qid = row["qid"]
        if not qid:
            skipped += 1
            continue

        # Merge flat metrics + JSONB metrics dict
        stats = {
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

        league_slug = row.get("league_slug") or ""
        league_tier = LEAGUE_TIERS.get(league_slug, 3)

        doc = {
            "_id": qid,
            "name": row["name"],
            "age": row["age"],
            "birth_date": row["birth_date"].isoformat() if row["birth_date"] else None,
            "position": row["position"],
            "nationality": row["nationality"],
            "current_team": row["current_team"] or "Unknown",
            "league": row["league"] or "Unknown",
            "league_slug": league_slug,
            "league_tier": league_tier,
            "season": row["season"],
            "stats": stats,
            "metrics_normalized": dict(row["metrics_normalized"]) if row["metrics_normalized"] else {},
            "market_value_eur": int(row["market_value_eur"]) if row["market_value_eur"] else None,
            "transfermarkt_id": row["id_transfermarkt"],
            "understat_id": row["id_understat"],
            "sofascore_id": row["id_sofascore"],
            # embedding field will be populated by generate_embeddings.py
            "embedding": None,
            "profile_text": "",
        }

        operations.append(
            UpdateOne({"_id": qid}, {"$set": doc}, upsert=True)
        )

        if len(operations) >= batch_size:
            if not dry_run:
                result = collection.bulk_write(operations)
                logger.info("Batch: upserted=%d modified=%d", result.upserted_count, result.modified_count)
            else:
                logger.info("[dry-run] Would write %d docs", len(operations))
            operations = []

    if operations:
        if not dry_run:
            result = collection.bulk_write(operations)
            logger.info("Final batch: upserted=%d modified=%d", result.upserted_count, result.modified_count)
        else:
            logger.info("[dry-run] Would write %d docs", len(operations))

    logger.info("Migration complete. Skipped %d rows without QID.", skipped)
    logger.info("Next step: python scripts/generate_embeddings.py --season %s", season)


if __name__ == "__main__":
    app()
