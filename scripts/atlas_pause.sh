#!/bin/bash
# atlas_pause.sh — pausa el cluster Atlas M10 (para de cobrar cómputo)
# Uso: ./scripts/atlas_pause.sh
# Para reanudar: ./scripts/atlas_resume.sh
#
# Requiere ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY, ATLAS_PROJECT_ID en .env
# Crea las API keys en: https://cloud.mongodb.com → Organization → Access Manager → API Keys

set -e
source "$(dirname "$0")/../.env" 2>/dev/null || true

PUBLIC_KEY="${ATLAS_PUBLIC_KEY:?Set ATLAS_PUBLIC_KEY in .env}"
PRIVATE_KEY="${ATLAS_PRIVATE_KEY:?Set ATLAS_PRIVATE_KEY in .env}"
PROJECT_ID="${ATLAS_PROJECT_ID:?Set ATLAS_PROJECT_ID in .env}"
CLUSTER="${ATLAS_CLUSTER_NAME:-gemscout}"

curl -s -u "${PUBLIC_KEY}:${PRIVATE_KEY}" --digest \
  -X PATCH \
  -H "Content-Type: application/json" \
  "https://cloud.mongodb.com/api/atlas/v1.0/groups/${PROJECT_ID}/clusters/${CLUSTER}" \
  -d '{"paused": true}' | python3 -c "
import json, sys
r = json.load(sys.stdin)
state = r.get('stateName', r.get('error', 'unknown'))
print(f'Cluster {state}')
"
