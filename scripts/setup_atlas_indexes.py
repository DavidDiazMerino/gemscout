"""
setup_atlas_indexes.py

Creates the MongoDB Atlas Vector Search index and Atlas Search index
required for GemScout's semantic player search.

Run AFTER generate_embeddings.py has populated the embedding field.

Usage:
    python scripts/setup_atlas_indexes.py

Requires MONGODB_URI pointing to an Atlas cluster (not local MongoDB)
and the Atlas admin API or that indexes are created via Atlas UI / CLI.

NOTE: Atlas Vector Search indexes CANNOT be created via pymongo — they
must be created through the Atlas UI, Atlas CLI, or Atlas Admin API.
This script generates the index definitions and optionally calls the
Atlas Admin API if MONGODB_ATLAS_PUBLIC_KEY and MONGODB_ATLAS_PRIVATE_KEY
are configured.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend" / "src"))

import typer
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from gemscout.embeddings.voyage import EMBEDDING_DIM
from gemscout.settings import settings

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("indexes")

app = typer.Typer()

VECTOR_INDEX_DEFINITION = {
    "name": "player_embedding_index",
    "type": "vectorSearch",
    "definition": {
        "fields": [
            {
                "type": "vector",
                "path": "embedding",
                "numDimensions": EMBEDDING_DIM,
                "similarity": "cosine",
            },
            # Pre-filter fields for efficient ANN search
            {"type": "filter", "path": "season"},
            {"type": "filter", "path": "position"},
            {"type": "filter", "path": "age"},
            {"type": "filter", "path": "league_tier"},
        ]
    },
}

TEXT_INDEX_DEFINITION = {
    "name": "player_text_index",
    "type": "search",
    "definition": {
        "mappings": {
            "dynamic": False,
            "fields": {
                "name": {"type": "string", "analyzer": "lucene.standard"},
                "nationality": {"type": "string"},
                "current_team": {"type": "string"},
                "league": {"type": "string"},
                "profile_text": {"type": "string", "analyzer": "lucene.standard"},
                "position": {"type": "string"},
                "season": {"type": "string"},
                "age": {"type": "number"},
                "league_tier": {"type": "number"},
            }
        }
    },
}


@app.command()
def create(
    print_only: bool = typer.Option(True, help="Print index definitions instead of calling Atlas API"),
    project_id: str = typer.Option("", help="MongoDB Atlas project ID (for API creation)"),
    cluster_name: str = typer.Option("", help="Atlas cluster name"),
):
    logger.info("Atlas Vector Search index definition:")
    print(json.dumps(VECTOR_INDEX_DEFINITION, indent=2))

    logger.info("\nAtlas Search (text) index definition:")
    print(json.dumps(TEXT_INDEX_DEFINITION, indent=2))

    if print_only:
        print("""
╔══════════════════════════════════════════════════════════════╗
║  To create these indexes in Atlas UI:                       ║
║  1. Go to your Atlas cluster → Search → Create Index        ║
║  2. Choose JSON editor and paste the definition above       ║
║  3. Set database: gemscout, collection: players              ║
╚══════════════════════════════════════════════════════════════╝
""")
        return

    public_key = os.environ.get("MONGODB_ATLAS_PUBLIC_KEY", "")
    private_key = os.environ.get("MONGODB_ATLAS_PRIVATE_KEY", "")
    if not (public_key and private_key and project_id and cluster_name):
        logger.error(
            "Set MONGODB_ATLAS_PUBLIC_KEY, MONGODB_ATLAS_PRIVATE_KEY, "
            "--project-id, and --cluster-name to create via API"
        )
        raise typer.Exit(1)

    import requests
    from requests.auth import HTTPDigestAuth

    base = f"https://cloud.mongodb.com/api/atlas/v2/groups/{project_id}/clusters/{cluster_name}/search/indexes"
    auth = HTTPDigestAuth(public_key, private_key)
    headers = {"Content-Type": "application/json", "Accept": "application/vnd.atlas.2024-05-30+json"}

    for definition in [VECTOR_INDEX_DEFINITION, TEXT_INDEX_DEFINITION]:
        payload = {
            "collectionName": "players",
            "database": settings.mongodb_db,
            **definition,
        }
        resp = requests.post(base, json=payload, auth=auth, headers=headers)
        if resp.ok:
            logger.info("Created index: %s", definition["name"])
        else:
            logger.error("Failed to create %s: %s", definition["name"], resp.text)


if __name__ == "__main__":
    app()
