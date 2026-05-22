# GemScout — AI Football Scouting Agent

> **Google Cloud Rapid Agent Hackathon 2026** · MongoDB Track

**Find the hidden gems before anyone else.**

GemScout is a World Cup 2026 scouting agent that helps national team directors discover underrated players using semantic search, 3-season trend analysis, and Gemini-generated tactical dossiers — streamed live as the AI reasons.

[![License: MIT](https://img.shields.io/badge/License-MIT-lime.svg)](LICENSE)
[![Built with Gemini 3.1 Pro](https://img.shields.io/badge/Built%20with-Gemini%203.1%20Pro-blue)](https://cloud.google.com/vertex-ai)
[![MongoDB Atlas Partner MCP](https://img.shields.io/badge/Data-MongoDB%20Atlas%20MCP-green)](https://www.mongodb.com/atlas)
[![Google ADK](https://img.shields.io/badge/Agent-Google%20ADK-orange)](https://google.github.io/adk-docs/)

🔴 **Live demo:** https://gemscout-frontend-377689698254.europe-west3.run.app

---

## The Problem

A national team director preparing for the 2026 World Cup faces an impossible task: manually scouting 2,200+ players across 20+ leagues, comparing tactical profiles and statistical trajectories, all before the transfer window closes.

GemScout solves this with a single natural language query.

---

## What Makes This Different

Most scouting tools are dashboards with filters. GemScout is an **AI agent** that:

1. Understands tactical intent — *"box-to-box midfielder, high pressing"* is not a keyword search, it's a semantic concept
2. Shows its reasoning — every MongoDB tool call is visible in real time as it happens
3. Streams the dossier token by token — the AI "thinks" in front of you
4. Finds tactically similar players — one click on any player card runs a similarity search across the entire database

---

## Architecture

```
User (natural language query)
        │  SSE stream
        ▼
FastAPI Backend (/agent/scout/stream)
        │  HTTP POST /run_sse
        ▼
Google ADK Agent (Cloud Run)         ← gemini-3.1-pro-preview
        │  MCP tool calls (SSE transport)
        ▼
@mongodb-js/mongodb-mcp-server (Cloud Run)   ← official partner MCP server
        │  find / aggregate / count
        ▼
MongoDB Atlas — gemscout.players (2,200+ docs)
        │  Atlas Search ($search moreLikeThis)
        ▼
FastAPI (SSE events: step_start / step_done / player / text / done)
        │
        ▼
React + TypeScript UI
  · Live agent reasoning trace (step cards)
  · Player cards streaming in as found
  · Scouting dossier streamed token by token
  · "Find Similar" — Atlas $search moreLikeThis
```

### Four Cloud Run Services

| Service | Role |
|---------|------|
| `gemscout-frontend` | React + Nginx reverse proxy |
| `gemscout-backend` | FastAPI — SSE orchestration, player API |
| `gemscout-agent` | Google ADK agent (`adk api_server`) |
| `gemscout-mcp` | `@mongodb-js/mongodb-mcp-server` (partner MCP) |

---

## Partner Technology: MongoDB

| Component | Usage |
|-----------|-------|
| **MongoDB Atlas** | Primary store — 2,200+ player documents, stats, percentile scores, Voyage AI embeddings, 3-season history |
| **Atlas Search** | `$search` with `moreLikeThis` operator — finds tactically similar players by profile text similarity |
| **Atlas (aggregation)** | `find` and `aggregate` via the official MCP server — the ADK agent queries Atlas through MCP tool calls in real time |
| **Official MCP Server** | `@mongodb-js/mongodb-mcp-server` — partner MCP deployed to Cloud Run with SSE transport |

---

## Hackathon Stack

| Layer | Technology |
|-------|-----------|
| Agent Orchestration | Google ADK (`google-adk[mcp]==2.0.0`) |
| LLM | Gemini 3.1 Pro Preview (`gemini-3.1-pro-preview`, Vertex AI) |
| Agent–DB Bridge | `@mongodb-js/mongodb-mcp-server` (official MongoDB MCP partner server) |
| Embeddings | Voyage AI `voyage-3-large` (1024-dim) |
| Database | MongoDB Atlas |
| Text Search | MongoDB Atlas Search (`$search moreLikeThis` on `player_text_index`) |
| Streaming | SSE end-to-end: ADK `/run_sse` → FastAPI → browser |
| Backend | FastAPI + Motor (async MongoDB, Python 3.12) |
| Frontend | React 19 + TypeScript + Tailwind CSS v4 |
| Deployment | Cloud Run (all 4 services) |

---

## Data

- **2,200+ players** — Big-5 Europe, Brasileirão, Liga MX, MLS, and 15+ leagues
- **Current season**: 2025-26
- **Historical**: 2024-25 and 2023-24 in `history.{season}` subdocuments — 3-season World Cup cycle trend analysis
- **Stats**: xG, xA, goals, assists, key passes, xG chain, xG buildup, minutes, goalkeeper-specific metrics
- **Percentile normalization** within position groups (FWD / MID / DEF / GK)
- **Tactical profile text** (`profile_text`) — rich natural language profile per player, indexed for Atlas Search

---

## How It Works

### Scout Mode (ADK + MCP streaming)

1. User types: *"box-to-box midfielder, under 24, high pressing"*
2. FastAPI `/agent/scout/stream` creates an ADK session and opens `/run_sse`
3. ADK's Gemini 3.1 Pro decides to call `find` or `aggregate` on the MCP server
4. The MCP server executes the query against MongoDB Atlas
5. Each tool call becomes a live step card in the UI
6. Player cards appear as Gemini processes results
7. The full scouting dossier streams token by token

### Find Similar (Atlas Search)

1. User clicks "Find Similar" on any player card
2. FastAPI fetches that player's `profile_text` from MongoDB
3. Runs `$search` with `moreLikeThis` — finds the 5 tactically closest players
4. Sends candidates to ADK for a head-to-head comparison dossier
5. Everything streams via SSE — players cards first, then dossier

### ⚡ Judges Panel

Toggle **Judges mode** (top right) to see the full technical trace:
- Every MCP tool call with the exact MongoDB pipeline
- Raw results returned by the MCP server
- ADK agent reasoning steps
- Link to the live ADK Agent UI

---

## Project Structure

```
gemscout/
├── agent/
│   ├── gemscout_agent/
│   │   └── __init__.py          # ADK LlmAgent + MCPToolset definition
│   ├── Procfile                 # adk api_server --host 0.0.0.0 --port 8000
│   └── requirements.txt         # google-adk[mcp]==2.0.0
├── backend/
│   └── src/gemscout/
│       ├── api/main.py          # FastAPI — /agent/scout/stream, /agent/scout/similar/stream
│       ├── db/mongodb.py        # Motor async client
│       └── embeddings/
│           └── voyage.py        # Voyage AI embed + build_profile_text
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # Explorer mode (rankings, player cards, trend charts)
│   │   └── ScoutMode.tsx        # Scout mode — SSE consumer, streaming UI
│   ├── Dockerfile               # Multi-stage: Node build → Nginx
│   └── nginx.conf               # Reverse proxy + SSE headers (proxy_buffering off)
└── scripts/
    ├── migrate_to_mongodb.py    # Initial data load
    ├── migrate_history.py       # 2023-24 / 2024-25 historical seasons
    └── generate_embeddings.py   # Voyage AI embedding generation
```

---

## Local Setup

### Prerequisites

- Python 3.12+ · Node 22+
- MongoDB Atlas M10+ cluster
- Voyage AI API key — [voyageai.com](https://voyageai.com)
- Google Cloud project with Vertex AI enabled (`GOOGLE_CLOUD_LOCATION=global` for Gemini 3 models)
- `npm install -g @mongodb-js/mongodb-mcp-server` for local MCP

### 1. Clone & configure

```bash
git clone https://github.com/DavidDiazMerino/Gemscout
cd Gemscout
cp .env.example .env
# Fill in MONGODB_URI, VOYAGE_API_KEY, GOOGLE_CLOUD_PROJECT
```

### 2. Load data & generate embeddings

```bash
cd backend && pip install -e ".[migration]"
python ../scripts/migrate_to_mongodb.py
python ../scripts/migrate_history.py
python ../scripts/generate_embeddings.py
```

### 3. Create Atlas Search index

In Atlas UI → Search → Create Search Index:
- Name: `player_text_index`
- Collection: `gemscout.players`
- Field: `profile_text` (text)

### 4. Run locally

```bash
# Backend
cd backend && pip install -e .
uvicorn gemscout.api.main:app --reload --port 8080

# ADK Agent (in another terminal)
cd agent && pip install google-adk[mcp]==2.0.0
# Edit MCP_SSE_URL in agent/gemscout_agent/__init__.py to point to your local MCP
adk api_server --port 8000

# Frontend
cd frontend && npm install
VITE_API_TARGET=http://localhost:8080 npm run dev
```

### 5. Deploy to Cloud Run

All four services deploy via `gcloud run deploy --source`:

```bash
# MCP server
gcloud run deploy gemscout-mcp \
  --image europe-west3-docker.pkg.dev/.../mongodb-mcp \
  --region europe-west3 --allow-unauthenticated

# ADK Agent
gcloud run deploy gemscout-agent \
  --source ./agent \
  --region europe-west3 --allow-unauthenticated \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=...,GOOGLE_CLOUD_LOCATION=global"

# Backend
gcloud run deploy gemscout-backend \
  --source ./backend \
  --region europe-west3 --allow-unauthenticated \
  --set-env-vars="MONGODB_URI=...,VOYAGE_API_KEY=...,ADK_AGENT_BASE=..."

# Frontend
gcloud run deploy gemscout-frontend \
  --source ./frontend \
  --region europe-west3 --allow-unauthenticated
```

---

## Example Queries

- *"Box-to-box midfielder, under 24, high pressing intensity, World Cup 2026 ready"*
- *"Elite goalkeeper, commanding aerial presence, quick distribution"*
- *"Pressing forward, under 23, similar to Gnabry — explosive, goals and assists"*
- *"Creative attacking midfielder in La Liga, under 26, elite chance creation"*
- *"South American midfielder playing in Europe, under 25, undervalued hidden gem"*

---

## Credits

Built on top of [OpenMercat](https://github.com/DavidDiazMerino/openmercat) — an open football analytics platform.

Data: SofaScore · FBRef · Transfermarkt · Wikidata

---

*GemScout. Find them first.*
