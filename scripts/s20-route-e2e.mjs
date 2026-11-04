// S20 route e2e — "the keyring" against the running daemon. The mint route
// existed since Stage 2 with no caller and no revocation; this walks the
// whole console arc a user actually experiences:
//   register (fresh door) → list (empty) → mint with a label → the one-time
//   reveal → the list shows metadata only → the bearer WORKS on an ordinary
//   API route → the bearer may NOT manage tokens (403 — a leaked key must
//   not clone itself) → revoke → the bearer is 401 on its next request →
//   a second device sees the same list → a second user sees ONLY their own
//   tokens (isolation) → bad ids and bad labels answer by the book.
// Run after a daemon restart (the middleware write limiter is in-memory):
//   node scripts/s20-route-e2e.mjs

import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const jarOf = () => [];
const feed = (jar, res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(";")[0]);
};
const H = (jar, extra = {}) => ({
  ...(jar.length ? { cookie: jar.join("; ") } : {}),
  ...extra,
});

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  ok ? pass++ : fail++;
};
const json = async (res) => res.json().catch(() => ({}));

// ---- 1. the fresh door: register two users ----
const jarA = jarOf();
const tag = `s20-${Date.now()}`;
const regA = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Keyring A", email: `${tag}-a@e2e.local`, password: "keyring-pass-1" }),
});
feed(jarA, regA);
check("1.1  register A -> 201", regA.status === 201, regA.status);

const jarB = jarOf();
const regB = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Keyring B", email: `${tag}-b@e2e.local`, password: "keyring-pass-2" }),
});
feed(jarB, regB);
check("1.2  register B -> 201", regB.status === 201, regB.status);

// ---- 2. the console starts empty ----
const list0 = await fetch(`${BASE}/api/auth/token`, { headers: H(jarA) });
const list0body = await json(list0);
check("2.1  GET list with a session -> 200", list0.status === 200, list0.status);
check("2.2  a fresh account has zero tokens", Array.isArray(list0body.tokens) && list0body.tokens.length === 0, list0body);

// ---- 3. mint with a label; the reveal is one-time ----
const mint = await fetch(`${BASE}/api/auth/token`, {
  method: "POST",
  headers: H(jarA, { "content-type": "application/json" }),
  body: JSON.stringify({ name: "render farm script" }),
});
const mintBody = await json(mint);
check("3.1  mint -> 201", mint.status === 201, mint.status);
check("3.2  the response carries the token (the one-time reveal)",
  typeof mintBody.token === "string" && mintBody.token.length > 20);
check("3.3  the response echoes the label", mintBody.name === "render farm script", mintBody.name);
check("3.4  the response names the 90-day expiry", mintBody.expiresInSeconds === 90 * 24 * 3600, mintBody.expiresInSeconds);

const list1 = await fetch(`${BASE}/api/auth/token`, { headers: H(jarA) });
const list1body = await json(list1);
check("3.5  the list now has the row", list1body.tokens?.length === 1, list1body.tokens?.length);
const row = list1body.tokens?.[0];
check("3.6  the row shows the label, never the token",
  row?.name === "render farm script" && !("token" in row) && !("jti" in row), row);

// ---- 4. the bearer works on an ordinary API route ----
const vids = await fetch(`${BASE}/api/videos`, { headers: { authorization: `Bearer ${mintBody.token}` } });
check("4.1  the bearer calls an ordinary API route -> 200", vids.status === 200, vids.status);

// ---- 5. the bearer may NOT manage tokens ----
const bMint = await fetch(`${BASE}/api/auth/token`, {
  method: "POST",
  headers: { authorization: `Bearer ${mintBody.token}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "clone attempt" }),
});
check("5.1  a bearer minting another bearer -> 403 (no self-cloning)", bMint.status === 403, bMint.status);

const bList = await fetch(`${BASE}/api/auth/token`, { headers: { authorization: `Bearer ${mintBody.token}` } });
check("5.2  a bearer listing tokens -> 403", bList.status === 403, bList.status);

const bRevoke = await fetch(`${BASE}/api/auth/token`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${mintBody.token}`, "content-type": "application/json" },
  body: JSON.stringify({ id: row?.id ?? "x" }),
});
check("5.3  a bearer revoking a sibling -> 403", bRevoke.status === 403, bRevoke.status);

// ---- 6. the label law ----
const longLabel = await fetch(`${BASE}/api/auth/token`, {
  method: "POST",
  headers: H(jarA, { "content-type": "application/json" }),
  body: JSON.stringify({ name: "x".repeat(81) }),
});
check("6.1  an 81-char label -> 400", longLabel.status === 400, longLabel.status);

