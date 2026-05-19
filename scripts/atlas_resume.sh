#!/bin/bash
# atlas_resume.sh — reanuda el cluster Atlas M10
# Uso: ./scripts/atlas_resume.sh
# Tarda ~2 minutos en estar disponible

set -e
source "$(dirname "$0")/../.env" 2>/dev/null || true

PUBLIC_KEY="${ATLAS_PUBLIC_KEY:?Set ATLAS_PUBLIC_KEY in .env}"
PRIVATE_KEY="${ATLAS_PRIVATE_KEY:?Set ATLAS_PRIVATE_KEY in .env}"
PROJECT_ID="${ATLAS_PROJECT_ID:?Set ATLAS_PROJECT_ID in .env}"
CLUSTER="${ATLAS_CLUSTER_NAME:-gemscout}"

echo "Resuming cluster '${CLUSTER}'... (~2 min)"
curl -s -u "${PUBLIC_KEY}:${PRIVATE_KEY}" --digest \
  -X PATCH \
  -H "Content-Type: application/json" \
  "https://cloud.mongodb.com/api/atlas/v1.0/groups/${PROJECT_ID}/clusters/${CLUSTER}" \
  -d '{"paused": false}' | python3 -c "
import json, sys
r = json.load(sys.stdin)
state = r.get('stateName', r.get('error', 'unknown'))
print(f'Cluster {state} — wait ~2 min then refresh')
"
