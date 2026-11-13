// S112 — Scene-Level Editing & Repair, Stage 1: the revision foundation's
// DB-backed exit criteria (the billing-battery pattern: real SQLite DB,
// real lib calls, fixtures cleaned up on exit).
//
// The proposal's Stage 1 exit: "editing cannot overwrite another revision
// or destroy approved work". Pinned here as executable law:
//
//   1. APPEND-ONLY   — a second edit leaves v1's bytes untouched; versions
//                      are monotonic; the unique index rejects duplicates.
//   2. FIRST TOUCH   — the pre-edit state lands as v1 (backfill, born
//                      superseded), so even the first edit has a rollback
//                      target.
//   3. CONFLICT      — a stale expectedVersion throws RevisionConflict
//                      carrying the current head; nothing is written.
//   4. SURGICAL      — a one-scene edit of a three-scene video writes
//                      exactly one revision (diff-driven history).
//   5. ROLLBACK      — restores old content as a NEW revision; every prior
//                      row survives (history is never erased).
//   6. EPOCH         — a whole-script regen mints ids that were NEVER used
//                      (current + retired), genesis rows for all scenes.
//   7. APPROVED      — an approved head is never superseded by a newer
//                      draft; approvedRevision() keeps resolving it.
//   8. UNION SLICE   — a doc-side change (window/mix) records a revision
//                      carrying the docScene half.
//   9. ROLLBACK ARMS — no-history / no-target / already-current each refuse
//                      with their own reason, writing nothing.
//
// Run: npm run test:scene-revisions   (needs the local SQLite DB; part of check)

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { Video } from "@prisma/client";

const _root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const rawDb = new PrismaClient();

import {
  commitSceneChanges,
  rollbackScene,
  headRevision,
  approvedRevision,
  listRevisions,
  RevisionConflict,
  parseRevisionContent,
  type SceneRevisionContent,
} from "../src/lib/tubeforge/scene-revisions";
import {
  beginSceneArtifact,
  finalizeSceneArtifact,
  registerSceneArtifact,
  accumulateArtifactCost,
} from "../src/lib/tubeforge/scene-artifacts";
import { planSceneInvalidation, sweepInvalidArtifacts } from "../src/lib/tubeforge/scene-deps";
import { invalidateRenderedArtifacts } from "../src/lib/tubeforge/render";
import * as storage from "../src/lib/tubeforge/storage";
import { videoDir } from "../src/lib/tubeforge/ai";
import { must } from "../src/lib/tubeforge/must";
import type { Scene } from "../src/lib/tubeforge/types";
import type { AssembledTimeline, TimelineScene } from "../src/lib/tubeforge/timeline";

let passed = 0;
let failed = 0;
const failures: string[] = [];
let suite = "";

function suiteStart(name: string) {
  suite = name;
  console.log(`\n◆ ${name}`);
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`[${suite}] ${name} — ${msg}`);
    console.error(`  ✗ ${name} — ${msg}`);
  }
}

function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, label = "value") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

// --- fixtures ---------------------------------------------------------------

const MARK = `s112_${Date.now().toString(36)}`;
const CLEANUP_VIDEO_IDS: string[] = [];
const CLEANUP_ORG_IDS: string[] = [];

function mkScene(index: number, over: Partial<Scene> = {}): Scene {
  return {
    index,
    title: `Beat ${index}`,
    narration: `Narration for scene ${index}.`,
    visual: `A wide shot of beat ${index}`,
    camera: "slow-zoom",
    mood: "golden hour",
    caption: `CAP ${index}`,
    hostInScene: false,
    rehook: false,
    sfx: "none",
    ...over,
  };
}

async function makeVideo(scenes: Scene[], over: Partial<Video> = {}): Promise<Video> {
  const org = await rawDb.organization.create({
    data: { name: `S112 fixture ${MARK}`, slug: `s112-${MARK}-${CLEANUP_ORG_IDS.length}` },
  });
  CLEANUP_ORG_IDS.push(org.id);
  const video = await rawDb.video.create({
    data: {
      organizationId: org.id,
      topic: "S112 fixture topic",
      niche: "history",
      format: "story",
      scenes: JSON.stringify(scenes),
      hasVoiceover: false,
      ...over,
    },
  });
  CLEANUP_VIDEO_IDS.push(video.id);
  return video;
}

