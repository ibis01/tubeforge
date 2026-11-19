#!/usr/bin/env bash
# B4 walk — the Creative Workspace Enhancement receipt pass.
# Verifies: the simultaneous pro layout (center + Inspector rail + Timeline
# strip, resizable), the area-strip behaviors (rail hides on Inspector focus,
# S86 jumps), the Scene3D panel, the Inspector audio card, and the 390px
# stacked-tab law (unchanged from B3).
set -u
cd /home/z/tubeforge
mkdir -p /tmp/b4walk
step() { echo; echo "=== $1 ==="; }

step "dev server (assumed running — scripts/b4-walk.sh does not boot one)"
curl -s -o /dev/null -w "%{http_code}" -m 10 http://localhost:3000/ | grep -q 200 || { echo "SERVER NOT UP"; exit 1; }

step "register + seed"
EMAIL="walk-b4-$(date +%s)@tubeforge.test"
curl -s -D /tmp/b4walk-headers.txt -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"B4 Walk\",\"email\":\"$EMAIL\",\"password\":\"walk-12345\"}" -o /tmp/b4walk-reg.json
TOKEN=$(grep -i '^set-cookie: .*tf_session=' /tmp/b4walk-headers.txt | head -1 | sed 's/.*tf_session=//' | cut -d';' -f1)
VURL=$(python3 -c "import json;d=json.load(open('/tmp/b4walk-reg.json'));print((d.get('verification') or {}).get('url') or '')")
[ -n "$VURL" ] && curl -s "http://localhost:3000$VURL" > /dev/null
npx tsx scripts/seed-walk.mts "$EMAIL" 2>/dev/null | tail -1

step "browser 1440 — projects → workspace"
agent-browser set viewport 1440 900
agent-browser open http://localhost:3000/
agent-browser cookies set tf_session "$TOKEN"
agent-browser reload
agent-browser wait --load networkidle
agent-browser wait --text "Projects" --timeout 30000
agent-browser find role button click --name "Projects"
agent-browser wait --load networkidle
agent-browser find text "Walk probe — container economy" click
agent-browser wait --text "The harbor at dawn" --timeout 45000
sleep 2

step "B4-1 — the pro layout is SIMULTANEOUS (center + rail + strip, one TimelineStudio)"
agent-browser eval "JSON.stringify((() => { const t = document.body.innerText.toLowerCase(); return {
  groups: document.querySelectorAll('[data-panel-group]').length,
  handles: document.querySelectorAll('[data-panel-resize-handle-id]').length,
  timelineLanes: t.includes('timeline'),
  inspectorInDOM: t.includes('voiceover'),
  areaStrip: ['director','storyboard','canvas','timeline','inspector'].every(x => t.includes(x))
}; })())"

agent-browser screenshot /tmp/b4walk/01-ws-wide-pro-layout.png

step "B4-1 — the area strip: Director center active, strip + rail + strip simultaneous"
agent-browser eval "JSON.stringify({directorVisible: document.body.innerText.includes('Script editor') || document.body.innerText.includes('Brief')})"

step "canvas area — rail stays alive while Canvas works"
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser find role tab click --name "Canvas"
agent-browser wait --text "Scene 1 Studio" --timeout 30000
sleep 1
agent-browser eval "JSON.stringify((() => { const t = document.body.innerText.toLowerCase(); return { canvasCenter: t.includes('scene 1 studio'), stripStillAlive: document.querySelectorAll('[data-panel-group]').length === 2, inspectorStillThere: t.includes('voiceover') }; })())"
agent-browser screenshot /tmp/b4walk/02-canvas-with-rail-and-strip.png

step "timeline area — render/ship controls in the CENTER, lanes in the strip, Scene3D panel"
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser find role tab click --name "Timeline"
sleep 2
agent-browser eval "JSON.stringify((() => { const t = document.body.innerText.toLowerCase(); return { renderControls: t.includes('render'), scene3d: t.includes('3d scene clip'), audioCard: t.includes('final mix preview'), stripHasLanes: t.includes('timeline studio') || t.includes('lane') || t.includes('preview') }; })())"
agent-browser screenshot /tmp/b4walk/03-timeline-center-with-scene3d.png

step "inspector focus — the rail hides (never two mounted Inspector instances)"
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser find role tab click --name "Inspector"
agent-browser wait --text "Voiceover" --timeout 30000
sleep 1
agent-browser eval "JSON.stringify((() => { const t = document.body.innerText.toLowerCase(); return { inspectorCenter: t.includes('voiceover'), audioCard: t.includes('final mix preview'), groupsNow: document.querySelectorAll('[data-panel-group]').length }; })())"
agent-browser screenshot /tmp/b4walk/04-inspector-focus.png

step "S86 jump — storyboard Edit scene lands Canvas, the rail returns"
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser find role tab click --name "Storyboard"
agent-browser wait --text "Edit scene" --timeout 30000
agent-browser find text "Edit scene" click
agent-browser wait --text "Scene 1 Studio" --timeout 30000
sleep 1
agent-browser eval "JSON.stringify((() => { const t = document.body.innerText.toLowerCase(); return { landedCanvas: t.includes('scene 1 studio'), railBack: t.includes('voiceover') }; })())"
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser screenshot /tmp/b4walk/05-edit-lands-canvas-rail-back.png

step "390 sweep — the B3 stacked tabs law (no panels on mobile)"
agent-browser set viewport 390 844
agent-browser open http://localhost:3000/
agent-browser wait --load networkidle
agent-browser find role button click --name "Open navigation menu"
sleep 1.5
agent-browser find role button click --name "Projects"
agent-browser wait --load networkidle
sleep 1
agent-browser find text "Walk probe — container economy" click
agent-browser wait --text "The harbor at dawn" --timeout 45000
sleep 2
agent-browser eval "JSON.stringify({scrollWidth: document.documentElement.scrollWidth, noPanelsOnMobile: document.querySelectorAll('[data-panel-group]').length === 0, stackedTabs: document.body.innerText.toLowerCase().includes('timeline')})"
agent-browser screenshot /tmp/b4walk/06-ws-390-stacked.png
agent-browser eval "window.scrollTo(0,0)"; sleep 0.5
agent-browser find role tab click --name "Inspector"
agent-browser wait --text "Voiceover" --timeout 30000
sleep 1
agent-browser screenshot /tmp/b4walk/07-390-inspector.png
agent-browser eval "document.documentElement.scrollWidth"

step "errors?"
agent-browser errors | tail -8
agent-browser close
echo; echo "B4 walk complete — receipts in /tmp/b4walk"
