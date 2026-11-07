#!/bin/bash
# S54 autowatch — the self-healing watcher for the owed benchmark legs
# (T-54.3: §A podcast + islamic-history, §B the real-render matrix).
#
# Survives sandbox recycling: given only S54_GIT_PAT in the environment, this
# script re-clones the repo, writes a fresh .env, installs dependencies and
# sets up the DB — then probes the gateway pool ONCE and, only if the pool
# opened (remaining-daily >= 20 or a 200), runs the owed legs stage-gated on
# the durable state (docs/baselines/s54-genre-benchmark-state.json — replace
# semantics per profile; a killed run loses nothing).
#
# Usage:
#   S54_GIT_PAT=<pat> bash scripts/s54-autowatch.sh           # probe + legs
#   S54_GIT_PAT=<pat> S54_WATCH=check bash scripts/s54-autowatch.sh  # env check only
#
# Laws (docs/audits/s54-gateway-quota-forensics.md): probe at most once per
# invocation; never race reset epochs; the POOL counter (remaining-daily), not
# the user counter, is the launch signal. The PAT is never written to disk.
set -u

REPO=/home/z/my-project/work/tf
STATE="$REPO/docs/baselines/s54-genre-benchmark-state.json"
MODE="${S54_WATCH:-probe}"

# ---------- self-heal: repo ----------
if [ ! -d "$REPO/.git" ]; then
  if [ -z "${S54_GIT_PAT:-}" ]; then
    echo "HEAL FAILED: repo missing and S54_GIT_PAT unset"; exit 2
  fi
  echo "== healing: re-cloning the repo =="
  mkdir -p /home/z/my-project/work
  git clone "https://${S54_GIT_PAT}@github.com/ibis01/tubeforge.git" "$REPO" 2>&1 | tail -1
fi
cd "$REPO" || exit 2

# ---------- self-heal: env + deps ----------
if [ ! -f .env ] || [ ! -d node_modules ] || [ ! -d node_modules/.prisma/client ]; then
  echo "== healing: env + dependencies =="
  python3 - << 'PY'
import secrets
env = (
    "DATABASE_URL=file:./db/custom.db\n"
    f"TUBEFORGE_AUTH_SECRET={secrets.token_hex(24)}\n"
    f"TUBEFORGE_ENCRYPTION_KEY={secrets.token_hex(32)}\n"
    "TUBEFORGE_EMAIL_MODE=console\n"
)
open(".env", "w").write(env)
PY
  chmod 600 .env
  npm ci --no-audit --no-fund 2>&1 | tail -1
  npm run setup:local 2>&1 | tail -1
fi

# ---------- check mode: prerequisites only, no probe ----------
if [ "$MODE" = "check" ]; then
  node --import tsx -e "
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
p.user.count().then(async (c) => { console.log('check: DB OK, users:', c); await p.\$disconnect(); })
 .catch((e) => { console.error('check: DB FAIL', String(e).slice(0, 120)); process.exit(1); });
" || exit 2
  python3 -c "import json; s=json.load(open('$STATE')); print('check: state rows =', len(s.get('runRows',[])), '· legB =', bool(s.get('legB')))"
  echo "check: ALL PREREQUISITES OK"
  exit 0
fi

# ---------- single probe ----------
PROBE=$(python3 << 'PY'
import json, subprocess
cfg = json.load(open('/etc/.z-ai-config'))
body = json.dumps({"messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":10,"thinking":{"type":"disabled"}})
h = ["-H","Content-Type: application/json","-H",f"Authorization: Bearer {cfg['apiKey']}","-H","X-Z-AI-From: Z"]
if cfg.get("chatId"): h += ["-H",f"X-Chat-Id: {cfg['chatId']}"]
if cfg.get("userId"): h += ["-H",f"X-User-Id: {cfg['userId']}"]
if cfg.get("token"):  h += ["-H",f"X-Token: {cfg['token']}"]
try:
    r = subprocess.run(["curl","-s","-i","-m","30","https://internal-api.z.ai/v1/chat/completions",*h,"-d",body],capture_output=True,text=True)
    tags = {}
    for line in r.stdout.splitlines():
        if ":" in line:
            k,v = line.split(":",1); tags[k.strip().lower()] = v.strip()
    status = "200" if '"content"' in r.stdout else (tags.get("http/2","?").split()[-1] if "http/2" in tags else "?")
    pool = tags.get("x-ratelimit-remaining-daily", "999" if status == "200" else "-1")
    user = tags.get("x-ratelimit-user-daily-remaining", "?")
    print(f"{status} {pool} {user}")
except Exception as e:
    print("? -1 ?")
PY
)
read STATUS POOL USERD <<< "$PROBE"
echo "probe: status=$STATUS poolRemaining=$POOL userDaily=$USERD  ($(date -u))"

if [ "$STATUS" != "200" ] && [ "${POOL:-0}" -lt 20 ] 2>/dev/null; then
  echo "STILL SATURATED"
  exit 0
fi

# ---------- pool open: run the owed chain, stage-gated on state ----------
OWE_A=$(python3 -c "
import json
s=json.load(open('$STATE'))
have={r['profile'] for r in s.get('runRows',[])}
print('yes' if not {'podcast','islamic-history'} <= have else 'no')
")
OWE_B=$(python3 -c "
import json
s=json.load(open('$STATE'))
print('no' if s.get('legB') else 'yes')
")

if [ "$OWE_A" = "yes" ]; then
  echo "=== launching §A chunk (podcast, islamic-history) ==="
  S54_LEG=A S54_PROFILES=podcast,islamic-history node --import tsx scripts/s54-genre-benchmark.mts 2>&1 | tail -12
fi

if [ "$OWE_B" = "yes" ]; then
  echo "=== launching §B leg (real render + matrix) ==="
  S54_LEG=B node --import tsx scripts/s54-genre-benchmark.mts 2>&1 | tail -16
fi

python3 -c "
import json
s=json.load(open('$STATE'))
have={r['profile'] for r in s.get('runRows',[])}
oweA = not {'podcast','islamic-history'} <= have
oweB = not s.get('legB')
print(f'state: rows={len(s.get(\"runRows\",[]))} oweA={oweA} oweB={oweB}')
if not oweA and not oweB:
    print('ALL LEGS LANDED — run S54_LEG=report next')
"
