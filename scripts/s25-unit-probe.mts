// S25 unit probe — "the excavation": two fossil finds, two different laws.
//
// FIND 1 — the buried pair. /api/settings/tts + src/lib/tubeforge/tts.ts
// were each other's ONLY consumer since the registry-driven voice stack
// (providers/tts.ts + the /api/settings/ai card) superseded them: a config
// surface nobody opened, writing preference rows nobody read. S25 buries
// both and stops the claim flow from migrating the dead preference rows
// (ttsProvider/ttsBaseUrl/ttsModel/ttsVoice) into UserSetting — while the
// LIVE half of the legacy TTS claim (the API key → ProviderCredential
//("tts"), read by providers/tts.ts at synthesis time) keeps working.
//   THE CLAIM LAW — a legacy install's TTS key still lands in the
//   credential vault; the dead preference rows are consumed, not migrated;
//   ordinary verbatim rows still pass through; the legacy table is dropped.
//
// FIND 2 — the PWA. sw.js + manifest + icons + three components sat in the
// tree since day one with NOTHING mounting them (git: never imported, not
// even once). S25 wires them: layout mounts ServiceWorkerRegister, the
// metadata links the manifest, the Settings page gets the install card.
// The HTTP half of that law is the route e2e's job; this probe pins the
// component contract (the exports the layout and the card consume).
// Run: node --import tsx scripts/s25-unit-probe.mts

process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { claimLegacyForOwner, pendingLegacyRows } from "../src/lib/tubeforge/claim";
import { decryptSecret } from "../src/lib/tubeforge/crypto";
import { hashPassword } from "../src/lib/tubeforge/tenant";

const prisma = new PrismaClient();
// S28 — the studio has a REAL tenant now (the owner's account lives in
// this DB): teardown asserts NOTHING-BEHIND against the starting baseline.
const __BASELINE = { users: await prisma.user.count(), orgs: await prisma.organization.count() };
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// =====================================================================
// 1. the buried pair stays buried
// =====================================================================
{
  const routeGone = !fs.existsSync("src/app/api/settings/tts/route.ts");
  const libGone = !fs.existsSync("src/lib/tubeforge/tts.ts");
  check("1.1  /api/settings/tts is buried", routeGone);
  check("1.2  the legacy tts module is buried", libGone);
  // ...and nothing ressurects it: no source file imports the old module.
  const src = fs.readdirSync("src/lib/tubeforge").filter((f) => f.endsWith(".ts"));
  const routeFiles: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${f.name}`;
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".ts") || f.name.endsWith(".tsx")) routeFiles.push(p);
    }
  };
  walk("src/app");
  const offenders = [...src.map((f) => `src/lib/tubeforge/${f}`), ...routeFiles].filter((f) =>
    fs.readFileSync(f, "utf8").includes('tubeforge/tts"')
  );
  check("1.3  no source file imports the buried module", offenders.length === 0, offenders);
}

// =====================================================================
// 2. the claim law — the live half survives, the dead half stops
// =====================================================================
{
  // a legacy install parks its rows in an unmanaged LegacySetting table
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "LegacySetting" (key TEXT PRIMARY KEY, value TEXT)`
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "LegacySetting"`);
  const seed: [string, string][] = [
    ["ttsProvider", "openai"],
    ["ttsBaseUrl", "https://legacy-tts.example.com/v1"],
    ["ttsModel", "tts-1"],
    ["ttsVoice", "alloy"],
    ["ttsApiKey", "sk-legacy-tts-key-0123456789"],
    ["music.volume", "0.3"],
    ["quality.default", "1080p"],
  ];
  for (const [k, v] of seed)
    await prisma.$executeRawUnsafe(
      `INSERT INTO "LegacySetting" (key, value) VALUES ('${k}', '${v}')`
    );

  const pending = await pendingLegacyRows();
  check("2.1  the legacy rows are pending", pending.total === seed.length, pending);

  const org = await prisma.organization.create({ data: { name: "S25 Probe Org", slug: `s25-probe-${suffix}` } });
  const user = await prisma.user.create({
    data: {
      email: `s25-probe-${suffix}@probe.local`,
      passwordHash: await hashPassword("probe-pw-0123456789"),
      name: "S25 Probe",
    },
  });
  await prisma.membership.create({ data: { userId: user.id, organizationId: org.id, role: "owner" } });

  const result = await claimLegacyForOwner(user.id);
  check("2.2  the claim lands", result.claimed === true && result.rowsMigrated === seed.length, result);

  // the LIVE half: the key reaches the credential vault, encrypted
  const cred = await prisma.providerCredential.findUnique({
    where: { userId_capability_provider: { userId: user.id, capability: "tts", provider: "openai" } },
  });
  check("2.3  the TTS key migrates into the vault", cred !== null, cred);
  if (cred) {
    const plain = decryptSecret(cred.apiKey);
    check("2.4  the key decrypts to what the legacy install saved", plain === "sk-legacy-tts-key-0123456789");
    check("2.5  the credential carries the legacy baseUrl", cred.baseUrl === "https://legacy-tts.example.com/v1", cred.baseUrl);
  }

  // the DEAD half: the preference rows are consumed, NOT migrated
  const settings = await prisma.userSetting.findMany({ where: { userId: user.id }, select: { key: true } });
  const keys = settings.map((s) => s.key);
  check("2.6  no dead tts preference rows in UserSetting",
    !keys.includes("ttsProvider") && !keys.includes("ttsBaseUrl") && !keys.includes("ttsModel") && !keys.includes("ttsVoice"), keys);

  // verbatim rows still pass through
  check("2.7  ordinary rows still migrate verbatim", keys.includes("music.volume") && keys.includes("quality.default"), keys);

  // the table lifecycle closes
  const after = await prisma.$queryRaw<{ name: string }[]>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'LegacySetting'`;
  check("2.8  LegacySetting is dropped after the claim", after.length === 0, after);

  // ---- cleanup ----
  await prisma.providerCredential.deleteMany({ where: { userId: user.id } });
  await prisma.userSetting.deleteMany({ where: { userId: user.id } });
  await prisma.membership.deleteMany({ where: { userId: user.id } });
  await prisma.session.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
}