function docOf(scenes: Scene[]): AssembledTimeline {
  const docScenes: TimelineScene[] = scenes.map((s, i) => ({
    index: s.index,
    title: s.title,
    narration: s.narration,
    visual: s.visual,
    startSec: i * 10,
    endSec: i * 10 + 10,
    durationSec: 10,
    transitionIn: i === 0 ? null : "fade",
    transitionOut: i === scenes.length - 1 ? null : "fade",
    audio: {
      voice: { enabled: true, level: 1 },
      music: { enabled: true, level: 0.2, ducking: true },
      sfx: { enabled: false, level: 1, kind: null },
      ambient: { enabled: false, level: 0, kind: null },
    },
    caption: null,
    source: "ai",
    stockSource: null,
    stockQuery: null,
    shot: null,
  }));
  return {
    schema: 2,
    scenes: docScenes,
    tracks: [],
    sceneCount: docScenes.length,
    totalDurationSec: docScenes.length * 10,
    generatedAt: new Date().toISOString(),
  };
}

async function reload(id: string): Promise<Video> {
  const v = await rawDb.video.findUnique({ where: { id } });
  if (!v) throw new Error("fixture video vanished");
  return v;
}

function parseScenesOf(v: Video): Scene[] {
  return v.scenes ? (JSON.parse(v.scenes) as Scene[]) : [];
}

/** The stable id of one scene of the row (fixtures guarantee presence). */
function sceneIdOf(v: Video, index: number): string {
  return must(`scene ${index} id`, parseScenesOf(v).find((s) => s.index === index)?.id);
}

// --- the battery ------------------------------------------------------------

const v3 = await makeVideo([mkScene(1), mkScene(2), mkScene(3)]);

suiteStart("S112 · append-only + first touch");

await test("first edit backfills the pre-edit state as v1 and lands the edit as v2", async () => {
  const before = parseScenesOf(v3);
  const after = before.map((s) =>
    s.index === 2 ? { ...s, narration: "Edited narration for scene 2." } : s
  );
  const commit = await commitSceneChanges({
    video: v3,
    beforeScenes: before,
    beforeDoc: null,
    afterScenes: after,
    afterDoc: null,
    kind: "edit",
    origin: "test-first-edit",
    userId: "user-fixture",
  });
  eq(commit.created.length, 1, "exactly one edit revision");
  eq(commit.backfills.length, 1, "exactly one backfill row");
  const head = commit.created[0];
  eq(head.version, 2, "the edit is v2 (v1 is the backfill)");
  eq(head.parentVersion, 1, "parented on the backfill");
  eq(head.status, "draft", "a fresh edit is draft");
  eq(head.changeKind, "edit", "changeKind edit");
  const backfill = commit.backfills[0];
  eq(backfill.status, "superseded", "the backfill is born superseded");
  ok(
    (parseRevisionContent(backfill.content)?.scene.narration ?? "").includes("Narration for scene 2"),
    "the backfill carries the PRE-edit narration"
  );
  // The row now carries stable ids.
  const row = parseScenesOf(await reload(v3.id));
  ok(row.every((s) => typeof s.id === "string" && s.id.length > 0), "every scene gained an id");
});

await test("a second edit leaves v1 and v2 byte-identical (immutability)", async () => {
  const v = await reload(v3.id);
  const rowsBefore = await listRevisions(v3.id, sceneIdOf(v, 2));
  const frozen = rowsBefore.map((r) => ({ id: r.id, content: r.content, version: r.version }));
  const before = parseScenesOf(v);
  const after = before.map((s) => (s.index === 2 ? { ...s, mood: "blue hour" } : s));
  const commit = await commitSceneChanges({
    video: v,
    beforeScenes: before,
    beforeDoc: null,
    afterScenes: after,
    afterDoc: null,
    kind: "edit",
    origin: "test-second-edit",
  });
  eq(commit.created.length, 1, "one new revision");
  eq(commit.created[0].version, 3, "monotonic version");
  eq(commit.backfills.length, 0, "no second backfill");
  const rowsAfter = await listRevisions(v3.id, sceneIdOf(v, 2));
  eq(rowsAfter.length, 3, "three rows now");
  for (const f of frozen) {
    const now = must(`row v${f.version}`, rowsAfter.find((r) => r.id === f.id));
    eq(now.content, f.content, `v${f.version} content is byte-identical after the new edit`);
  }
  // v2 was draft, now superseded by v3.
  const v2row = rowsAfter.find((r) => r.version === 2);
  eq(v2row?.status, "superseded", "the prior draft head retired");
});

