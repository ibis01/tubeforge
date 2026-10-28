#!/usr/bin/env bash
# tf-go-public.sh — put your local TubeForge on a public https://*.trycloudflare.com URL
# Usage:  bash tf-go-public.sh [port]     default port 3000
# Ctrl+C stops sharing. The URL is temporary — it changes each run.
set -euo pipefail

PORT="${1:-3000}"
APP="http://localhost:$PORT"
echo "== TubeForge -> public subdomain =="

# 1) install cloudflared if missing
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "  -> downloading cloudflared (sudo needed)..."
  cd /tmp
  wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
    || { echo "!! download failed — check internet"; exit 1; }
  sudo dpkg -i cloudflared-linux-amd64.deb
  rm -f cloudflared-linux-amd64.deb
  cd "$HOME"
  command -v cloudflared >/dev/null 2>&1 || { echo "!! install failed"; exit 1; }
  echo "  [ok] cloudflared installed"
fi

# 2) is the app running?
if ! curl -s -o /dev/null --max-time 4 "$APP"; then
  echo "!! Nothing is listening on $APP"
  echo "   Start it in another terminal first:  cd ~/tubeforge && npm run dev"
  exit 1
fi

# 3) lock-screen safety check
LOCK=$(curl -s --max-time 4 "http://localhost:$PORT/api/auth/status" || echo '{}')
if echo "$LOCK" | grep -q '"gateEnabled": *true'; then
  echo "  [ok] lock screen is enabled — strangers can't get in"
else
  echo "  !! WARNING: studio lock screen is OFF."
  echo "     Anyone who gets this URL can open YOUR studio and spend YOUR AI credits."
  echo "     Enable it first in the app: Settings -> Security -> enable lock screen."
  read -r -p "  Share anyway? [y/N] " a
  [ "${a,,}" = "y" ] || { echo "  aborted."; exit 0; }
fi

# 4) open the tunnel and show your public URL
LOG=$(mktemp)
cloudflared tunnel --url "$APP" --no-autoupdate >"$LOG" 2>&1 &
TUN=$!
trap 'kill "$TUN" 2>/dev/null; rm -f "$LOG"' INT TERM EXIT
URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then
  echo "!! tunnel did not come up — last log lines:"; tail -n 20 "$LOG"; exit 1
fi
echo ""
echo "  ==================================================="
echo "   YOUR PUBLIC URL:  $URL"
echo "  ==================================================="
echo "   Share it with anyone. Press Ctrl+C to stop sharing."
wait "$TUN"
