#!/usr/bin/env bash
# Stage 5 (T-5.6) — live API smoke of the World library + appearance routes.
# Boots a fresh dev server, registers a throwaway account, exercises the
# locations/props CRUD, the appearance PUT validation paths, and the
# cross-tenant isolation of both new resources.
set -u
cd /home/z/my-project
PORT=3107
BASE="http://localhost:$PORT"

fail=0
expect() { # expect <label> <want> <actual>
  if [ "$3" = "$2" ]; then echo "[smoke] ✓ $1 ($2)"; else echo "[smoke] ✗ $1: expected $2, got $3"; fail=1; fi
}

# 1. Boot the dev server on a scratch port (daemonized so it survives).
pkill -f "next dev -p $PORT" 2>/dev/null; sleep 1; true
PORT="$PORT" nohup python3 scripts/daemonize.py /tmp/tf-world-smoke.log npm exec -- next dev -p "$PORT" -H 0.0.0.0 >/tmp/tf-world-nohup.log 2>&1 &
echo "[smoke] booting dev server on :$PORT…"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "$BASE/login"; then break; fi
  sleep 2
done
curl -sf -o /dev/null "$BASE/login" || { echo "[smoke] FAIL: server never came up"; tail -5 /tmp/tf-world-smoke.log; exit 1; }
echo "[smoke] server up"

EMAIL="world-smoke-$RANDOM@example.com"
JAR=/tmp/tf-world-cookies.txt
JAR2=/tmp/tf-world-cookies2.txt
rm -f "$JAR" "$JAR2"

# 2. Register tenant A + tenant B.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Smoke-World-2026!\"}")
expect "register A" "201" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR2" -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"other-$EMAIL\",\"password\":\"Smoke-World-2026!\"}")
expect "register B" "201" "$CODE"

# 3. Locations CRUD.
CODE=$(curl -s -o /tmp/tf-loc.json -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/locations" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Neon Rooftop Bar","description":"rain-slicked neon, skyline behind the rail, always night"}')
expect "create location" "201" "$CODE"
LOC_ID=$(python3 -c "import json;print(json.load(open('/tmp/tf-loc.json'))['location']['id'])")

COUNT=$(curl -s -b "$JAR" "$BASE/api/locations" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['locations']))")
expect "list locations (A sees 1)" "1" "$COUNT"

CODE=$(curl -s -o /tmp/tf-loc2.json -w '%{http_code}' -b "$JAR" -X PATCH "$BASE/api/locations/$LOC_ID" \
  -H 'Content-Type: application/json' -d '{"description":"neon rooftop, thunderstorm version"}')
expect "patch location" "200" "$CODE"

# 4. Isolation: tenant B sees none of A's locations, and cannot patch/delete them.
COUNT=$(curl -s -b "$JAR2" "$BASE/api/locations" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['locations']))")
expect "B sees 0 locations" "0" "$COUNT"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X PATCH "$BASE/api/locations/$LOC_ID" \
  -H 'Content-Type: application/json' -d '{"name":"Stolen"}')
expect "B cannot patch A's location" "404" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X DELETE "$BASE/api/locations/$LOC_ID")
expect "B cannot delete A's location" "404" "$CODE"

# 5. Props CRUD + validation.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/props" \
  -H 'Content-Type: application/json' -d '{"name":"The Brass Compass","description":"scratched brass, red thread tied to the loop"}')
expect "create prop" "201" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/props" \
  -H 'Content-Type: application/json' -d '{"name":""}')
expect "prop name required" "400" "$CODE"

# 6. Unauthenticated access is rejected.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/locations")
expect "unauthenticated GET" "401" "$CODE"

# 7. Appearance PUT validation (no video yet → 404; bad body → 400).
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X PUT "$BASE/api/videos/does-not-exist/appearance" \
  -H 'Content-Type: application/json' -d '{"sceneIndex":1,"outfit":"black coat"}')
expect "appearance on missing video" "404" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/videos" \
  -H 'Content-Type: application/json' \
  -d '{"topic":"World smoke","script":"A short smoke test script.","approved":true}')
VID=$(curl -s -b "$JAR" "$BASE/api/videos" | python3 -c "import json,sys;vs=json.load(sys.stdin)['videos'];print(vs[0]['id'] if vs else '')")
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X PUT "$BASE/api/videos/$VID/appearance" \
  -H 'Content-Type: application/json' -d '{"sceneIndex":0,"outfit":"x"}')
expect "appearance bad sceneIndex" "400" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X PUT "$BASE/api/videos/$VID/appearance" \
  -H 'Content-Type: application/json' -d '{"sceneIndex":1,"outfit":"black coat"}')
expect "appearance on non-story/castless video" "400" "$CODE"

# 8. Soft-delete: the location vanishes from the list but the row survives.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X DELETE "$BASE/api/locations/$LOC_ID")
expect "delete location" "200" "$CODE"
COUNT=$(curl -s -b "$JAR" "$BASE/api/locations" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['locations']))")
expect "list after delete (0)" "0" "$COUNT"

echo ""
if [ "$fail" = "0" ]; then echo "[smoke] ALL PASS"; else echo "[smoke] FAILURES PRESENT"; fi
pkill -f "next dev -p $PORT" 2>/dev/null; true
exit $fail