await test("a one-scene edit of three writes exactly one revision (surgical history)", async () => {
  const v = await reload(v3.id);
  const before = parseScenesOf(v);
  const after = before.map((s) => (s.index === 3 ? { ...s, caption: "NEW CAP" } : s));
  const commit = await commitSceneChanges({
    video: v,
    beforeScenes: before,
    beforeDoc: null,
    afterScenes: after,
    afterDoc: null,
    kind: "edit",
    origin: "test-surgical",
  });
  eq(commit.created.length, 1, "only scene 3 got a revision");
  ok(
    commit.created[0].sceneId === sceneIdOf(v, 3),
    "the revision is keyed on scene 3's stable id"
  );
  const total = await rawDb.sceneRevision.count({ where: { videoId: v3.id } });
  eq(
    total,
    5,
    "video total: scene 2 (backfill v1 + v2 + v3) + scene 3's first touch (backfill v1 + v2)"
  );
});

suiteStart("S112 · optimistic concurrency");

await test("a stale expectedVersion conflicts with the current head and writes nothing", async () => {
  const v = await reload(v3.id);
  const sceneId = sceneIdOf(v, 2);
  const head = await headRevision(v3.id, sceneId);
  eq(head?.version, 3, "head is v3");
  const countBefore = await rawDb.sceneRevision.count({ where: { videoId: v3.id } });
  const before = parseScenesOf(v);
  const after = before.map((s) => (s.index === 2 ? { ...s, caption: "RACED" } : s));
  let conflicted: RevisionConflict | null = null;
  try {
    await commitSceneChanges({
      video: v,
      beforeScenes: before,
      beforeDoc: null,
      afterScenes: after,
      afterDoc: null,
      kind: "edit",
      origin: "test-conflict",
      expectedVersion: 2, // stale — the client based its edit on v2
      expectedSceneIndex: 2,
    });
  } catch (err) {
    if (err instanceof RevisionConflict) conflicted = err;
  }
  ok(conflicted !== null, "the stale edit conflicts");
  eq(conflicted?.current?.version ?? 0, 3, "the conflict carries the current head (v3)");
  const countAfter = await rawDb.sceneRevision.count({ where: { videoId: v3.id } });
  eq(countAfter, countBefore, "nothing was written by the refused edit");
});

await test("an honest expectedVersion passes the gate", async () => {
  const v = await reload(v3.id);
  const sceneId = sceneIdOf(v, 2);
  const head = await headRevision(v3.id, sceneId);
  const before = parseScenesOf(v);
  const after = before.map((s) => (s.index === 2 ? { ...s, caption: "HONEST" } : s));
  const commit = await commitSceneChanges({
    video: v,
    beforeScenes: before,
    beforeDoc: null,
    afterScenes: after,
    afterDoc: null,
    kind: "edit",
    origin: "test-honest",
    expectedVersion: head?.version ?? 0,
    expectedSceneIndex: 2,
  });
  eq(commit.created.length, 1, "the honest edit lands");
});

await test("the unique index is the hard floor: a duplicate version cannot be inserted", async () => {
  const v = await reload(v3.id);
  const sceneId = sceneIdOf(v, 2);
  const head = must("scene 2 head", await headRevision(v3.id, sceneId));
  let p2002 = false;
  try {
    await rawDb.sceneRevision.create({
      data: {
        organizationId: v.organizationId,
        videoId: v3.id,
        sceneId,
        version: head.version, // race the same version
        origin: "test-race",
        content: "{}",
      },
    });
  } catch (err) {
    p2002 = (err as { code?: string }).code === "P2002";
  }
  ok(p2002, "the DB rejects a duplicate (videoId, sceneId, version)");
});

suiteStart("S112 · rollback");

