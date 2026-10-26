#!/usr/bin/env bash
# Rebuild the portable TubeForge local-run package from the live source tree.
# Usage: bash scripts/package-local.sh
# Output: /home/z/my-project/download/tubeforge-local.zip
set -euo pipefail

ROOT="/home/z/my-project"
STAGE="$ROOT/pack/tubeforge"
OUT="$ROOT/download/tubeforge-local.zip"

echo "==> Cleaning previous staging + output"
rm -rf "$ROOT/pack"
mkdir -p "$STAGE" "$ROOT/download"
rm -f "$OUT"

echo "==> Copying source, prisma, public, db, configs"
rsync -a "$ROOT/src/"          "$STAGE/src/"
rsync -a "$ROOT/prisma/"       "$STAGE/prisma/"
rsync -a "$ROOT/public/"       "$STAGE/public/"
mkdir -p "$STAGE/db" "$STAGE/scripts"
cp "$ROOT/db/custom.db" "$STAGE/db/custom.db"
# small diagnostic/test scripts only (no PNG artifacts)
find "$ROOT/scripts" -maxdepth 1 \( -name '*.cjs' -o -name '*.mjs' \) -exec cp {} "$STAGE/scripts/" \;
for f in next.config.ts tsconfig.json tailwind.config.ts postcss.config.mjs \
         components.json eslint.config.mjs .gitignore; do
  cp "$ROOT/$f" "$STAGE/" 2>/dev/null || true
done

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
  postinstall: "prisma generate",
  "db:push": "prisma db push --accept-data-loss",
  "db:generate": "prisma generate",
  "db:migrate": "prisma migrate dev",
  "db:reset": "prisma migrate reset",
};
fs.writeFileSync("'"$STAGE"'/package.json", JSON.stringify(orig, null, 2) + "\n");
'

echo "==> Writing .env (relative SQLite path) + SDK config template"
printf 'DATABASE_URL=file:../db/custom.db\n' > "$STAGE/.env"
printf 'DATABASE_URL=file:../db/custom.db\n' > "$STAGE/.env.example"
cat > "$STAGE/.z-ai-config.example" << 'EOF'
{
  "baseUrl": "https://api.z.ai/api/paas/v4",
  "apiKey": "PASTE_YOUR_ZAI_API_KEY_HERE"
}
EOF

echo "==> Copying SETUP.md"
cp "$ROOT/scripts/SETUP-local.md" "$STAGE/SETUP.md"

echo "==> Zipping"
cd "$ROOT/pack"
zip -rq "$OUT" tubeforge -x "*/.next/*" "*/node_modules/*"

echo "==> Verifying"
unzip -t "$OUT" > /dev/null && echo "zip integrity OK"
ls -lh "$OUT"
unzip -l "$OUT" | tail -2
unzip -l "$OUT" | grep -E "SETUP.md|z-ai-config|custom.db|schema.prisma|settings/ai|zai-config.ts" || true
echo "==> DONE: $OUT"
