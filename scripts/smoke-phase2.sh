#!/bin/bash
# TubeForge Phase 2 — API smoke tests
set -e
BASE=http://localhost:3000

echo "== 1. Schedule CRUD =="
NEW=$(curl -s -X POST $BASE/api/schedule -H "Content-Type: application/json" \
  -d '{"slotDate":"2026-10-27","timeOfDay":"09:00","title":"API smoke test slot","note":"curl test"}')
SID=$(echo "$NEW" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['slot']['id']); " )
echo "$NEW" | python3 -c "import json,sys; d=json.load(sys.stdin); print('POST OK:', d['slot']['title'], '@', d['slot']['slotDate'][:10])"

curl -s -X PATCH $BASE/api/schedule/$SID -H "Content-Type: application/json" -d '{"done":true}' \
  | python3 -c "import json,sys; print('PATCH OK: done =', json.load(sys.stdin)['slot']['done'])"

curl -s -X DELETE $BASE/api/schedule/$SID | python3 -c "import json,sys; print('DELETE OK:', json.load(sys.stdin)['ok'])"

echo "== 2. Research (live GLM, may take ~20s) =="
curl -s --max-time 90 -X POST $BASE/api/research -H "Content-Type: application/json" \
  -d '{"niche":"Finance","query":"money psychology"}' > /tmp/research.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/research.json'))
s = d['session']
print('RESEARCH OK:', s['niche'], '/', s['query'], '—', len(s['ideas']), 'ideas')
print('  summary:', s['nicheSummary'][:90], '...')
for i in s['ideas'][:3]:
    print(f"  - [{i['viralScore']}] {i['title'][:55]} ({i['searchVolume']} vol / {i['competition']} comp / {i['suggestedLength']})")
EOF

echo "== 3. Export ZIP =="
VID=cmvlxkw9k0001vqxa2627qyl5
curl -s --max-time 60 $BASE/api/videos/$VID/export -o /tmp/package.zip
python3 - <<'EOF'
import zipfile
z = zipfile.ZipFile('/tmp/package.zip')
bad = z.testzip()
print('ZIP OK, corrupt entry:', bad)
for n in z.namelist(): print('  -', n, f'({z.getinfo(n).file_size} bytes)')
meta = z.read([n for n in z.namelist() if n.endswith('upload-metadata.txt')][0]).decode()
print('  metadata preview:', meta.splitlines()[0][:70])
EOF

echo "== 4. Variants (GET, initially empty) =="
curl -s $BASE/api/videos/$VID/variants | python3 -c "import json,sys; print('VARIANTS OK:', json.load(sys.stdin)['variants'])"

echo "== 5. Schedule range GET =="
curl -s "$BASE/api/schedule?from=2026-10-01&to=2026-11-30" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('RANGE OK:', len(d['slots']), 'slots,', len(d['schedulable']), 'schedulable videos')"

echo "ALL SMOKE TESTS DONE"
