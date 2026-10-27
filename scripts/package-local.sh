#!/usr/bin/env bash
# Rebuild the portable TubeForge local-run package from the live source tree.
# Usage: bash scripts/package-local.sh
# Output: /home/z/my-project/download/tubeforge-local.zip
#
# SECURITY (2025-10 hardening pass):
#   - Does NOT ship the live database (it contains provider API keys + OAuth
#     tokens + private records). Fresh installs run `npm run setup` on first
#     boot via the documented setup step instead.
#   - Does NOT ship .env / .z-ai-config / uploads — those are runtime secrets/data.
#   - Ships bun.lock for reproducible installs.
#   - Ships a per-package TUBEFORGE_AUTH_SECRET so the owner can turn the lock
#     on from Settings → Studio access without editing .env (lock is OPT-IN —
#     the studio is open by default).

set -euo pipefail

ROOT="/home/z/my-project"
STAGE="$ROOT/pack/tubeforge"
OUT="$ROOT/download/tubeforge-local.zip"

echo "==> Cleaning previous staging + output"
rm -rf "$ROOT/pack"
mkdir -p "$STAGE" "$ROOT/download"
rm -f "$OUT"

echo "==> Copying source, prisma, public, configs (NO db, NO uploads, NO .env)"
rsync -a "$ROOT/src/"          "$STAGE/src/"
rsync -a "$ROOT/prisma/"       "$STAGE/prisma/"
rsync -a "$ROOT/public/"       "$STAGE/public/"
mkdir -p "$STAGE/scripts"
# Ship only the runtime helpers a local owner needs (backup + lock recovery).
# Test/verify suites stay out — they assume bun + the sandbox environment.
cp "$ROOT/scripts/backup.sh" "$STAGE/scripts/backup.sh" 2>/dev/null || true
cp "$ROOT/scripts/auth-reset.mjs" "$STAGE/scripts/auth-reset.mjs"
# Empty db folder so prisma's relative `file:../db/custom.db` resolves on first setup
mkdir -p "$STAGE/db"
touch "$STAGE/db/.gitkeep"
for f in next.config.ts tsconfig.json tailwind.config.ts postcss.config.mjs \
         components.json eslint.config.mjs .gitignore SECURITY.md; do
  cp "$ROOT/$f" "$STAGE/" 2>/dev/null || true
done

echo "==> Copying lockfile for reproducible installs"
cp "$ROOT/bun.lock" "$STAGE/bun.lock"

echo "==> Writing portable package.json (verbatim deps, cross-platform scripts)"
node -e '
const fs = require("fs");
const orig = JSON.parse(fs.readFileSync("'"$ROOT"'/package.json", "utf8"));
orig.name = "tubeforge";
orig.version = "1.0.0";
orig.scripts = {
  dev: "next dev -p 3000",
  "dev:lan": "next dev -p 3000 -H 0.0.0.0",
  build: "next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/",
  start: "NODE_ENV=production node .next/standalone/server.js",
  lint: "eslint .",
  typecheck: "tsc --noEmit",
  postinstall: "prisma generate",
  setup: "prisma db push",
  backup: "bash scripts/backup.sh",
  "auth:reset": "node scripts/auth-reset.mjs",
  "db:push": "prisma db push --accept-data-loss",
  "db:generate": "prisma generate",
  "db:migrate": "prisma migrate dev",
  "db:reset": "prisma migrate reset",
};
fs.writeFileSync("'"$STAGE"'/package.json", JSON.stringify(orig, null, 2) + "\n");
'

echo "==> Writing .env (relative SQLite path + fresh auth secret)"
SECRET=$(openssl rand -hex 32)
printf 'DATABASE_URL=file:../db/custom.db\nTUBEFORGE_AUTH_SECRET=%s\n' "$SECRET" > "$STAGE/.env"
printf 'DATABASE_URL=file:../db/custom.db\n# Generate your own secret: openssl rand -hex 32\nTUBEFORGE_AUTH_SECRET=\n' > "$STAGE/.env.example"
cat > "$STAGE/.z-ai-config.example" << 'EOF'
{
  "baseUrl": "https://api.z.ai/api/paas/v4",
  "apiKey": "PASTE_YOUR_ZAI_API_KEY_HERE"
}
EOF

echo "==> Copying SETUP.md"
cp "$ROOT/scripts/SETUP-local.md" "$STAGE/SETUP.md" 2>/dev/null || true

echo "==> Zipping"
cd "$ROOT/pack"
zip -rq "$OUT" tubeforge -x "*/.next/*" "*/node_modules/*"

echo "==> Verifying: no secrets in the package"
# The packaged .env intentionally ships a FRESH auth secret + relative db path.
# What must NEVER be inside: the live database, uploads, or THIS machine's secrets.
LIVE_SECRET=$(grep -o 'TUBEFORGE_AUTH_SECRET=.*' "$ROOT/.env" | cut -d= -f2)
if unzip -p "$OUT" tubeforge/.env | grep -q "$LIVE_SECRET"; then
  echo "!!! SECURITY CHECK FAILED — live auth secret leaked into package !!!" >&2
  exit 1
fi
if unzip -l "$OUT" | grep -E "custom\.db|uploads/" | grep -v ".env.example"; then
  echo "!!! SECURITY CHECK FAILED — live database or uploads found in package !!!" >&2
  exit 1
fi
echo "secret scan OK (no live db / uploads / live secret inside — fresh secret generated)"
unzip -t "$OUT" > /dev/null && echo "zip integrity OK"
ls -lh "$OUT"
unzip -l "$OUT" | tail -2
echo "==> DONE: $OUT"
