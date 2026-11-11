#!/usr/bin/env bash
# Preview self-verification: start the dev server, drive it with agent-browser,
# capture the golden path, and leave evidence in /tmp/preview-verify/.
set -uo pipefail
cd /home/z/my-project

EV=/tmp/preview-verify
rm -rf "$EV"; mkdir -p "$EV"

# 1. server up (single-call lifetime — everything happens in this script)
setsid nohup bun run dev >> dev.log 2>&1 < /dev/null &
for i in $(seq 1 30); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:3000/" 2>/dev/null)
  [ "$CODE" = "200" ] && break
  sleep 2
done
echo "server: $CODE after $i probes"

# 2. browser: root route renders?
agent-browser open http://localhost:3000/ >/dev/null 2>&1
agent-browser wait --load networkidle >/dev/null 2>&1
echo "title: $(agent-browser get title 2>&1)"
echo "url:   $(agent-browser get url 2>&1)"
agent-browser screenshot "$EV/01-root-viewport.png" 2>&1 | tail -1
agent-browser snapshot -i -c > "$EV/02-root-interactive.txt" 2>&1
head -c 1500 "$EV/02-root-interactive.txt"

echo "--- console ---"
agent-browser console > "$EV/03-console.txt" 2>&1; tail -6 "$EV/03-console.txt"
echo "--- page errors ---"
agent-browser errors > "$EV/04-errors.txt" 2>&1; tail -6 "$EV/04-errors.txt"