await test("rollback restores old content as a NEW revision; history survives", async () => {
  const v = await reload(v3.id);
  const result = await rollbackScene({ video: v, sceneIndex: 2, toVersion: 2, userId: "user-fixture" });
  ok(result.ok, "rollback ok");
  if (!result.ok) throw new Error("unreachable");
  const sceneId = sceneIdOf(v, 2);
  const rows = await listRevisions(v3.id, sceneId);
  eq(rows.length, 5, "v1..v4 plus the rollback = 5 rows — nothing was erased");
  const head = rows[0];
  eq(head.version, 5, "the rollback is the new head");
  eq(head.changeKind, "rollback", "changeKind rollback");
  eq(head.note, "Rollback to v2", "the note names the target");
  const content = parseRevisionContent(head.content);
  ok(
    (content?.scene.narration ?? "").includes("Edited narration for scene 2"),
    "the head now carries v2's narration"
  );
  // The ROW was restored too.
  const rowScene = parseScenesOf(await reload(v3.id)).find((s) => s.index === 2);
  ok(
    (rowScene?.narration ?? "").includes("Edited narration for scene 2"),
    "the row's scene narration is restored"
  );
});

await test("rollback refuses: no history / no target / already current", async () => {
  const fresh = await makeVideo([mkScene(1)]); // never touched — no ids, no history
  const noHistory = await rollbackScene({ video: fresh, sceneIndex: 1, toVersion: 1 });
  eq(noHistory.ok, false, "refused");
  if (!noHistory.ok) eq(noHistory.reason, "no-history", "reason: no-history");

  const v = await reload(v3.id);
  const noTarget = await rollbackScene({ video: v, sceneIndex: 2, toVersion: 99 });
  eq(noTarget.ok, false, "refused");
  if (!noTarget.ok) eq(noTarget.reason, "no-target", "reason: no-target");

  const again = await rollbackScene({ video: v, sceneIndex: 2, toVersion: 5 });
  eq(again.ok, false, "refused");
  if (!again.ok) eq(again.reason, "already-current", "reason: already-current");
});

suiteStart("S112 · epochs");

await test("an epoch mints never-used ids and genesis rows for every scene", async () => {
  const v = await reload(v3.id);
  const oldScenes = parseScenesOf(v);
  const oldIds = new Set(oldScenes.map((s) => s.id));
  const regen = [mkScene(1, { narration: "New epoch scene 1" }), mkScene(2, { narration: "New epoch scene 2" })];
  const commit = await commitSceneChanges({
    video: v,
    beforeScenes: oldScenes,
    beforeDoc: null,
    afterScenes: regen,
    afterDoc: null,
    kind: "epoch",
    origin: "test-epoch",
  });
  eq(commit.created.length, 2, "genesis rows for both new scenes");
  ok(commit.created.every((r) => r.changeKind === "epoch"), "changeKind epoch");
  ok(commit.created.every((r) => r.parentVersion === null), "genesis has no parent");
  const newRow = parseScenesOf(await reload(v3.id));
  eq(newRow.length, 2, "the row now carries the regen scenes");
  const newIds = newRow.map((s) => s.id);
  eq(new Set(newIds).size, 2, "unique ids");
  for (const id of newIds) ok(!oldIds.has(id), `minted id ${id} was never used before`);
  // Retired lines simply STOP: their rows remain, read-only history.
  const retired = await listRevisions(v3.id, must("old scene 2 id", oldScenes.find((s) => s.index === 2)?.id));
  ok(retired.length > 0, "the retired scene's history is still readable");
});

await test("a second epoch avoids the FIRST epoch's ids too (full historical set)", async () => {
  const v = await reload(v3.id);
  const epoch1Ids = new Set(parseScenesOf(v).map((s) => s.id));
  const regen2 = [mkScene(1, { narration: "Epoch 3 scene 1" })];
  await commitSceneChanges({
    video: v,
    beforeScenes: parseScenesOf(v),
    beforeDoc: null,
    afterScenes: regen2,
    afterDoc: null,
    kind: "epoch",
    origin: "test-epoch-2",
  });
  const epoch2Ids = parseScenesOf(await reload(v3.id)).map((s) => s.id);
  for (const id of epoch2Ids) ok(!epoch1Ids.has(id), `second-epoch id ${id} avoids all retired ids`);
});

suiteStart("S112 · approved work is never destroyed");

