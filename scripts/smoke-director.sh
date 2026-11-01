#!/usr/bin/env bash
# Stage 5 (T-5.1) — live API smoke of the AI Director route.
# Boots a fresh dev server, registers a throwaway account, creates a story
# video with a cast scene, and exercises GET / POST / PATCH validation paths.
set -u
cd /home/z/my-project
PORT=3105
BASE="http://localhost:$PORT"

fail=0
expect() { # expect <want> <label> <actual>
  if [ "$3" = "$2" ]; then echo "[smoke] ✓ $1 ($2)"; else echo "[smoke] ✗ $1: expected $2, got $3"; fail=1; fi
}

# 1. Boot the dev server on a scratch port (daemonized so it survives).
if lsof -ti ":$PORT" >/dev/null 2>&1; then kill "$(lsof -ti ":$PORT")" 2>/dev/null; sleep 1; fi
PORT="$PORT" nohup python3 scripts/daemonize.py /tmp/tf-director-smoke.log npm exec -- next dev -p "$PORT" -H 0.0.0.0 >/tmp/tf-director-nohup.log 2>&1 &
echo "[smoke] booting dev server on :$PORT…"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "$BASE/login"; then break; fi
  sleep 2
done
curl -sf -o /dev/null "$BASE/login" || { echo "[smoke] FAIL: server never came up"; tail -5 /tmp/tf-director-smoke.log; exit 1; }
echo "[smoke] server up"

EMAIL="director-smoke-$RANDOM@example.com"
JAR=/tmp/tf-director-cookies.txt
rm -f "$JAR"

# 2. Register + login (cookie session).
CODE=$(curl -s -o /tmp/tf-reg.json -w '%{http_code}' -c "$JAR" -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Smoke-Director-2026!\"}")
echo "[smoke] register → $CODE"
expect "register" "201" "$CODE"

# 3. Create a classic video via the synchronous custom-script path (no AI
# keys needed): analyze-script approves the text, then re-submit with
# `approved: true`; finally flip to story + cast via the DB seeder harness.
TEXT="A host greets the audience from a neon city street at night. But the lights are lying to you, and tonight we prove it."
curl -s -o /dev/null -b "$JAR" -X POST "$BASE/api/videos/analyze-script" \
  -H 'Content-Type: application/json' \
  -d "{\"scriptText\":\"$TEXT\"}"
CREATE=$(curl -s -b "$JAR" -X POST "$BASE/api/videos" \
  -H 'Content-Type: application/json' \
  -d "{\"topic\":\"Smoke director test\",\"niche\":\"test\",\"format\":\"script\",\"script\":\"custom\",\"scriptText\":\"$TEXT\",\"approved\":true}")
VID=$(echo "$CREATE" | python3 -c 'import sys,json; print(json.load(sys.stdin)["video"]["id"])' 2>/dev/null || true)
echo "[smoke] video → $VID"
[ -n "$VID" ] && [ "$VID" != "None" ] || { echo "[smoke] FAIL: no video id: $CREATE"; exit 1; }
node scripts/seed-director-smoke.mjs "$VID" >/dev/null || { echo "[smoke] FAIL: seeder"; exit 1; }

# 4. GET — empty plan state.
BODY=$(curl -s -b "$JAR" "$BASE/api/videos/$VID/director")
STATE=$(echo "$BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("state"), d.get("plan"), d.get("generating"))' 2>/dev/null)
expect "GET empty director state" "None None {'plan': False, 'check': False}" "$STATE"

# 5. POST check — video has a cast scene → accepted (job starts, then fails
#    fast with a visible provider error; acceptance shape is what we pin).
CODE=$(curl -s -o /tmp/tf-check.json -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/videos/$VID/director" \
  -H 'Content-Type: application/json' -d '{"action":"check"}')
expect "POST continuity accepted" "202" "$CODE"

# 6. PATCH approve without a plan → 400.
CODE=$(curl -s -o /tmp/tf-approve.json -w '%{http_code}' -b "$JAR" -X PATCH "$BASE/api/videos/$VID/director" \
  -H 'Content-Type: application/json' -d '{"action":"approve"}')
expect "PATCH approve without plan" "400" "$CODE"

# 7. PATCH reset without a plan → 200 (reset is always legal).
CODE=$(curl -s -o /tmp/tf-reset.json -w '%{http_code}' -b "$JAR" -X PATCH "$BASE/api/videos/$VID/director" \
  -H 'Content-Type: application/json' -d '{"action":"reset"}')
expect "PATCH reset without plan" "200" "$CODE"

# 8. Unauthenticated GET → 401.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/videos/$VID/director")
expect "unauthenticated GET" "401" "$CODE"

# 9. Cross-tenant GET → 404 (other account must not see this video).
JAR2=/tmp/tf-director-cookies2.txt; rm -f "$JAR2"
curl -s -o /dev/null -c "$JAR2" -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"director-smoke2-$RANDOM@example.com\",\"password\":\"Smoke-Director-2026!\"}"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" "$BASE/api/videos/$VID/director")
expect "cross-tenant GET" "404" "$CODE"

# 10. Cleanup the video, kill the server.
curl -s -o /dev/null -b "$JAR" -X DELETE "$BASE/api/videos/$VID"
kill "$(lsof -ti ":$PORT")" 2>/dev/null
echo "[smoke] done (fail=$fail)"
exit $fail
