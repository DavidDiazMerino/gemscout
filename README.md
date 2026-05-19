# GemScout — AI Football Scouting Agent

> **Google Cloud Rapid Agent Hackathon 2026** · MongoDB Track

**Find the hidden gems before anyone else.**

GemScout is a World Cup 2026 scouting agent that helps national team directors discover underrated players using semantic search, 3-season trend analysis, and Gemini-generated tactical dossiers.

[![License: MIT](https://img.shields.io/badge/License-MIT-lime.svg)](LICENSE)
[![Built with Gemini 2.5 Flash](https://img.shields.io/badge/Built%20with-Gemini%202.5%20Flash-blue)](https://cloud.google.com/vertex-ai)
[![MongoDB Atlas Vector Search](https://img.shields.io/badge/Data-MongoDB%20Atlas%20Vector%20Search-green)](https://www.mongodb.com/atlas)

---

## The Problem

A national team director preparing for the 2026 World Cup faces an impossible task: manually scouting 2,200+ players across 20+ leagues, comparing tactical profiles and statistical trajectories, all before the transfer window closes.

GemScout solves this in seconds.

## The Solution

A single natural language query like *"box-to-box midfielder, under 24, high pressing, World Cup ready"* triggers a 4-step agent pipeline:

1. **Voyage AI `voyage-3-large`** embeds the query into a 1536-dim tactical vector
2. **MongoDB Atlas Vector Search** (cosine similarity) retrieves the semantically closest players from 2,200+ tactical profiles
3. **Quantitative cross-filter** validates candidates against hard constraints (age, position, league tier)
4. **Gemini 2.5 Flash** (Vertex AI) generates a structured scouting dossier with WC cycle trend analysis

All orchestrated by **Google Cloud Agent Builder** via OpenAPI tool integration.

---

## Architecture

```
User (natural language query)
        │
        ▼
Google Cloud Agent Builder  ──── agent/agent_config.yaml
        │  (OpenAPI tool call)
        ▼
FastAPI Backend  ──────────────── Cloud Run (europe-west3)
        │
        ├─► Voyage AI voyage-3-large
        │   embed query → 1536-dim vector
        │
        ├─► MongoDB Atlas Vector Search
        │   index: player_embedding_index
        │   cosine similarity · 200 candidates
        │   post-filter: season / position / age / league_tier
        │
        ├─► MongoDB quantitative filter
        │   sort by position-specific percentile stat
        │   merge with semantic results
        │
        └─► Gemini 2.5 Flash (Vertex AI REST API)
            prompt: top-3 profiles + 3-season WC cycle data
            output: structured scouting dossier
                │
                ▼
        React + TypeScript UI
        reasoning trace · player cards · Gemini dossier
```

---

## Partner Technology: MongoDB

| Component | Usage |
|-----------|-------|
| **MongoDB Atlas** | Primary store — 2,200+ player documents with stats, percentile scores, Voyage AI embeddings |
| **Atlas Vector Search** | Core feature — `$vectorSearch` aggregation stage over 1536-dim embeddings, cosine similarity, pre-filter by position/age/season |
| **Atlas (quantitative)** | Secondary filter pass — sort by `metrics_normalized.{key}` for position-aware stat ranking |

Agent Builder connects to MongoDB via a FastAPI backend tool (OpenAPI spec in `agent/agent_config.yaml`).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Agent Orchestration | Google Cloud Agent Builder |
| LLM | Gemini 2.5 Flash (`gemini-2.5-flash`, Vertex AI REST) |
| Embeddings | Voyage AI (`voyage-3-large`, 1536-dim) |
| Database | MongoDB Atlas |
| Vector Search | MongoDB Atlas Vector Search (`$vectorSearch`) |
| Backend | FastAPI + Motor (async MongoDB, Python 3.12) |
| Frontend | React 19 + TypeScript + Tailwind CSS v4 |
| Deployment | Cloud Run (backend) · Vite dev server (frontend demo) |

---

## Data

- **2,200+ players** across Big-5 Europe, Brasileirão, Liga MX, MLS, and 15+ leagues
- **Current season**: 2025-26 (team + stats from SofaScore / FBRef)
- **Historical**: 2024-25 and 2023-24 in `history.{season}` subdocuments — enables 3-season WC cycle trend analysis
- **Stats**: xG, xA, goals, assists, key passes, xG chain, xG buildup, minutes, shots + goalkeeper-specific metrics
- **Percentile normalization** within position groups (FWD/MID/DEF/GK)
- **Voyage AI embeddings** of rich tactical player profiles (`profile_text`)

---

## Setup

### Prerequisites

- Python 3.12+
- Node 22+
- MongoDB Atlas M10+ cluster (Vector Search requires M10 or higher)
- Voyage AI API key ([voyageai.com](https://voyageai.com))
- Google Cloud project with Vertex AI enabled

### 1. Clone & configure

```bash
git clone https://github.com/DavidDiazMerino/Gemscout
cd Gemscout
cp .env.example .env
# Edit .env with your credentials
```

### 2. Migrate data to MongoDB

```bash
cd backend && pip install -e ".[migration]"
python ../scripts/migrate_to_mongodb.py
python ../scripts/migrate_history.py   # 2023-24 + 2024-25 historical seasons
```

### 3. Generate Voyage AI embeddings

```bash
python ../scripts/generate_embeddings.py
```

### 4. Create Atlas Vector Search index

In Atlas UI → Search Indexes → Create: use `player_embedding_index` on the `players` collection, field `embedding`, dimensions 1536, cosine similarity.

### 5. Run locally

```bash
# Backend
cd backend && pip install -e .
uvicorn gemscout.api.main:app --reload --port 8080

# Frontend (separate terminal)
cd frontend && npm install
VITE_API_TARGET=http://localhost:8080 npm run dev
```

Open http://localhost:5173

### 6. Deploy to Cloud Run

```bash
gcloud run deploy gemscout-backend \
  --source ./backend \
  --region europe-west3 \
  --allow-unauthenticated \
  --set-env-vars="MONGODB_URI=...,VOYAGE_API_KEY=...,GOOGLE_CLOUD_PROJECT=..."
```

---

## Google Cloud Agent Builder Setup

1. Go to [Vertex AI Agent Builder](https://cloud.google.com/agent-builder) in GCP Console
2. Create new agent
3. Add an OpenAPI tool — use the spec from `agent/agent_config.yaml` (points to the Cloud Run URL)
4. Test with: *"Find me a box-to-box midfielder, under 24, from Americas leagues, World Cup potential"*

---

## Example Queries

- *"Box-to-box midfielder, under 24, high pressing intensity and strong ball progression, World Cup 2026 potential"*
- *"Elite goalkeeper for World Cup 2026 — commanding aerial presence, quick distribution, top-tier shot-stopping"*
- *"High-intensity pressing forward, under 23, similar to Gnabry — explosive, goals and assists"*
- *"Creative attacking midfielder in La Liga, under 26, elite chance creation"*
- *"South American midfielder playing in Europe, under 25, undervalued by Transfermarkt"*

---

## Project Structure

```
gemscout/
├── agent/                    # Google Cloud Agent Builder config + OpenAPI spec
│   └── agent_config.yaml
├── backend/
│   └── src/gemscout/
│       ├── api/main.py       # FastAPI routes — /agent/scout orchestration
│       ├── agent/tools.py    # semantic_player_search, filter_players, build_scouting_prompt
│       ├── db/               # MongoDB async client (Motor)
│       └── embeddings/       # Voyage AI embedding generation
├── frontend/
│   └── src/
│       ├── App.tsx           # Explorer mode (rankings, trend charts)
│       └── ScoutMode.tsx     # Scout mode (NL query → reasoning trace → dossier)
└── scripts/
    ├── migrate_to_mongodb.py    # PostgreSQL → MongoDB migration
    ├── migrate_history.py       # 2023-24 / 2024-25 historical seasons
    └── generate_embeddings.py   # Voyage AI embedding generation
```

---

## Credits

Built on top of [OpenMercat](https://github.com/DavidDiazMerino/openmercat) — an open football analytics platform.

Data sources: SofaScore · FBRef · Transfermarkt · Wikidata

---

*GemScout. Find them first.*