await test("an approved head stays approved under a newer draft", async () => {
  const v = await reload(v3.id);
  const sceneId = sceneIdOf(v, 1);
  // Scene 1 of the current epoch has its genesis row; bless it approved
  // (what Stage 5's recheck flow will do).
  const head = must("scene 1 head", await headRevision(v3.id, sceneId));
  await rawDb.sceneRevision.update({ where: { id: head.id }, data: { status: "approved" } });
  const approvedBefore = await approvedRevision(v3.id, sceneId);
  eq(approvedBefore?.version, head.version, "approvedRevision resolves the blessed head");

  // A new draft lands on top.
  const before = parseScenesOf(v);
  const after = before.map((s) => (s.index === 1 ? { ...s, mood: "neon night" } : s));
  const commit = await commitSceneChanges({
    video: v,
    beforeScenes: before,
    beforeDoc: null,
    afterScenes: after,
    afterDoc: null,
    kind: "edit",
    origin: "test-approved-protect",
  });
  eq(commit.created.length, 1, "the draft landed");
  eq(commit.created[0].status, "draft", "the new head is a draft");

  const approvedRow = await rawDb.sceneRevision.findUnique({ where: { id: head.id } });
  eq(approvedRow?.status, "approved", "the approved row was NOT superseded");
  const approvedAfter = await approvedRevision(v3.id, sceneId);
  eq(approvedAfter?.id, head.id, "approvedRevision still resolves it — render + rollback keep their source");
});

suiteStart("S112 · the union slice");

await test("a doc-side change records a revision carrying the docScene half", async () => {
  const v = await reload(v3.id);
  const before = parseScenesOf(v);
  const beforeDoc = docOf(before);
  // Trim scene 1's window in the doc (a creative edit, row untouched).
  const afterDoc: AssembledTimeline = {
    ...beforeDoc,
    scenes: beforeDoc.scenes.map((d) =>
      d.index === 1 ? { ...d, endSec: d.endSec - 2, durationSec: d.durationSec - 2 } : d
    ),
  };
  const commit = await commitSceneChanges({
    video: v,
    beforeScenes: before,
    beforeDoc,
    afterScenes: before,
    afterDoc,
    kind: "edit",
    origin: "test-doc-slice",
    timeline: JSON.stringify(afterDoc),
  });
  eq(commit.created.length, 1, "the doc-side change recorded a revision");
  const content: SceneRevisionContent | null = parseRevisionContent(commit.created[0].content);
  const slice = must("union-slice content", content);
  eq(slice.docScene?.endSec, 8, "the revision's docScene carries the trimmed window");
  eq(slice.scene.narration, before[0].narration, "the row half is intact");
  // And the timeline column moved with it.
  const stored = await reload(v3.id);
  ok((stored.timeline ?? "").includes("\"endSec\":8"), "the doc was persisted in the same transaction");
});

suiteStart("S113 · artifact provenance");

await test("register → ready, idempotent on the same input, superseded by a new one", async () => {
  const v = await makeVideo([mkScene(1), mkScene(2)]);
  const reg1 = await registerSceneArtifact({
    video: v,
    sceneIndex: 2,
    type: "image",
    storageKey: `${v.id}/scene-02.png`,
    input: "prompt A|seed=1",
    prompt: "prompt A",
    bytes: 1234,
  });
  ok(reg1 !== null, "registered");
  const row1 = await rawDb.sceneArtifact.findUnique({ where: { id: must("reg1", reg1).id } });
  eq(row1?.status, "ready", "a direct registration lands ready");
  eq(row1?.type, "image", "the proposal's artifact vocabulary");
  ok((row1?.prompt ?? "").startsWith("prompt A"), "the FULL prompt is persisted (S111's discarded-prompt finding)");
  ok(typeof row1?.inputHash === "string" && (row1?.inputHash ?? "").length === 64, "sha256 input hash");

  // Same input at the same key: idempotent — the standing row returns.
  const reg2 = await registerSceneArtifact({
    video: v,
    sceneIndex: 2,
    type: "image",
    storageKey: `${v.id}/scene-02.png`,
    input: "prompt A|seed=1",
    prompt: "prompt A",
  });
  eq(must("reg2", reg2).id, row1?.id, "same inputs → same row (crash-recovery re-runs are not duplicates)");

  // A NEW input at the same key supersedes (history stays, staled).
  const reg3 = await registerSceneArtifact({
    video: v,
    sceneIndex: 2,
    type: "image",
    storageKey: `${v.id}/scene-02.png`,
    input: "prompt B|seed=2",
    prompt: "prompt B",
  });
  ok(must("reg3", reg3).id !== row1?.id, "a new input is a new row");
  const superseded = await rawDb.sceneArtifact.findUnique({ where: { id: must("row1 id", row1?.id) } });
  eq(superseded?.status, "stale", "the prior row staled — never deleted");
});

