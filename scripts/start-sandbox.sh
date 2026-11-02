#!/usr/bin/env bash
# start-sandbox.sh — bring the preview deployment back up after a sandbox recycle.
#
# WHY THIS EXISTS: this 2-core / 4 GB sandbox cannot complete a cold
# `next build` (Turbopack peaks >4 GB — it OOM-kills), so the preview runs
# `next dev` (per-route compilation, low memory). Production builds happen on
# Vercel CI via git push. The voice server (Chatterbox Turbo) is started by
# the app itself via the instrumentation spawn hook, but it can also be
# brought up manually here.
#
# Usage:  bash scripts/start-sandbox.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# ── 1. Voice server (Chatterbox Turbo on 127.0.0.1:8931) ─────────────────
if curl -sf --max-time 3 http://127.0.0.1:8931/health > /dev/null 2>&1; then
  echo "[start-sandbox] voice server already up"
else
  VKEY="$(grep -oP '^TUBEFORGE_SHARED_VOICE_KEY=\K.*' .env || true)"
  if [ -n "$VKEY" ] && [ -x voice-server/.venv/bin/python ]; then
    echo "[start-sandbox] starting voice server (chatterbox-turbo)…"
    python3 scripts/daemonize.py voice-server/server.log bash -c \
      "cd '$PWD/voice-server' && export HF_HOME='$PWD/voice-server/hf-cache' VOICE_THREADS=1 && exec .venv/bin/python voice_server.py --model chatterbox-turbo --host 127.0.0.1 --port 8931 --key '$VKEY'"
  else
    echo "[start-sandbox] voice server not configured (TUBEFORGE_SHARED_VOICE_KEY or venv missing) — skipping"
  fi
fi

# ── 2. Web app (next dev — see header) ─────────────────────────────────────
if curl -sf --max-time 3 http://localhost:3000/api/auth/status > /dev/null 2>&1; then
  echo "[start-sandbox] app already up on :3000"
else
  echo "[start-sandbox] starting next dev on :3000…"
  python3 scripts/daemonize.py server-dev.log bash -c \
    "cd '$PWD' && exec npx next dev -p 3000 -H 0.0.0.0"
fi

# ── 3. Wait for both ────────────────────────────────────────────────────────
for i in $(seq 1 30); do
  APP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000/api/auth/status || true)
  [ "$APP" = "200" ] && break
  sleep 3
done
echo "[start-sandbox] app  : http://localhost:3000  → $APP"
VS=$(curl -s --max-time 5 http://127.0.0.1:8931/health || echo '{"ok":false}')
echo "[start-sandbox] voice: $VS"