const noLabel = await fetch(`${BASE}/api/auth/token`, {
  method: "POST",
  headers: H(jarA, { "content-type": "application/json" }),
  body: JSON.stringify({}),
});
const noLabelBody = await json(noLabel);
check("6.2  an omitted label still mints (unnamed)", noLabel.status === 201 && noLabelBody.name === null, noLabel.status);

// ---- 7. revoke: the bearer dies on its next request ----
const revoke = await fetch(`${BASE}/api/auth/token`, {
  method: "DELETE",
  headers: H(jarA, { "content-type": "application/json" }),
  body: JSON.stringify({ id: row.id }),
});
check("7.1  revoke a live token -> ok", revoke.status === 200, revoke.status);

const vids2 = await fetch(`${BASE}/api/videos`, { headers: { authorization: `Bearer ${mintBody.token}` } });
check("7.2  the revoked bearer is 401 on its next request", vids2.status === 401, vids2.status);

const revoke2 = await fetch(`${BASE}/api/auth/token`, {
  method: "DELETE",
  headers: H(jarA, { "content-type": "application/json" }),
  body: JSON.stringify({ id: row.id }),
});
check("7.3  revoking again -> 404", revoke2.status === 404, revoke2.status);

const revokeJunk = await fetch(`${BASE}/api/auth/token`, {
  method: "DELETE",
  headers: H(jarA, { "content-type": "application/json" }),
  body: JSON.stringify({ id: "no-such-token" }),
});
check("7.4  revoking a nonexistent id -> 404", revokeJunk.status === 404, revokeJunk.status);

// ---- 8. the list after revoke: kept, marked ----
const list2 = await fetch(`${BASE}/api/auth/token`, { headers: H(jarA) });
const list2body = await json(list2);
const revokedRow = list2body.tokens?.find((t) => t.id === row.id);
check("8.1  the revoked row stays listed with revokedAt set", Boolean(revokedRow?.revokedAt), revokedRow);

// ---- 9. a second device sees the same keyring ----
const login2 = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `${tag}-a@e2e.local`, password: "keyring-pass-1" }),
});
const jarA2 = (login2.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
check("9.1  the second device signs in -> 200", login2.status === 200, login2.status);
const list3 = await fetch(`${BASE}/api/auth/token`, { headers: H(jarA2) });
const list3body = await json(list3);
check("9.2  the second device sees the same rows", list3body.tokens?.length === list2body.tokens?.length,
  { second: list3body.tokens?.length, first: list2body.tokens?.length });

// ---- 10. isolation: user B sees only their own tokens ----
const mintB = await fetch(`${BASE}/api/auth/token`, {
  method: "POST",
  headers: H(jarB, { "content-type": "application/json" }),
  body: JSON.stringify({ name: "B's own key" }),
});
const mintBBody = await json(mintB);
check("10.1 B mints their own token -> 201", mintB.status === 201, mintB.status);
const listB = await fetch(`${BASE}/api/auth/token`, { headers: H(jarB) });
const listBbody = await json(listB);
check("10.2 B's list holds ONLY B's row",
  listBbody.tokens?.length === 1 && listBbody.tokens[0]?.name === "B's own key", listBbody.tokens);
const bRevokeForeign = await fetch(`${BASE}/api/auth/token`, {
  method: "DELETE",
  headers: H(jarB, { "content-type": "application/json" }),
  body: JSON.stringify({ id: list2body.tokens.find((t) => !t.revokedAt && t.id !== row.id)?.id ?? row.id }),
});
check("10.3 B cannot revoke A's token -> 404", bRevokeForeign.status === 404, bRevokeForeign.status);

// ---- 11. anonymous callers get the door ----
const anonList = await fetch(`${BASE}/api/auth/token`);
check("11.1 an anonymous list -> 401", anonList.status === 401, anonList.status);

// ---- 12. cleanup (the register-mode end state must survive every suite) ----
const db = new PrismaClient();
for (const email of [`${tag}-a@e2e.local`, `${tag}-b@e2e.local`]) {
  const u = await db.user.findUnique({
    where: { email },
    include: { memberships: { select: { organizationId: true } } },
  });
  if (u) {
    const orgIds = u.memberships.map((m) => m.organizationId);
    await db.session.deleteMany({ where: { userId: u.id } });
    await db.membership.deleteMany({ where: { userId: u.id } });
    await db.user.delete({ where: { id: u.id } }); // cascades ApiToken rows
    for (const orgId of orgIds) await db.organization.deleteMany({ where: { id: orgId } });
  }
}
const leftover = await db.user.count();
check("12.1 cleanup — zero users remain (the register screen stands)", leftover === 0, leftover);
const leftoverTokens = await db.apiToken.count();
check("12.2 cleanup — the registry is empty (cascade held)", leftoverTokens === 0, leftoverTokens);
await db.$disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
