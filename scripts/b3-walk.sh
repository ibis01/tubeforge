#!/usr/bin/env bash
# B3 walk #3 — final receipt pass (settled waits, scroll-safe, mobile fixed).
# TubeForge adaptation: repo path + dev log carry the TubeForge names; the
# server boots via npm (the repo's own scripts) — everything else is the
# Studio walk verbatim (de-rebrand law, audit §4).
set -u
cd /home/z/tubeforge
mkdir -p /tmp/b3walk
step() { echo; echo "=== $1 ==="; }

step "boot dev server"
setsid nohup npm run dev > /tmp/tubeforge-dev.log 2>&1 < /dev/null &
for i in $(seq 1 90); do ss -ltn 2>/dev/null | grep -q ':3000' && break; sleep 1; done
ss -ltn | grep ':3000' || { echo "SERVER FAILED"; exit 1; }
sleep 5  # let the first compile settle before hammering it

step "register + seed"
EMAIL="walk3-b3-$(date +%s)@tubeforge.test"
curl -s -D /tmp/walk-headers.txt -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"B3 Walk3\",\"email\":\"$EMAIL\",\"password\":\"walk-12345\"}" -o /tmp/walk-reg.json
TOKEN=$(grep -i '^set-cookie: .*tf_session=' /tmp/walk-headers.txt | head -1 | sed 's/.*tf_session=//' | cut -d';' -f1)
VURL=$(python3 -c "import json;d=json.load(open('/tmp/walk-reg.json'));print((d.get('verification') or {}).get('url') or '')")
[ -n "$VURL" ] && curl -s "http://localhost:3000$VURL" > /dev/null
npx tsx scripts/seed-walk.mts "$EMAIL" 2>/dev/null | tail -1

step "browser 1440 — projects → workspace"
agent-browser set viewport 1440 900
agent-browser open http://localhost:3000/
agent-browser cookies set tf_session "$TOKEN"
agent-browser reload
agent-browser wait --load networkidle
agent-browser wait --text "Projects" --timeout 30000
agent-browser screenshot /tmp/b3walk/31-home.png
agent-browser find role button click --name "Projects"
agent-browser wait --load networkidle
agent-browser screenshot /tmp/b3walk/32-projects.png
agent-browser find text "Walk probe — container economy" click
agent-browser wait --text "The harbor at dawn" --timeout 45000
sleep 2
agent-browser screenshot /tmp/b3walk/33-ws-director.png

step "director: scene card content"
agent-browser eval "JSON.stringify({cards: document.body.innerText.includes('The harbor at dawn'), structure: document.body.innerText.includes('Narrative structure'), emotion: document.body.innerText.includes('Emotional progression')})"

step "storyboard"
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser find role tab click --name "Storyboard"
agent-browser wait --text "The harbor at dawn" --timeout 30000
sleep 1
agent-browser screenshot /tmp/b3walk/34-ws-storyboard.png

step "canvas: rail + panel"
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser find role tab click --name "Canvas"
agent-browser wait --text "Scene 1 Studio" --timeout 30000
sleep 1
agent-browser screenshot /tmp/b3walk/35-ws-canvas.png
agent-browser eval "JSON.stringify({rail: document.body.innerText.includes('Scene picker'), studio: document.body.innerText.includes('Scene 1 Studio'), trust: document.body.innerText.includes('History, checks & approval')})"

step "timeline"
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser find role tab click --name "Timeline"
sleep 2
agent-browser screenshot /tmp/b3walk/36-ws-timeline.png

step "inspector"
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser find role tab click --name "Inspector"
agent-browser wait --text "Voiceover" --timeout 30000
sleep 1
agent-browser screenshot /tmp/b3walk/37-ws-inspector.png
agent-browser eval "JSON.stringify({voice: document.body.innerText.includes('Voiceover'), kit: document.body.innerText.includes('Engagement kit'), ship: document.body.innerText.includes('Publish to YouTube')})"

step "edit scene → canvas"
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser find role tab click --name "Storyboard"
agent-browser wait --text "Edit scene" --timeout 30000
agent-browser find text "Edit scene" click
agent-browser wait --text "Scene 1 Studio" --timeout 30000
sleep 1
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser screenshot /tmp/b3walk/38-edit-lands-canvas.png

step "back to projects"
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser find role button click --name "Back to Projects"
agent-browser wait --load networkidle
sleep 1
agent-browser screenshot /tmp/b3walk/39-back-projects.png

step "home continue row"
agent-browser find role button click --name "Home"
agent-browser wait --load networkidle
sleep 1
agent-browser screenshot /tmp/b3walk/40-home-continue.png

step "390 sweep"
agent-browser set viewport 390 844
agent-browser open http://localhost:3000/
agent-browser wait --load networkidle
agent-browser find role button click --name "Open navigation menu"
sleep 1.5
agent-browser screenshot /tmp/b3walk/41-sheet-390.png
agent-browser find role button click --name "Projects"
agent-browser wait --load networkidle
sleep 1
agent-browser find text "Walk probe — container economy" click
agent-browser wait --text "The harbor at dawn" --timeout 45000
sleep 2
agent-browser screenshot /tmp/b3walk/42-ws-390-director.png
agent-browser eval "document.documentElement.scrollWidth"
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser find role tab click --name "Inspector"
agent-browser wait --text "Voiceover" --timeout 30000
sleep 1
agent-browser screenshot /tmp/b3walk/43-ws-390-inspector.png
agent-browser eval "document.documentElement.scrollWidth"

step "errors?"
agent-browser errors | tail -8
agent-browser close
pkill -f "next dev" 2>/dev/null
echo; echo "WALK3 COMPLETE"
