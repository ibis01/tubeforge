// S22 unit probe — "the world gets a door": the World library (Stage 5
// module C) always had a backend half — GET/POST on /api/locations and
// /api/props, read by the AI Director — and never a way in. No surface,
// no [id] routes: an entry could be created but never renamed, paused or
// removed (isActive existed but nothing could flip it). Layers:
//   1. THE DOOR LAW — anon 401 everywhere; a bearer (the S20 keyring)
//      opens STUDIO doors (locations/props are ordinary APIs, unlike the
//      account-management routes that 403 it).
//   2. THE LIFECYCLE LAW — POST 201 -> listed -> PATCH renames/rewords ->
//      PATCH isActive:false drops it from the active list (the GET and
//      the director read filter isActive) -> DELETE removes it outright
//      (no FK references the tables; plans-in-flight carry snapshots).
//   3. THE VALIDATION LAW — empty / 81-char names, 601-char descriptions,
//      unknown fields (strict) and an empty PATCH all answer 400.
//   4. THE TENANT LAW — org B sees none of org A's entries, and org B's
//      PATCH/DELETE on org A's ids answer 404 (tenant-db injection).
//   5. THE CASCADE LAW — deleting the org takes its world with it.
// Run: node --import tsx scripts/s22-unit-probe.mts

process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import {
  createApiToken,
  createSessionRecord,
  createSessionToken,
  hashPassword,
} from "../src/lib/tubeforge/tenant";
import { SESSION_COOKIE } from "../src/lib/tubeforge/auth-token";
import {
  GET as locGet,
  POST as locPost,
} from "../src/app/api/locations/route";
import {
  PATCH as locPatch,
  DELETE as locDelete,
} from "../src/app/api/locations/[id]/route";
import {
  GET as propGet,
  POST as propPost,
} from "../src/app/api/props/route";
import {
  DELETE as propDelete,
} from "../src/app/api/props/[id]/route";

const prisma = new PrismaClient();
// S28 — the studio has a REAL tenant now (the owner's account lives in
// this DB): teardown asserts NOTHING-BEHIND against the starting baseline.
const __BASELINE = { users: await prisma.user.count(), orgs: await prisma.organization.count(), locations: await prisma.location.count(), props: await prisma.prop.count() };
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// S58 — the named-fixture guard: a missing token/row/hold becomes a labeled
// error instead of a TypeError at the deref.
const req = <T,>(label: string, v: T | undefined | null): T => {
  if (v === undefined || v === null) throw new Error(`missing: ${label}`);
  return v;
};
const json = async (r: Response) => r.json().catch(() => ({}));

const LOC = "http://probe.local/api/locations";
const PROP = "http://probe.local/api/props";

// ---- throwaway identities: TWO orgs, TWO sessions ----
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const mkIdentity = async (tag: string) => {
  const org = await prisma.organization.create({ data: { name: `S22 ${tag}`, slug: `s22-${tag}-${suffix}` } });
  const user = await prisma.user.create({
    data: {
      email: `s22-${tag}-${suffix}@probe.local`,
      passwordHash: await hashPassword("probe-pw-0123456789"),
      name: `S22 ${tag}`,
    },
  });
  await prisma.membership.create({ data: { userId: user.id, organizationId: org.id, role: "owner" } });
  const session = await createSessionRecord({ userId: user.id, organizationId: org.id, userAgent: "probe" });
  const token = await createSessionToken(user.id, session.id);
  return { org, user, cookie: { cookie: `${SESSION_COOKIE}=${token}` } };
};

const A = await mkIdentity("a");
const B = await mkIdentity("b");

const reqWith = (url: string, opts: RequestInit) => new NextRequest(url, opts);