await test("the pending→ready lifecycle accumulates re-roll costs through the bridge", async () => {
  const v = await makeVideo([mkScene(1)]);
  const attribution = await beginSceneArtifact({
    video: v,
    sceneIndex: 1,
    type: "image",
    storageKey: `${v.id}/scene-01.png`,
    prompt: "the composed prompt",
  });
  ok(attribution !== null, "pending row begun");
  const artId = must("artifact id", must("attribution", attribution).artifactId);
  let row = await rawDb.sceneArtifact.findUnique({ where: { id: artId } });
  eq(row?.status, "pending", "begun as pending");

  // Two metered attempts (first-roll + quality-gate re-roll) accumulate.
  await accumulateArtifactCost(artId, 1200);
  await accumulateArtifactCost(artId, 800);
  await finalizeSceneArtifact(attribution, {
    input: "the composed prompt|seed=42|variant=1",
    prompt: "the composed prompt",
    bytes: 2048,
  });
  row = await rawDb.sceneArtifact.findUnique({ where: { id: artId } });
  eq(row?.status, "ready", "finalized ready");
  eq(row?.costMicroUsd, 2000, "re-roll costs SUM on the artifact (the bridge accumulates)");
  eq(row?.bytes, 2048, "landed bytes recorded");
});

await test("scene artifacts resolve the stable sceneId + head revision", async () => {
  const v = await makeVideo([mkScene(1)]);
  // First touch: an edit mints the id + backfills v1 + lands v2.
  const before = JSON.parse(must("scenes json", v.scenes)) as Scene[];
  await commitSceneChanges({
    video: v,
    beforeScenes: before,
    beforeDoc: null,
    afterScenes: before.map((s) => (s.index === 1 ? { ...s, mood: "dusk" } : s)),
    afterDoc: null,
    kind: "edit",
    origin: "test-provenance",
  });
  const after = await reload(v.id);
  const reg = await registerSceneArtifact({
    video: after,
    sceneIndex: 1,
    type: "audio",
    storageKey: `${v.id}/scene-01.wav`,
    input: "text|voice=jam|speed=1",
    prompt: "text",
  });
  const row = await rawDb.sceneArtifact.findUnique({ where: { id: must("reg", reg).id } });
  ok((row?.sceneId ?? "").length > 0, "the stable sceneId resolved");
  eq(row?.revisionVersion, 2, "registered against the current head (Stage 3's stale check)");
});

suiteStart("S113 · the over-invalidation fix, measured");

await test("a one-scene art change kills ONE clip + the renders — not every scene's", async () => {
  const v = await makeVideo([mkScene(1), mkScene(2), mkScene(3)]);
  // Seed the storage with the render's per-scene clips + the video-level set.
  const seeded = [
    `${v.id}/scene-01.mp4`,
    `${v.id}/scene-02.mp4`,
    `${v.id}/scene-03.mp4`,
    `${v.id}/final.mp4`,
    `${v.id}/preview.mp4`,
    `${v.id}/subtitles.srt`,
    `${v.id}/voiceover.wav`,
    `${v.id}/scene-02.png`,
  ];
  for (const k of seeded) await storage.put(k, Buffer.from(`fixture:${k}`));

  // THE OLD BEHAVIOR (measured baseline): whole-video invalidation after a
  // one-scene art change — every scene's clip died (the §8.3 cost bug).
  // THE FIX: sceneIndex scopes the sweep.
  await invalidateRenderedArtifacts(v.id, { slidePngs: true, sceneIndex: 2 });

  const survivors: string[] = [];
  for (const k of seeded) if (await storage.exists(k)) survivors.push(k);
  eq(
    survivors,
    [`${v.id}/scene-01.mp4`, `${v.id}/scene-03.mp4`, `${v.id}/voiceover.wav`, `${v.id}/scene-02.png`],
    "scenes 1 + 3's clips SURVIVE (2 paid i2v generations skipped); the merged read + the art are untouched; the renders (the union) die"
  );

  for (const k of seeded) await storage.remove(k).catch(() => {});
});

