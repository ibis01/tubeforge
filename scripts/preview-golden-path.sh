#!/usr/bin/env bash
# Golden-path verification: signup -> dashboard -> snapshot (semantic locators).
set -uo pipefail
cd /home/z/my-project

EV=/tmp/preview-verify
mkdir -p "$EV"

setsid nohup bun run dev >> dev.log 2>&1 < /dev/null &
for i in $(seq 1 30); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:3000/" 2>/dev/null)
  [ "$CODE" = "200" ] && break
  sleep 2
done
echo "server: $CODE after $i probes"

agent-browser open http://localhost:3000/ >/dev/null 2>&1
agent-browser wait --load networkidle >/dev/null 2>&1

agent-browser find label "Your name" fill "Preview Check" 2>&1 | tail -1
agent-browser find label "Email" fill "preview-check@tubeforge.test" 2>&1 | tail -1
agent-browser find label "Password" fill "PreviewCheck!2026" 2>&1 | tail -1
agent-browser find label "Repeat the password" fill "PreviewCheck!2026" 2>&1 | tail -1
sleep 1
agent-browser find role button click --name "Create account" 2>&1 | tail -1
agent-browser wait --load networkidle >/dev/null 2>&1
sleep 5
echo "url after signup: $(agent-browser get url 2>&1)"
echo "title: $(agent-browser get title 2>&1)"
agent-browser screenshot "$EV/05-after-signup.png" 2>&1 | tail -1
agent-browser snapshot -i -c > "$EV/06-after-signup-interactive.txt" 2>&1
head -c 1200 "$EV/06-after-signup-interactive.txt"
echo "--- errors ---"
agent-browser errors 2>&1 | tail -4