// =====================================================================
// 1. the door law — who may touch the world
// =====================================================================
{
  const anonGet = await locGet(reqWith(LOC, {}));
  const anonPost = await locPost(reqWith(LOC, { method: "POST", body: JSON.stringify({ name: "x" }) }));
  const anonPatch = await locPatch(reqWith(`${LOC}/nope`, { method: "PATCH", body: "{}" }), { params: Promise.resolve({ id: "nope" }) });
  const anonDelete = await locDelete(reqWith(`${LOC}/nope`, { method: "DELETE" }), { params: Promise.resolve({ id: "nope" }) });
  check("1.1  an anonymous GET -> 401", anonGet.status === 401, anonGet.status);
  check("1.2  an anonymous POST -> 401", anonPost.status === 401, anonPost.status);
  check("1.3  an anonymous PATCH -> 401", anonPatch.status === 401, anonPatch.status);
  check("1.4  an anonymous DELETE -> 401", anonDelete.status === 401, anonDelete.status);

  const bearer = req("s22 keyring probe token", await createApiToken(A.user.id, "s22 keyring probe"));
  const bearerGet = await locGet(reqWith(LOC, { headers: { authorization: `Bearer ${bearer}` } }));
  check("1.5  a bearer GET -> 200 (studio doors open to the keyring)", bearerGet.status === 200, bearerGet.status);
  const bearerPost = await locPost(
    reqWith(LOC, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Bearer-made location" }) })
  );
  check("1.6  a bearer POST -> 201 (ordinary APIs are not account management)", bearerPost.status === 201, bearerPost.status);
  const bearerMade = (await json(bearerPost)).location as { id: string };
  const bearerDel = await locDelete(reqWith(`${LOC}/${bearerMade.id}`, { method: "DELETE", headers: { authorization: `Bearer ${bearer}` } }), { params: Promise.resolve({ id: bearerMade.id }) });
  check("1.7  a bearer DELETE cleans up its own -> 200", bearerDel.status === 200, bearerDel.status);
}

// =====================================================================
// 2. the lifecycle law — create, edit, pause, remove
// =====================================================================
{
  const made = await locPost(reqWith(LOC, { method: "POST", headers: A.cookie as unknown as HeadersInit, body: JSON.stringify({ name: "The midnight diner", description: "Neon, rain, the last booth." }) }));
  check("2.1  a signed-in POST -> 201", made.status === 201, made.status);
  const loc = (await json(made)).location as { id: string; name: string; description: string | null };

  const list = await json(await locGet(reqWith(LOC, { headers: A.cookie as unknown as HeadersInit })));
  check("2.2  the new location is listed", (list.locations as { id: string }[]).some((l) => l.id === loc.id));

  const renamed = await locPatch(reqWith(`${LOC}/${loc.id}`, { method: "PATCH", headers: A.cookie as unknown as HeadersInit, body: JSON.stringify({ name: "The diner at the end of the street", description: null }) }), { params: Promise.resolve({ id: loc.id }) });
  const up = (await json(renamed)).location as { name: string; description: string | null };
  check("2.3  a PATCH renames -> 200", renamed.status === 200 && up.name === "The diner at the end of the street", renamed.status);
  check("2.4  a null description clears the field", up.description === null, up.description);

  const archived = await locPatch(reqWith(`${LOC}/${loc.id}`, { method: "PATCH", headers: A.cookie as unknown as HeadersInit, body: JSON.stringify({ isActive: false }) }), { params: Promise.resolve({ id: loc.id }) });
  check("2.5  archiving -> 200", archived.status === 200, archived.status);

  const afterArchive = await json(await locGet(reqWith(LOC, { headers: A.cookie as unknown as HeadersInit })));
  check("2.6  the archived location drops from the active list",
    !(afterArchive.locations as { id: string }[]).some((l) => l.id === loc.id));

  const gone = await locDelete(reqWith(`${LOC}/${loc.id}`, { method: "DELETE", headers: A.cookie as unknown as HeadersInit }), { params: Promise.resolve({ id: loc.id }) });
  check("2.7  DELETE -> 200", gone.status === 200, gone.status);
  const row = await prisma.location.findUnique({ where: { id: loc.id } });
  check("2.8  the row is really gone", row === null, row);

  // the same arc, the props half
  const propMade = await propPost(reqWith(PROP, { method: "POST", headers: A.cookie as unknown as HeadersInit, body: JSON.stringify({ name: "The red umbrella" }) }));
  check("2.9  props POST -> 201", propMade.status === 201, propMade.status);
  const prop = (await json(propMade)).prop as { id: string };
  const propKilled = await propDelete(reqWith(`${PROP}/${prop.id}`, { method: "DELETE", headers: A.cookie as unknown as HeadersInit }), { params: Promise.resolve({ id: prop.id }) });
  check("2.10 props DELETE -> 200", propKilled.status === 200, propKilled.status);
}

// =====================================================================
// 3. the validation law — the bounds hold on both halves
// =====================================================================
{
  const H = A.cookie as unknown as HeadersInit;
  const bad = (route: typeof locPost, url: string, body: unknown) =>
    route(reqWith(url, { method: "POST", headers: H, body: JSON.stringify(body) }));

  check("3.1  an empty name -> 400", (await bad(locPost, LOC, { name: "" })).status === 400);
  check("3.2  an 81-char name -> 400", (await bad(locPost, LOC, { name: "x".repeat(81) })).status === 400);
  check("3.3  an 80-char name -> 201", (await bad(locPost, LOC, { name: "x".repeat(80) })).status === 201);
  check("3.4  a 601-char description -> 400", (await bad(propPost, PROP, { name: "ok", description: "d".repeat(601) })).status === 400);
  // house law: POST bodies strip unknown keys (characters PATCH is strict;
  // POST creation routes simply keep the keys they know). Nothing lands.
  const stripped = await bad(locPost, LOC, { name: "Stripped field", hacker: true });
  check("3.5  an unknown field is stripped, not stored -> 201", stripped.status === 201, stripped.status);

  const emptyPatch = await locPatch(reqWith(`${LOC}/whatever`, { method: "PATCH", headers: H, body: "{}" }), { params: Promise.resolve({ id: "whatever" }) });
  check("3.6  an empty PATCH -> 400 (nothing to update)", emptyPatch.status === 400, emptyPatch.status);

  const junkPatch = await locPatch(reqWith(`${LOC}/whatever`, { method: "PATCH", headers: H, body: JSON.stringify({ name: "y".repeat(120) }) }), { params: Promise.resolve({ id: "whatever" }) });
  check("3.7  an invalid PATCH body -> 400", junkPatch.status === 400, junkPatch.status);

  // clean the two 201s this section created
  const list = (await json(await locGet(reqWith(LOC, { headers: H })))).locations as { id: string; name: string }[];
  for (const l of list) await prisma.location.delete({ where: { id: l.id } });
  const plist = (await json(await propGet(reqWith(PROP, { headers: H })))).props as { id: string }[];
  for (const p of plist) await prisma.prop.delete({ where: { id: p.id } });
}

// =====================================================================
// 4. the tenant law — org B cannot touch org A's world
// =====================================================================
{
  const H = A.cookie as unknown as HeadersInit;
  const made = (await json(await locPost(reqWith(LOC, { method: "POST", headers: H, body: JSON.stringify({ name: "A's rooftop" }) })))).location as { id: string };

  const bList = (await json(await locGet(reqWith(LOC, { headers: B.cookie as unknown as HeadersInit })))).locations as { id: string }[];
  check("4.1  org B's list has none of org A's entries", !bList.some((l) => l.id === made.id));

  const bPatch = await locPatch(reqWith(`${LOC}/${made.id}`, { method: "PATCH", headers: B.cookie as unknown as HeadersInit, body: JSON.stringify({ name: "stolen" }) }), { params: Promise.resolve({ id: made.id }) });
  check("4.2  org B's PATCH on A's id -> 404", bPatch.status === 404, bPatch.status);
  const bDelete = await locDelete(reqWith(`${LOC}/${made.id}`, { method: "DELETE", headers: B.cookie as unknown as HeadersInit }), { params: Promise.resolve({ id: made.id }) });
  check("4.3  org B's DELETE on A's id -> 404", bDelete.status === 404, bDelete.status);

  const stillThere = await prisma.location.findUnique({ where: { id: made.id } });
  check("4.4  the entry survived the cross-tenant attempts", stillThere !== null);
  await prisma.location.delete({ where: { id: made.id } });
}

// =====================================================================
// 5. the cascade law — the org takes its world with it
// =====================================================================
{
  const H = A.cookie as unknown as HeadersInit;
  await locPost(reqWith(LOC, { method: "POST", headers: H, body: JSON.stringify({ name: "Cascade diner" }) }));
  await propPost(reqWith(PROP, { method: "POST", headers: H, body: JSON.stringify({ name: "Cascade umbrella" }) }));
  const beforeLocs = await prisma.location.count({ where: { organizationId: A.org.id } });
  const beforeProps = await prisma.prop.count({ where: { organizationId: A.org.id } });
  check("5.1  the org owns its entries", beforeLocs === 1 && beforeProps === 1, { beforeLocs, beforeProps });

  await prisma.organization.delete({ where: { id: A.org.id } });
  const afterLocs = await prisma.location.count({ where: { organizationId: A.org.id } });
  const afterProps = await prisma.prop.count({ where: { organizationId: A.org.id } });
  check("5.2  deleting the org cascades the world away", afterLocs === 0 && afterProps === 0, { afterLocs, afterProps });
}

// ---- teardown: org A already cascaded; finish org B ----
await prisma.user.delete({ where: { id: A.user.id } }).catch(() => {});
await prisma.user.delete({ where: { id: B.user.id } }).catch(() => {});
await prisma.organization.delete({ where: { id: B.org.id } }).catch(() => {});

const [u, o, l, p] = [await prisma.user.count(), await prisma.organization.count(), await prisma.location.count(), await prisma.prop.count()];
check("teardown  nothing behind (users/orgs/locations/props back to baseline)", u === __BASELINE.users && o === __BASELINE.orgs && l === __BASELINE.locations && p === __BASELINE.props, { u, o, l, p, __BASELINE });

console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : failures + " FAILURES"}`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