await test("the declarative sweep matches PATCH's key sets and stales the registry", async () => {
  const v = await makeVideo([mkScene(1), mkScene(2)]);
  const seeded = [
    `${v.id}/scene-02.wav`,
    `${v.id}/scene-02.mp4`,
    `${v.id}/scene-01.wav`,
    `${v.id}/voiceover.wav`,
    `${v.id}/voice-source.mp3`,
    `${v.id}/final.mp4`,
    `${v.id}/subtitles.srt`,
  ];
  for (const k of seeded) await storage.put(k, Buffer.from(`fixture:${k}`));
  // A registered artifact at a swept key — the registry must mirror storage.
  const reg = await registerSceneArtifact({
    video: v,
    sceneIndex: 2,
    type: "audio",
    storageKey: `${v.id}/scene-02.wav`,
    input: "old narration|voice=jam",
    prompt: "old narration",
  });

  const plan = planSceneInvalidation(v.id, 2, ["narration"]);
  const { removed } = await sweepInvalidArtifacts(v.id, plan);
  eq(
    removed.sort(),
    [`${v.id}/final.mp4`, `${v.id}/scene-02.mp4`, `${v.id}/scene-02.wav`, `${v.id}/subtitles.srt`, `${v.id}/voice-source.mp3`, `${v.id}/voiceover.wav`].sort(),
    "narration sweep: the edited scene's WAV + clip, the merged read, the renders"
  );
  ok(await storage.exists(`${v.id}/scene-01.wav`), "every OTHER scene's audio survives — the surgical law");
  const row = await rawDb.sceneArtifact.findUnique({ where: { id: must("reg", reg).id } });
  eq(row?.status, "stale", "the registry row staled with its file");

  for (const k of seeded) await storage.remove(k).catch(() => {});
});

await test("a caption sweep keeps ALL audio (no re-TTS) and the visual sweep deletes nothing", async () => {
  const v = await makeVideo([mkScene(1), mkScene(2)]);
  const seeded = [`${v.id}/scene-01.wav`, `${v.id}/scene-02.wav`, `${v.id}/final.mp4`, `${v.id}/subtitles.srt`];
  for (const k of seeded) await storage.put(k, Buffer.from(`fixture:${k}`));

  const capPlan = planSceneInvalidation(v.id, 2, ["caption"]);
  const cap = await sweepInvalidArtifacts(v.id, capPlan);
  eq(cap.removed.sort(), [`${v.id}/final.mp4`, `${v.id}/subtitles.srt`].sort(), "caption sweep: renders only");
  ok(await storage.exists(`${v.id}/scene-02.wav`), "the edited scene's own read survives (captions never touch audio)");

  const visPlan = planSceneInvalidation(v.id, 2, ["visual"]);
  const vis = await sweepInvalidArtifacts(v.id, visPlan);
  eq(vis.removed, [], "a visual-prompt edit deletes nothing (re-roll is explicit)");

  for (const k of seeded) await storage.remove(k).catch(() => {});
});

suiteStart("S114 \u00b7 the scene preview lane");

