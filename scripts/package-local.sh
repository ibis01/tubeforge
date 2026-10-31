#!/usr/bin/env bash
# TubeForge local packaging — restored in Stage 1 (task T-1.1; was referenced
# by SECURITY.md's distribution guidance but missing from the shipped tree).
#
# Builds download/tubeforge-local.zip for local-machine deployment. The
# archive deliberately EXCLUDES everything that could leak secrets or state:
#   db/            live SQLite database (contains provider API keys!)
#   uploads/       user media
#   backups/       database copies
#   .env / .z-ai-config   credentials
#   node_modules / .next / download / preview  build + environment artifacts
#
# Usage: bash scripts/package-local.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v zip >/dev/null 2>&1; then
  echo "[package] ERROR: the 'zip' CLI is required (apt install zip / brew install zip)" >&2
  exit 1
fi

STAMP="$(date +%Y-%m-%d)"
OUT="$ROOT/download/tubeforge-local.zip"
mkdir -p "$ROOT/download"

rm -f "$OUT"
zip -qr "$OUT" \
  -x "db/*" \
  -x "uploads/*" \
  -x "backups/*" \
  -x ".env" \
  -x ".env.*" \
  -x "!.env.example" \
  -x ".z-ai-config" \
  -x "node_modules/*" \
  -x ".next/*" \
  -x "download/*" \
  -x "preview/*" \
  -x "pack/*" \
  -x "*.db" \
  -x "*.db-journal" \
  -x "db/auth.lock" \
  .

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[package] wrote $OUT ($SIZE)"
echo "[package] verified exclusions:"
for f in db/custom.db .env .z-ai-config; do
  if unzip -l "$OUT" | grep -q " $f\$"; then
    echo "  ✗ LEAK: $f is inside the archive!" >&2
    exit 1
  else
    echo "  ✓ $f excluded"
  fi
done
echo "[package] done — the archive is safe to share."
