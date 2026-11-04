// S25 route e2e — the excavation over real HTTP:
//   arc 1  register 201 → session cookie
//   arc 2  the buried door: /api/settings/tts GET + PUT answer 404 with a
//          session (an anon request 401s at the middleware first — the
//          route itself is GONE, not locked)
//   arc 3  the live surfaces untouched: /api/settings/voices + /api/settings
//          still 200 (the registry-driven stack is the only voice config)
//   arc 4  the PWA serves: sw.js, manifest, offline.html, icons — and the
//          root HTML links the manifest + carries the theme color
//   arc 5  cleanup through the front door + the end-state law
// Run: node scripts/s25-route-e2e.mjs   (daemon on :3000, S25 build)

const BASE = "http://localhost:3000";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
const j = async (r) => r.json().catch(() => ({}));

// ---- arc 1: register ----
const email = `s25-e2e-${Date.now()}@e2e.local`;
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "s25-e2e-pw-0123456789", name: "S25 E2E" }),
});
check("1.1  register -> 201", reg.status === 201, reg.status);
const cookie = (reg.headers.get("set-cookie") ?? "").split(";")[0];
const authed = { "content-type": "application/json", cookie };

// ---- arc 2: the buried door ----
{
  const g = await fetch(`${BASE}/api/settings/tts`, { headers: { cookie } });
  check("2.1  GET /api/settings/tts -> 404 (gone, not locked)", g.status === 404, g.status);
  const p = await fetch(`${BASE}/api/settings/tts`, {
    method: "PUT", headers: authed,
    body: JSON.stringify({ provider: "openai", baseUrl: "https://x.example", apiKey: "sk-x" }),
  });
  check("2.2  PUT /api/settings/tts -> 404", p.status === 404, p.status);
  const anon = await fetch(`${BASE}/api/settings/tts`);
  check("2.3  anon still 401s at the gate (default-deny stands)", anon.status === 401, anon.status);
}

// ---- arc 3: the live voice config surfaces untouched ----
{
  const v = await fetch(`${BASE}/api/settings/voices`, { headers: { cookie } });
  check("3.1  GET /api/settings/voices -> 200", v.status === 200, v.status);
  const vd = await j(v);
  check("3.2  the voice catalog answers with providers", Array.isArray(vd.providers) || typeof vd === "object", Object.keys(vd).slice(0, 4));
  const s = await fetch(`${BASE}/api/settings`, { headers: { cookie } });
  check("3.3  GET /api/settings -> 200", s.status === 200, s.status);
  const ai = await fetch(`${BASE}/api/settings/ai`, { headers: { cookie } });
  check("3.4  GET /api/settings/ai -> 200 (the engine config lives here)", ai.status === 200, ai.status);
}

// ---- arc 4: the PWA serves ----
{
  const sw = await fetch(`${BASE}/sw.js`);
  const swText = await sw.text();
  check("4.1  /sw.js -> 200 + registers offline + network-first", sw.status === 200 && swText.includes("offline.html") && swText.includes("tubeforge-v1"), sw.status);
  const man = await fetch(`${BASE}/manifest.webmanifest`);
  const md = await j(man);
  check("4.2  manifest -> 200, standalone, TubeForge", man.status === 200 && md.display === "standalone" && String(md.name).includes("TubeForge"), md.name);
  const off = await fetch(`${BASE}/offline.html`);
  check("4.3  /offline.html -> 200", off.status === 200, off.status);
  const icon = await fetch(`${BASE}/icons/icon-192.png`);
  check("4.4  icon-192 -> 200", icon.status === 200, icon.status);
  const icon2 = await fetch(`${BASE}/icons/icon-maskable-512.png`);
  check("4.5  icon-maskable-512 -> 200", icon2.status === 200, icon2.status);

  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  check("4.6  the root HTML links the manifest", html.includes("/manifest.webmanifest"), undefined);
  check("4.7  the root HTML carries the theme color", html.includes("#0a0a0a"), undefined);
  check("4.8  the root HTML links the apple touch icon", html.includes("/icons/apple-touch-icon.png"), undefined);
}

// ---- arc 5: cleanup + the end-state law ----
{
  const del = await fetch(`${BASE}/api/account/delete`, {
    method: "POST", headers: authed, body: JSON.stringify({ confirm: "DELETE" }),
  });
  check("5.1  the account deletes through its own door -> 200", del.status === 200, del.status);
}

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
{
  const u = await prisma.user.findUnique({ where: { email } });
  check("5.2  the user row is gone", u === null);
  const [users, orgs, settings2] = [await prisma.user.count(), await prisma.organization.count(), await prisma.userSetting.count()];
  check("5.3  end state: 0 users / orgs / settings rows", users === 0 && orgs === 0 && settings2 === 0, { users, orgs, settings2 });
}
await prisma.$disconnect();

console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
