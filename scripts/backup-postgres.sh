#!/usr/bin/env bash
# TubeForge — production Postgres backup (S33, roadmap §4.6).
#
# `npm run backup` (scripts/backup.sh) covers SQLite, the development
# database. This script covers PRODUCTION Postgres: a nightly logical dump
# as the independent, off-provider copy, with three properties the roadmap
# demands of a control rather than a hypothesis:
#
#   1. VERIFIED   — every dump is immediately listed back through
#                   pg_restore --list; a dump that cannot be read is a
#                   failure, not a backup.
#   2. OFF-BOX    — when BACKUP_S3_URI is set (and the aws CLI or rclone is
#                   installed), the dump + checksum are uploaded; a backup
#                   that only exists on the machine it backs up is not a
#                   backup.
#   3. BOUNDED    — local dumps older than BACKUP_RETENTION_DAYS (default
#                   14) are pruned, so the disk never fills silently.
#
# The restore DRILL (restore to a scratch database, boot the app against it,
# record the time) is documented in docs/runbooks/backup-restore.md — run it
# quarterly; a backup that has never been restored is a hypothesis.
#
# Usage:
#   npm run db:backup:pg                      # dump to backups/pg/
#   BACKUP_S3_URI=s3://bucket/tubeforge \
#     npm run db:backup:pg                    # + off-box upload
#
# Environment:
#   DATABASE_URL            — the Postgres connection string (falls back to
#                             the .env file, same parse as backup.sh)
#   BACKUP_S3_URI           — optional; enables the upload step
#   BACKUP_RETENTION_DAYS   — optional; local pruning window (default 14)
#   TUBEFORGE_BACKUP_DIR    — optional; overrides backups/pg

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_DIR="${TUBEFORGE_BACKUP_DIR:-$ROOT/backups/pg}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
DUMP="$BACKUP_DIR/tubeforge-$STAMP.dump"

# --- resolve DATABASE_URL from env or .env (same parse as backup.sh) -------
DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ] && [ -f .env ]; then
  DB_URL="$(sed -n 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*"\{0,1\}\([^"\r\n]*\)"\{0,1\}[[:space:]]*$/\1/p' .env | head -1 | tr -d '[:space:]')"
fi

if [ -z "$DB_URL" ]; then
  echo "[backup:pg] ERROR: DATABASE_URL not set (env or .env)" >&2
  exit 1
fi
if [[ "$DB_URL" == file:* ]]; then
  echo "[backup:pg] ERROR: DATABASE_URL is SQLite — use 'npm run backup' instead" >&2
  exit 1
fi
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[backup:pg] ERROR: pg_dump not installed (postgresql-client package)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# --- 1. dump (custom format: compressed, pg_restore-friendly, and it can be
#        restored selectively — schema or data or single tables) -------------
echo "[backup:pg] dumping to $DUMP"
pg_dump --format=custom --file="$DUMP" --no-owner --no-privileges "$DB_URL"

# --- 2. verify (a dump pg_restore cannot even LIST is a failure) ------------
TOC="$(mktemp)"
pg_restore --list "$DUMP" > "$TOC"
TABLES="$(grep -c 'TABLE DATA' "$TOC" || true)"
rm -f "$TOC"
if [ "$TABLES" -eq 0 ]; then
  echo "[backup:pg] ERROR: dump verification found no table data — treating as failure" >&2
  rm -f "$DUMP"
  exit 1
fi
echo "[backup:pg] verified: readable archive, $TABLES tables with data"

# --- 3. checksum sidecar -----------------------------------------------------
sha256sum "$DUMP" > "$DUMP.sha256"
echo "[backup:pg] checksum: $(cut -d' ' -f1 "$DUMP.sha256")"

# --- 4. off-box upload (optional; aws CLI preferred, rclone fallback) -------
SIZE="$(du -h "$DUMP" | cut -f1)"
if [ -n "${BACKUP_S3_URI:-}" ]; then
  if command -v aws >/dev/null 2>&1; then
    aws s3 cp "$DUMP" "$BACKUP_S3_URI/tubeforge-$STAMP.dump"
    aws s3 cp "$DUMP.sha256" "$BACKUP_S3_URI/tubeforge-$STAMP.dump.sha256"
    echo "[backup:pg] uploaded via aws CLI to $BACKUP_S3_URI"
  elif command -v rclone >/dev/null 2>&1; then
    rclone copy "$DUMP" "rclone-remote:${BACKUP_S3_URI#s3://}" 2>/dev/null \
      || rclone copyto "$DUMP" "$BACKUP_S3_URI/tubeforge-$STAMP.dump"
    echo "[backup:pg] uploaded via rclone to $BACKUP_S3_URI"
  else
    echo "[backup:pg] WARNING: BACKUP_S3_URI set but neither aws nor rclone found —" >&2
    echo "[backup:pg]          dump remains local-only at $DUMP" >&2
  fi
else
  echo "[backup:pg] WARNING: BACKUP_S3_URI not set — dump is local-only;" >&2
  echo "[backup:pg]          keep at least one copy off this machine"
fi

# --- 5. prune local dumps past the retention window -------------------------
if [ "$RETENTION_DAYS" -gt 0 ]; then
  PRUNED="$(find "$BACKUP_DIR" -name 'tubeforge-*.dump' -type f -mtime +"$RETENTION_DAYS" -print -delete | wc -l)"
  find "$BACKUP_DIR" -name 'tubeforge-*.dump.sha256' -type f -mtime +"$RETENTION_DAYS" -delete
  echo "[backup:pg] pruned $PRUNED local dump(s) older than $RETENTION_DAYS day(s)"
fi

echo "[backup:pg] done — $DUMP ($SIZE). Restore drill: docs/runbooks/backup-restore.md"
