# GemScout — AI Football Scouting Agent

> **Google Cloud Rapid Agent Hackathon 2026** · MongoDB Track

**Find the hidden gems before anyone else.**

GemScout is a World Cup 2026 scouting agent that helps national team directors discover underrated players in non-European leagues using semantic search, tactical AI, and real statistical data.

[![License: MIT](https://img.shields.io/badge/License-MIT-lime.svg)](LICENSE)
[![Built with Gemini](https://img.shields.io/badge/Built%20with-Gemini%202.0%20Flash-blue)](https://cloud.google.com/vertex-ai)
[![MongoDB Atlas](https://img.shields.io/badge/Data-MongoDB%20Atlas-green)](https://www.mongodb.com/atlas)

---

## The Problem

A national team director preparing for the 2026 World Cup needs to scout uncapped or underrated players from non-top-5-league nations. Traditional scouting takes months. 2,200+ players, dozens of metrics — how do you find the 24-year-old pressing forward from Liga MX who plays like Bellingham but nobody's heard of yet?

## The Solution

GemScout translates natural language scouting requests into:
1. **Voyage AI embeddings** → **MongoDB Atlas Vector Search** (semantic tactical match)
2. **Statistical cross-filtering** (age, league, position, percentile thresholds)
3. **Gemini 2.0 Flash** generates a full scouting dossier per player

All orchestrated by **Google Cloud Agent Builder**.

---

## Architecture

```
User (natural language query)
        │
        ▼
Google Cloud Agent Builder (Gemini 2.0 Flash)
        │ calls tool
        ▼
FastAPI Backend (Cloud Run)
        │
        ├─► Voyage AI: embed query → 1024-dim vector
        │
        ├─► MongoDB Atlas Vector Search
        │   (player_embedding_index, cosine similarity)
        │   Pre-filters: season, position, age, league_tier
        │
        ├─► MongoDB MCP Server
        │   (direct agent ↔ Atlas communication)
        │
        └─► Gemini 2.0 Flash: generate scouting report
                │
                ▼
        Scouting Report + Reasoning Steps → React UI
```

---

## Partner Technology: MongoDB

| Component | Usage |
|-----------|-------|
| **MongoDB Atlas** | Primary data store — 2,200+ player documents with stats, percentile scores |
| **Atlas Vector Search** | Semantic similarity search on Voyage AI embeddings (1024-dim, cosine) |
| **Atlas Search** | Full-text player name and team search |
| **MongoDB MCP Server** | Gives the Google Cloud Agent direct database access via Model Context Protocol |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Agent Orchestration | Google Cloud Agent Builder |
| LLM | Gemini 2.0 Flash (`gemini-2.0-flash-001`) |
| Embeddings | Voyage AI (`voyage-3-large`, 1024-dim) |
| Database | MongoDB Atlas (migrated from PostgreSQL) |
| Vector Search | MongoDB Atlas Vector Search |
| Backend | FastAPI (Python 3.12) |
| Frontend | React 19 + TypeScript + Tailwind CSS |
| Deployment | Cloud Run (backend) + Firebase Hosting (frontend) |

---

## Data

- **2,200+ players** across Big-5 Europe, Brasileirão, Liga MX, MLS, and 15+ leagues
- **Stats**: xG, xA, goals, assists, key passes, xG chain, xG buildup, minutes, shots + goalkeeper metrics
- **Percentile normalization** within position groups (FWD/MID/DEF/GK)
- **Voyage AI embeddings** of rich tactical player profiles
- **Wikidata QID** as canonical player identity anchor

---

## Setup

### Prerequisites

- Python 3.12+
- Node 22+
- MongoDB Atlas account (M10+ cluster for Vector Search)
- Voyage AI API key ([voyageai.com](https://voyageai.com))
- Google Cloud project with Vertex AI enabled
- Gemini API key

### 1. Clone & configure

```bash
git clone https://github.com/DavidDiazMerino/Gemscout
cd Gemscout
cp .env.example .env
# Edit .env with your API keys
```

### 2. Migrate data to MongoDB

```bash
cd backend
pip install -e ".[migration]"
# From your existing OpenMercat PostgreSQL:
python ../scripts/migrate_to_mongodb.py --season 2025-26
```

### 3. Generate embeddings

```bash
python ../scripts/generate_embeddings.py --season 2025-26
```

### 4. Create Atlas indexes

```bash
python ../scripts/setup_atlas_indexes.py --print-only
# Copy the JSON definition and create the index in Atlas UI
```

### 5. Run locally

```bash
# Backend
cd backend && pip install -e . && uvicorn gemscout.api.main:app --reload --port 8080

# Frontend (separate terminal)
cd frontend && npm install && npm run dev
```

Open http://localhost:5173

### 6. Deploy to Cloud Run

```bash
gcloud run deploy gemscout-backend \
  --source ./backend \
  --region us-central1 \
  --set-env-vars="MONGODB_URI=...,VOYAGE_API_KEY=...,GEMINI_API_KEY=..."
```

---

## Google Cloud Agent Builder Setup

1. Go to [Vertex AI Agent Builder](https://cloud.google.com/agent-builder) in GCP Console
2. Create new agent → paste content from `agent/agent_config.yaml`
3. Add OpenAPI tool pointing to your Cloud Run URL
4. Test with: *"Find me a box-to-box midfielder, under 24, from Americas leagues, World Cup potential"*

---

## MongoDB MCP Server

Configure in Claude Desktop or any MCP-compatible client:

```json
{
  "mcpServers": {
    "mongodb": {
      "command": "npx",
      "args": ["-y", "@mongodb-js/mongodb-mcp-server@latest"],
      "env": {
        "MDB_MCP_CONNECTION_STRING": "your-atlas-uri"
      }
    }
  }
}
```

---

## Demo

[▶ Watch 3-minute demo](demo/gemscout-demo.mp4)

**Live demo:** https://gemscout.run.app

### Example queries

- *"Find me a box-to-box midfielder, under 24, from Americas leagues, high pressing, World Cup ready"*
- *"Striker from Brasileirão or Liga MX, top 15% xG, under 25, flying under the radar"*
- *"Who's the best false 9 in non-European leagues right now?"*
- *"Defensive midfielder with elite build-up play, under 23, South American league"*

---

## Project Structure

```
gemscout/
├── agent/               # Google Cloud Agent Builder config + OpenAPI tool spec
├── backend/             # FastAPI backend (Python 3.12)
│   └── src/gemscout/
│       ├── api/         # FastAPI routes (/players, /rankings, /agent/scout)
│       ├── db/          # MongoDB async client (motor)
│       ├── embeddings/  # Voyage AI embedding generation
│       ├── agent/       # Agent tools (semantic search, filter, scouting report)
│       └── valuation/   # Percentile normalization (adapted from OpenMercat)
├── frontend/            # React 19 + TypeScript + Tailwind CSS
│   └── src/
│       ├── App.tsx      # Main app with Scout + Explorer modes
│       └── ScoutMode.tsx  # GemScout agent UI (NL query + reasoning + report)
├── scripts/             # Data pipeline
│   ├── migrate_to_mongodb.py   # PostgreSQL → MongoDB migration
│   ├── generate_embeddings.py  # Voyage AI embedding generation
│   └── setup_atlas_indexes.py  # Atlas Vector Search index setup
└── mcp/                 # MongoDB MCP server configuration
```

---

## Credits

Built on top of [OpenMercat](https://github.com/DavidDiazMerino/openmercat) — an open football analytics platform.

Data sources: Understat · SofaScore · FBRef · Transfermarkt · Wikidata

---

*GemScout. Find them first.*