// =====================================================================
// 3. the PWA contract — the exports the wiring consumes
// =====================================================================
{
  const src = fs.readFileSync("src/components/tubeforge/pwa.tsx", "utf8");
  check("3.1  ServiceWorkerRegister registers /sw.js", src.includes('navigator.serviceWorker.register("/sw.js")'));
  check("3.2  the install button waits for beforeinstallprompt", src.includes("beforeinstallprompt"));
  check("3.3  the manual A2HS hint ships (iOS/Firefox path)", src.includes("ManualInstallHint"));

  const layout = fs.readFileSync("src/app/layout.tsx", "utf8");
  check("3.4  the layout mounts the registrar", layout.includes("<ServiceWorkerRegister />"));
  check("3.5  the metadata links the manifest", layout.includes('manifest: "/manifest.webmanifest"'));
  check("3.6  the theme color rides the viewport export", layout.includes('themeColor: "#0a0a0a"'));

  const settings = fs.readFileSync("src/components/tubeforge/views/settings-view.tsx", "utf8");
  check("3.7  the Settings page mounts the install card", settings.includes("<InstallAppButton />") && settings.includes("<ManualInstallHint />"));

  // the assets the SW precaches exist
  check("3.8  sw.js exists", fs.existsSync("public/sw.js"));
  check("3.9  offline.html exists", fs.existsSync("public/offline.html"));
  check("3.10 the manifest + icons exist",
    fs.existsSync("public/manifest.webmanifest") && fs.existsSync("public/icons/icon-192.png") && fs.existsSync("public/icons/icon-512.png"));
}

// =====================================================================
// teardown — the end-state law
// =====================================================================
await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "LegacySetting"`).catch(() => {});
const [ul, ol] = [await prisma.user.count(), await prisma.organization.count()];
check("teardown  nothing behind (users/orgs back to baseline)", ul === __BASELINE.users && ol === __BASELINE.orgs, { ul, ol, __BASELINE });

console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : failures + " FAILURES"}`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
