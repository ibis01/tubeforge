#!/usr/bin/env bash
# Stage 3 live smoke (T-3.5): the full HTTP → queue → handler path.
# Registers a probe account, kicks an AI script job via POST /api/videos,
# then watches the Job row transition pending → running → done and the video
# land "scripted". Proves the durable queue executes real work end-to-end.
set -u
BASE="http://localhost:3000"
RUN="q$(date +%s)"

JAR=$(mktemp)
echo "── register probe $RUN"
curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Queue Smoke\",\"email\":\"$RUN@tubeforge.test\",\"password\":\"queue-smoke-123\"}" > /tmp/reg.json
VERIFY_URL=$(python3 -c "import json;print(json.load(open('/tmp/reg.json')).get('verification',{}).get('url',''))")
[ -n "$VERIFY_URL" ] && curl -s -o /dev/null "$VERIFY_URL"
echo "   registered + verified"

echo "── POST /api/videos (AI path — must be 202, non-blocking)"
T0=$(date +%s%N)
HTTP=$(curl -s -o /tmp/create.json -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/videos" -H 'Content-Type: application/json' \
  -d "{\"topic\":\"Queue smoke $RUN\",\"niche\":\"Motivation\",\"format\":\"script\"}")
T1=$(date +%s%N)
echo "   HTTP $HTTP in $(( (T1-T0)/1000000 )) ms"
VID=$(python3 -c "import json;d=json.load(open('/tmp/create.json'));print(d.get('video',{}).get('id') or d.get('videoId') or '')")
echo "   videoId=$VID"

echo "── poll video + job rows (queue transitions)"
for i in $(seq 1 40); do
  sleep 3
  STATUS=$(curl -s -b "$JAR" "$BASE/api/videos/$VID" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status','?'))" 2>/dev/null || echo "?")
  JOB=$(node --input-type=module -e "
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const rows = await p.job.findMany({ where: { entityId: process.argv[1] }, orderBy: { startedAt: 'desc' }, select: { kind: true, status: true, claimedBy: true, attempts: true, error: true } });
console.log(JSON.stringify(rows));
await p.\$disconnect();
" "$VID" 2>/dev/null)
  echo "   t+$((i*3))s status=$STATUS jobs=$JOB"
  case "$STATUS" in scripted|error|failed) break;; esac
done

echo "── result"
curl -s -b "$JAR" "$BASE/api/videos/$VID" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print('   status:', d.get('status'))
print('   error :', (d.get('error') or 'none')[:120])
print('   script:', ('yes, ' + str(len(d.get('script') or '')) + ' chars') if d.get('script') else 'none')
"
