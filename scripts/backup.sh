#!/usr/bin/env bash
# TubeForge backup — restored in Stage 1 (task T-1.1; was referenced by
# package.json "backup" and SETUP.md but missing from the shipped tree).
#
# SQLite mode (DATABASE_URL=file:...): hot-copies the database with
# `VACUUM INTO` (safe while the app is running) plus a manifest of uploads/.
# Postgres mode: uses pg_dump when available, otherwise prints the command
# to run manually. Keep at least one backup off-machine.
#
# Usage: npm run backup   →  backups/tubeforge-<timestamp>/

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
DEST="$ROOT/backups/tubeforge-$STAMP"
mkdir -p "$DEST"

# --- resolve DATABASE_URL from .env (same parse as postinstall.mjs) ---
DB_URL=""
if [ -f .env ]; then
  DB_URL="$(sed -n 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*"\{0,1\}\([^"\r\n]*\)"\{0,1\}[[:space:]]*$/\1/p' .env | head -1 | tr -d '[:space:]')"
fi

echo "[backup] destination: $DEST"

if [[ "$DB_URL" == file:* ]]; then
  DB_FILE="${DB_URL#file:}"
  # Relative file: URLs are resolved by Prisma against prisma/, so a value
  # like ../db/custom.db lands in <project>/db/custom.db.
  case "$DB_FILE" in
    /*) ;;
    *)  DB_FILE="$ROOT/prisma/$DB_FILE" ;;
  esac

  if [ ! -f "$DB_FILE" ]; then
    echo "[backup] ERROR: database file not found: $DB_FILE" >&2
    exit 1
  fi

  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "[backup] ERROR: sqlite3 CLI is required for SQLite backups" >&2
    echo "         (install it, or copy $DB_FILE manually while the app is stopped)" >&2
    exit 1
  fi

  sqlite3 "$DB_FILE" "VACUUM INTO '$DEST/database.db'"
  echo "[backup] database hot-copied (VACUUM INTO): $DB_FILE -> $DEST/database.db"
else
  if [ -z "$DB_URL" ]; then
    echo "[backup] WARNING: DATABASE_URL not found in .env — attempting pg_dump default" >&2
  fi
  if command -v pg_dump >/dev/null 2>&1; then
    pg_dump "${DB_URL:-${DATABASE_URL:-}}" > "$DEST/database.sql"
    echo "[backup] Postgres dumped to $DEST/database.sql"
  else
    echo "[backup] pg_dump not installed — run this manually:" >&2
    echo "  pg_dump \"\$DATABASE_URL\" > $DEST/database.sql" >&2
    exit 1
  fi
fi

# --- uploads manifest (media lives on disk, not in the DB) ---
if [ -d uploads ]; then
  ( cd uploads && find . -type f -printf '%p\t%s bytes\n' 2>/dev/null | sort ) \
    > "$DEST/uploads-manifest.txt" 2>/dev/null \
    || ( cd uploads && find . -type f | sort ) > "$DEST/uploads-manifest.txt"
  COUNT="$(wc -l < "$DEST/uploads-manifest.txt" | tr -d ' ')"
  echo "[backup] uploads manifest written ($COUNT files; copy uploads/ separately for media)"
else
  echo "[backup] no uploads/ directory yet — manifest skipped"
fi

cat > "$DEST/MANIFEST.txt" <<EOF
TubeForge backup
Created: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Host:    "$(hostname 2>/dev/null || echo unknown)"
Mode:    $([[ "$DB_URL" == file:* ]] && echo sqlite || echo postgres)
Contents:
  - database: hot copy taken with the app running
  - uploads-manifest.txt: file list of uploads/ (media NOT included — rsync uploads/ separately)
Restore: replace the database file / re-import the SQL dump, then restore uploads/.
EOF

echo "[backup] done — keep at least one copy of $DEST off this machine."
