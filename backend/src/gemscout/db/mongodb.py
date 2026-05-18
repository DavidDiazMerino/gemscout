from __future__ import annotations

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from pymongo import MongoClient

from gemscout.settings import settings

_async_client: AsyncIOMotorClient | None = None
_sync_client: MongoClient | None = None


def get_async_db() -> AsyncIOMotorDatabase:
    global _async_client
    if _async_client is None:
        _async_client = AsyncIOMotorClient(settings.mongodb_uri)
    return _async_client[settings.mongodb_db]


def get_sync_db():
    global _sync_client
    if _sync_client is None:
        _sync_client = MongoClient(settings.mongodb_uri)
    return _sync_client[settings.mongodb_db]


async def close_connections() -> None:
    global _async_client
    if _async_client is not None:
        _async_client.close()
        _async_client = None


# Collection names
PLAYERS_COLLECTION = "players"
TEMPLATES_COLLECTION = "templates"

# MongoDB Atlas Vector Search index name
VECTOR_INDEX_NAME = "player_embedding_index"
# Atlas Search index name (text)
SEARCH_INDEX_NAME = "player_text_index"
