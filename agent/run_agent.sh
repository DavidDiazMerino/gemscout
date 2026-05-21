#!/usr/bin/env bash
# GemScout ADK Agent — local playground
# Opens the ADK web UI at http://localhost:8090
# Connects to the MCP server on Cloud Run (no local MongoDB needed)
#
# Usage:
#   cd agent && ./run_agent.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/../backend/.venv/bin"

export GOOGLE_CLOUD_PROJECT=hackaton-gemscout
export GOOGLE_CLOUD_LOCATION=europe-west3
export GOOGLE_GENAI_USE_VERTEXAI=1

echo ""
echo "  ⚽  GemScout ADK Agent"
echo "  🔗  MCP: https://gemscout-mcp-377689698254.europe-west3.run.app/sse"
echo "  🌐  UI:  http://localhost:8090"
echo ""

cd "$SCRIPT_DIR"
"$VENV/adk" web --host 0.0.0.0 --port 8090
