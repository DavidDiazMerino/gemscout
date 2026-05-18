"""
generate_embeddings.py

Generates Voyage AI embeddings for all player documents in MongoDB
and stores them in the 'embedding' field.

Usage:
    python scripts/generate_embeddings.py --season 2025-26

Requires VOYAGE_API_KEY and MONGODB_URI in .env
"""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend" / "src"))

import typer
from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne

load_dotenv(Path(__file__).parent.parent / ".env")

from gemscout.embeddings.voyage import EMBEDDING_DIM, VOYAGE_MODEL, build_profile_text, embed_documents
from gemscout.settings import settings

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("embed")

app = typer.Typer()

# Voyage AI rate limits — stay well within them
BATCH_SIZE = 128
SLEEP_BETWEEN_BATCHES = 0.5  # seconds


@app.command()
def generate(
    season: str = typer.Option("2025-26", help="Season to generate embeddings for"),
    force: bool = typer.Option(False, help="Regenerate even if embedding already exists"),
    dry_run: bool = typer.Option(False, help="Just build profile texts, don't call Voyage AI"),
):
    mongo_client = MongoClient(settings.mongodb_uri)
    db = mongo_client[settings.mongodb_db]
    collection = db["players"]

    query: dict = {"season": season}
    if not force:
        query["$or"] = [{"embedding": None}, {"embedding": {"$exists": False}}]

    total = collection.count_documents(query)
    logger.info("Found %d players needing embeddings (season=%s, force=%s)", total, season, force)

    if total == 0:
        logger.info("Nothing to do.")
        return

    processed = 0
    errors = 0
    batch_docs: list[dict] = []

    cursor = collection.find(query)

    for doc in cursor:
        # Build rich profile text first
        profile_text = build_profile_text(doc)
        doc["_profile_text"] = profile_text  # temp key for batching
        batch_docs.append(doc)

        if len(batch_docs) >= BATCH_SIZE:
            errors += _process_batch(collection, batch_docs, dry_run)
            processed += len(batch_docs)
            batch_docs = []
            logger.info("Progress: %d/%d processed (%d errors)", processed, total, errors)
            time.sleep(SLEEP_BETWEEN_BATCHES)

    if batch_docs:
        errors += _process_batch(collection, batch_docs, dry_run)
        processed += len(batch_docs)

    logger.info("Done. Processed: %d | Errors: %d", processed, errors)
    logger.info("Next step: python scripts/setup_atlas_indexes.py")


def _process_batch(collection, batch_docs: list[dict], dry_run: bool) -> int:
    texts = [d["_profile_text"] for d in batch_docs]

    if dry_run:
        for doc in batch_docs:
            logger.info("[dry-run] %s → %d chars profile", doc.get("name"), len(doc["_profile_text"]))
        return 0

    try:
        embeddings = embed_documents(texts)
    except Exception as exc:
        logger.error("Embedding batch failed: %s", exc)
        return len(batch_docs)

    operations = []
    for doc, embedding, profile_text in zip(batch_docs, embeddings, texts):
        if len(embedding) != EMBEDDING_DIM:
            logger.warning("Unexpected embedding dim %d for %s", len(embedding), doc.get("name"))
        operations.append(
            UpdateOne(
                {"_id": doc["_id"]},
                {"$set": {"embedding": embedding, "profile_text": profile_text}},
            )
        )

    if operations:
        result = collection.bulk_write(operations)
        logger.debug("Batch: modified=%d", result.modified_count)

    return 0


if __name__ == "__main__":
    app()
