#!/usr/bin/env bash
# Stage 5 (T-5.7) — live API smoke of research-with-sources.
# Boots a fresh dev server, registers a throwaway account, creates a video
# with attached research sources, and verifies the DTO roundtrip + validation.
set -u
cd /home/z/my-project
PORT=3111
BASE="http://localhost:$PORT"

fail=0
expect() { # expect <label> <want> <actual>
  if [ "$3" = "$2" ]; then echo "[smoke] ✓ $1 ($2)"; else echo "[smoke] ✗ $1: expected $2, got $3"; fail=1; fi
}

pkill -f "next dev -p $PORT" 2>/dev/null; sleep 1; true
PORT="$PORT" nohup python3 scripts/daemonize.py /tmp/tf-sources-smoke.log npm exec -- next dev -p "$PORT" -H 0.0.0.0 >/dev/null 2>&1 &
echo "[smoke] booting dev server on :$PORT…"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "$BASE/login"; then break; fi
  sleep 2
done
curl -sf -o /dev/null "$BASE/login" || { echo "[smoke] FAIL: server never came up"; exit 1; }
echo "[smoke] server up"

EMAIL="sources-smoke-$RANDOM@example.com"
JAR=/tmp/tf-sources-cookies.txt
rm -f "$JAR"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Smoke-Sources-2026!\"}")
expect "register" "201" "$CODE"

# 1. Create a classic video WITH research sources (https only, ≤6).
CODE=$(curl -s -o /tmp/tf-src-create.json -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/videos" \
  -H 'Content-Type: application/json' \
  -d '{"topic":"Why Roman concrete outlasts modern concrete","script":"Romans built to last.","approved":true,"researchSources":[{"url":"https://example.com/roman-concrete","name":"Roman concrete study","host":"example.com"},{"url":"https://nature.com/articles/mortar","name":"Hot mixing mortar paper","host":"nature.com"}]}')
expect "create with sources" "202" "$CODE"
VID=$(python3 -c "import json;print(json.load(open('/tmp/tf-src-create.json'))['video']['id'])" 2>/dev/null)

# 2. DTO roundtrip: the sources survive serialization (only http(s)).
COUNT=$(curl -s -b "$JAR" "$BASE/api/videos/$VID" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('video',{}).get('researchSources',[])))" 2>/dev/null)
expect "sources roundtrip (2)" "2" "$COUNT"

# 3. Validation: junk URLs are dropped, not stored.
CODE=$(curl -s -o /tmp/tf-src2.json -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/videos" \
  -H 'Content-Type: application/json' \
  -d '{"topic":"Junk sources test","script":"Junk test body.","approved":true,"researchSources":[{"url":"javascript:alert(1)","name":"evil"},{"url":"https://good.example.com/x","name":"good one","host":"good.example.com"}]}')
expect "create with mixed sources" "202" "$CODE"
VID2=$(python3 -c "import json;print(json.load(open('/tmp/tf-src2.json'))['video']['id'])" 2>/dev/null)
COUNT=$(curl -s -b "$JAR" "$BASE/api/videos/$VID2" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('video',{}).get('researchSources',[])))" 2>/dev/null)
expect "junk URL dropped, good kept (1)" "1" "$COUNT"

# 4. Legacy videos (no sources) → empty array, never null/undefined.
CODE=$(curl -s -o /tmp/tf-src3.json -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/videos" \
  -H 'Content-Type: application/json' \
  -d '{"topic":"No sources here","script":"Plain video.","approved":true}')
VID3=$(python3 -c "import json;print(json.load(open('/tmp/tf-src3.json'))['video']['id'])" 2>/dev/null)
SHAPE=$(curl -s -b "$JAR" "$BASE/api/videos/$VID3" | python3 -c "import json,sys;d=json.load(sys.stdin).get('video',{}).get('researchSources');print('empty-array' if d==[] else 'missing')" 2>/dev/null)
expect "no sources → empty array" "empty-array" "$SHAPE"

echo ""
if [ "$fail" = "0" ]; then echo "[smoke] ALL PASS"; else echo "[smoke] FAILURES PRESENT"; fi
pkill -f "next dev -p $PORT" 2>/dev/null; true
exit $fail