await test("previewing scene 2 lands scene-preview-02.mp4 and touches NOTHING else", async () => {
  const v = await makeVideo([mkScene(1), mkScene(2), mkScene(3)], { renderMode: "kenburns" });
  const dir = videoDir(v.id);
  fs.mkdirSync(dir, { recursive: true });
  // Real fixtures: 1-frame color art + 1s sine WAVs for every scene, so the
  // per-scene validation passes and the kenburns executor runs real ffmpeg.
  const nn = (i: number) => String(i).padStart(2, "0");
  for (const s of [1, 2, 3]) {
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-nostats", "-y",
      "-f", "lavfi", "-i", "color=c=steelblue:s=640x360:d=1",
      "-frames:v", "1", path.join(dir, `scene-${nn(s)}.png`),
    ], { timeout: 60_000 });
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-nostats", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-ar", "44100", "-ac", "1", path.join(dir, `scene-${nn(s)}.wav`),
    ], { timeout: 60_000 });
  }
  const seededKeys = ["scene-01.png", "scene-02.png", "scene-03.png", "scene-01.wav", "scene-02.wav", "scene-03.wav"];

  const { renderVideo } = await import("../src/lib/tubeforge/render");
  const scenes = parseScenesOf(v);
  const result = await renderVideo({
    videoId: v.id,
    scenes: [must("scene 2", scenes.find((s) => s.index === 2))],
    mode: "kenburns",
    burnSubtitles: true,
    smartCaptions: true,
    music: false,
    scenePreview: { sceneIndex: 2 },
    onProgress: () => {},
  } as Parameters<typeof renderVideo>[0]);

  eq(result.fileName, "scene-preview-02.mp4", "the output is the scene preview key");
  ok(result.fileBytes > 10_000, "a real encoded mp4 landed");
  ok(await storage.exists(`${v.id}/scene-preview-02.mp4`), "published through the storage seam");

  // THE EXIT CRITERION: nothing else moved.
  for (const k of seededKeys) ok(await storage.exists(`${v.id}/${k}`), `input fixture ${k} untouched`);
  for (const k of ["final.mp4", "preview.mp4", "subtitles.srt", "scene-01.mp4", "scene-03.mp4", "scene-preview-01.mp4", "scene-preview-03.mp4"])
    ok(!(await storage.exists(`${v.id}/${k}`)), `${k} was NOT created by a scene-2 preview`);
  // And the row's flags are untouched (a preview is not a certified final).
  const after = await reload(v.id);
  ok(!after.hasVideo && !after.hasPreview, "no video-level flags flipped");

  // Cleanup: fixtures + the preview + the render-tmp scratch.
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of [...seededKeys, "scene-preview-02.mp4"].map((f) => `${v.id}/${f}`))
    await storage.remove(k).catch(() => {});
});

await test("the preview artifact registers with its built-from revision (stale labeling)", async () => {
  const v = await makeVideo([mkScene(1)]);
  const before = parseScenesOf(v);
  // First touch: head becomes v2.
  await commitSceneChanges({
    video: v,
    beforeScenes: before,
    beforeDoc: null,
    afterScenes: before.map((s) => ({ ...s, mood: "dusk" })),
    afterDoc: null,
    kind: "edit",
    origin: "test-preview-stale",
  });
  const afterRow = await reload(v.id);
  const sceneId = must("scene id", parseScenesOf(afterRow).find((s) => s.index === 1)?.id);
  const head = must("head", await headRevision(v.id, sceneId));

  // A preview built from the head: current.
  const { registerSceneArtifact, artifactStaleness } = await import("../src/lib/tubeforge/scene-artifacts");
  const current = await registerSceneArtifact({
    video: afterRow, sceneIndex: 1, type: "preview",
    storageKey: `${v.id}/scene-preview-01.mp4`, input: "look-v2", prompt: "v", bytes: 100,
  });
  const rowNow = await rawDb.sceneArtifact.findUnique({ where: { id: must("cur", current).id } });
  eq(artifactStaleness({ status: rowNow?.status ?? "", revisionVersion: rowNow?.revisionVersion ?? null }, head.version), "current", "built from the head \u2192 current");

  // A newer edit lands \u2192 the SAME preview row is now stale (labeled, not deleted).
  await commitSceneChanges({
    video: afterRow,
    beforeScenes: parseScenesOf(afterRow),
    beforeDoc: null,
    afterScenes: parseScenesOf(afterRow).map((s) => ({ ...s, mood: "night" })),
    afterDoc: null,
    kind: "edit",
    origin: "test-preview-stale-2",
  });
  const newHead = must("new head", await headRevision(v.id, sceneId));
  eq(newHead.version, head.version + 1, "the head moved");
  eq(
    artifactStaleness({ status: rowNow?.status ?? "", revisionVersion: rowNow?.revisionVersion ?? null }, newHead.version),
    "stale",
    "the pre-edit preview is labeled stale against the new head \u2014 the risk table's display-the-version law"
  );
});

// --- teardown ---------------------------------------------------------------

try {
  for (const id of CLEANUP_VIDEO_IDS) await rawDb.video.delete({ where: { id } }).catch(() => {});
  for (const id of CLEANUP_ORG_IDS) await rawDb.organization.delete({ where: { id } }).catch(() => {});
} finally {
  await rawDb.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed${failures.length ? ":" : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failed > 0 ? 1 : 0);
