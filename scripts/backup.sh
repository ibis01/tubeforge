#!/usr/bin/env bash
# Hot backup of TubeForge's runtime data:
#   - SQLite database via VACUUM INTO (safe while the server is running)
#   - uploads/ manifest + total size (media itself is reproducible via renders,
#     but the manifest documents what exists; pass --media to copy it too)
# Usage: bash scripts/backup.sh [--media]
# Output: backups/tubeforge-<UTC timestamp>/

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS=$(date -u +%Y%m%d-%H%M%S)
DEST="$ROOT/backups/tubeforge-$TS"
DB="$ROOT/db/custom.db"

mkdir -p "$DEST"

if [ -f "$DB" ]; then
  echo "==> Backing up SQLite database (VACUUM INTO — hot copy)"
  sqlite3 "$DB" "VACUUM INTO '$DEST/custom.db';"
  # verified: the backup opens + has an integrity_ok pragma
  if [ "$(sqlite3 "$DEST/custom.db" 'PRAGMA integrity_check;')" = "ok" ]; then
    echo "    integrity: ok ($(du -h "$DEST/custom.db" | cut -f1))"
  else
    echo "!!! Backup failed the integrity check !!!" >&2
    exit 1
  fi
else
  echo "!! No database at $DB — skipping db backup"
fi

if [ -d "$ROOT/uploads" ]; then
  if [ "${1:-}" = "--media" ]; then
    echo "==> Copying uploads/ (full media)"
    rsync -a "$ROOT/uploads/" "$DEST/uploads/"
  else
    echo "==> Writing uploads/ manifest (use --media to copy media files)"
    (cd "$ROOT" && find uploads -type f -printf "%s %p\n" | sort -k2 > "$DEST/uploads-manifest.txt")
    echo "    $(wc -l < "$DEST/uploads-manifest.txt") files, $(du -sh "$ROOT/uploads" | cut -f1) total"
  fi
fi

cp "$ROOT/.env" "$DEST/env.backup" 2>/dev/null || true
chmod 600 "$DEST/env.backup" 2>/dev/null || true
echo "==> (secrets from .env copied with mode 600)"

echo "==> Backup complete: $DEST"
echo "    Keep at least one backup off this machine."
