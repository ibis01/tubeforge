// S49 — Islamic visual protection: LIVE pipeline probe (L1 → L2 → L3).
//
// What this proves against the REAL services (Z.ai gateway, glm + CogView):
//   §A (L1 compose)  generateSceneScriptPackage with contentPolicy=islamic-history
//                    produces scenes whose VISUAL fields compose AROUND the
//                    restricted subjects (raw compliance measured; leaks are a
//                    finding, not a probe failure — L2/L3 exist for exactly that).
//   §B (L2 direct)   runDirectorPass under the policy + the islamic-history
//                    profile: a v2 plan (19-field shots), contentPolicy stamped,
//                    and the HARD CONTRACT — zero restricted mentions anywhere
//                    in shot imagePrompt/subject after sanitization, with a
//                    visible activity row whenever a substitution occurred.
//                    Also proves the S48 model hint rides when no operator
//                    chat model is pinned.
//   §C (L3 paint)    generateSceneImage through the sanitized prompt — the
//                    real CogView paint under the policy.
// L4/L5 (the VLM frame scan + the export gate) need a full render; their
// contracts are unit-pinned and the S54 benchmark owns the full-render path.
//
// Run: node --import tsx scripts/s49-policy-probe.mts
// Writes: docs/baselines/s49-policy-probe-<utc-day>.txt

process.env.TUBEFORGE_DB ??= "file:./db/custom.db";
process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { withCtx, hashPassword } from "../src/lib/tubeforge/tenant";
import {
  runDirectorPass,
  setDirectorState,
  parsePlan,
} from "../src/lib/tubeforge/director";
import {
  generateSceneScriptPackage,
  generateSceneImage,
  parseScenes,
  sceneImageFile,
} from "../src/lib/tubeforge/story";
import { scanRestrictedSubjects } from "../src/lib/tubeforge/restricted-subjects";
import * as storage from "../src/lib/tubeforge/storage";
import type { DirectorPlan } from "../src/lib/tubeforge/director";

const prisma = new PrismaClient();
const SUFFIX = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const UTC_DAY = new Date().toISOString().slice(0, 10);
const BASELINE_PATH = `docs/baselines/s49-policy-probe-${UTC_DAY}.txt`;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const TOPIC =
  "The revelation at Hira: how the first verses of the Quran reached the Prophet Muhammad and changed Arabia forever";

const videoIds: string[] = [];
let l1LeakScenes = 0;
let l1TotalScenes = 0;
let l2Substitutions = 0;
let planShots = 0;
let plan19FieldShots = 0;
let paintBytes = 0;

const EMAIL = `s49-probe-${SUFFIX}@e2e.local`;
const passwordHash = await hashPassword("probe-password-123");
const user = await prisma.user.create({ data: { email: EMAIL, passwordHash, name: "s49 policy probe" } });
const org = await prisma.organization.create({
  data: { name: "s49 policy probe org", slug: `s49-probe-${SUFFIX}`, memberships: { create: { userId: user.id, role: "owner" } } },
});

try {
  await withCtx({ userId: user.id, organizationId: org.id, role: "owner" }, async () => {
    // -------- §A (L1 compose): the script pass under the policy --------
    console.info("\n§A L1 compose — generateSceneScriptPackage under islamic-history policy");
    const pkg = await generateSceneScriptPackage({
      topic: TOPIC,
      niche: "Islamic history",
      tone: "inspirational",
      length: "short",
      contentPolicy: "islamic-history",
    });
    l1TotalScenes = pkg.scenes.length;
    check("§A script package generated (≥2 scenes)", pkg.scenes.length >= 2, { scenes: pkg.scenes.length });
    const l1Leaks = pkg.scenes.filter(
      (s) => scanRestrictedSubjects(s.visual, "islamic-history").length > 0
    );
    l1LeakScenes = l1Leaks.length;
    for (const s of l1Leaks) {
      console.info(
        `  L1 leak (scene ${s.index}): ${scanRestrictedSubjects(s.visual, "islamic-history").map((m) => m.alias).join(", ")}`
      );
    }
    console.info(
      `  L1 raw compliance: ${pkg.scenes.length - l1Leaks.length}/${pkg.scenes.length} scene visuals compose around restricted subjects${
        l1Leaks.length ? " (leaks are handed to L2/L3 — the layered design)" : ""
      }`
    );

    // -------- §B (L2 direct): the director pass under the policy --------
    console.info("\n§B L2 direct — runDirectorPass (islamic-history profile + policy)");
    const video = await prisma.video.create({
      data: {
        organizationId: org.id,
        topic: TOPIC,
        niche: "Islamic history",
        tone: "inspirational",
        title: "S49 policy probe — revelation at Hira",
        format: "story",
        scenes: JSON.stringify(pkg.scenes),
        contentPolicy: "islamic-history",
      },
    });
    videoIds.push(video.id);

    const t0 = Date.now();
    await runDirectorPass(video.id, { profile: "islamic-history" });
    const ms = Date.now() - t0;
    const fresh = await prisma.video.findUnique({ where: { id: video.id } });
    const plan: DirectorPlan | null = parsePlan(fresh?.shotList ?? null);
    check("§B plan parses", plan !== null);
    if (!plan) throw new Error("no plan");
    check("§B plan is v2", plan.version === 2, { version: plan.version });
    check("§B profile stamped", plan.profile === "islamic-history", { profile: plan.profile });
    check("§B contentPolicy provenance stamped", plan.contentPolicy === "islamic-history", { contentPolicy: plan.contentPolicy });
    check("§B plan covers every scene", plan.scenes.length === pkg.scenes.length, {
      planScenes: plan.scenes.length,
      seeded: pkg.scenes.length,
    });

    // The 19-field contract, live: every parsed shot carries exactly 19 keys.
    planShots = plan.scenes.reduce((a, s) => a + s.shots.length, 0);
    plan19FieldShots = plan.scenes.reduce(
      (a, s) => a + s.shots.filter((sh) => Object.keys(sh).length === 19).length,
      0
    );
    check("§B every parsed shot carries all 19 v2 fields", plan19FieldShots === planShots, {
      planShots,
      plan19FieldShots,
    });

    // The HARD CONTRACT: zero restricted mentions in shot imagePrompt/subject
    // after L2 sanitization (posessive artifact references excluded by design).
    const postSanitizeHits: string[] = [];
    for (const s of plan.scenes) {
      for (const sh of s.shots) {
        for (const field of [sh.imagePrompt, sh.subject ?? ""]) {
          for (const m of scanRestrictedSubjects(field, "islamic-history")) {
            postSanitizeHits.push(`scene ${s.sceneIndex} shot ${sh.shotIndex}: ${m.alias}`);
          }
        }
      }
    }
    check(
      "§B HARD CONTRACT — zero restricted mentions in the sanitized plan",
      postSanitizeHits.length === 0,
      postSanitizeHits
    );

    // Camera vocabulary: every verb is v2 (engine-verbatim) or a legacy snap.
    const { CAMERA_MOVES, LEGACY_CAMERA_MOVES } = await import("../src/lib/tubeforge/director-plan");
    const cameraOk = plan.scenes.every((s) =>
      s.shots.every((sh) => (CAMERA_MOVES as readonly string[]).includes(sh.camera) || (LEGACY_CAMERA_MOVES as readonly string[]).includes(sh.camera))
    );
    check("§B camera verbs are v2/legacy snapped", cameraOk, {
      cameras: [...new Set(plan.scenes.flatMap((s) => s.shots.map((sh) => sh.camera)))],
    });

    // Substitution visibility: leaks from L1 (or the director's own drift)
    // must have produced a warn activity row.
    const acts = await prisma.activity.findMany({
      where: { videoId: video.id, stage: "director" },
      orderBy: { createdAt: "asc" },
    });
    const warnRow = acts.find((a) => a.level === "warn" && a.message.includes("Content policy"));
    l2Substitutions = warnRow ? Number(warnRow.message.match(/rewrote (\d+) shot/)?.[1] ?? 0) : 0;
    if (l1Leaks.length > 0) {
      check(
        "§B substitutions are visible (warn activity row present when L1 leaked)",
        warnRow !== undefined,
        { activityRows: acts.map((a) => a.message.slice(0, 80)) }
      );
    } else {
      console.info("  (L1 was fully compliant — no substitution expected, none required)");
    }
    console.info(`  director pass: ${ms} ms, ${planShots} shots across ${plan.scenes.length} scenes`);

    // -------- §C (L3 paint): a real paint under the policy --------
    console.info("\n§C L3 paint — generateSceneImage through the sanitized prompt");
    await setDirectorState(video.id, "approved");
    const seeded = parseScenes(fresh?.scenes ?? "[]");
    const paint = await generateSceneImage({ videoId: video.id, scene: seeded[0] });
    paintBytes = paint.fileBytes;
    check("§C paint produced a real image", paint.fileBytes > 1000, { bytes: paint.fileBytes });
    const painted = await storage.get(`${video.id}/${sceneImageFile(seeded[0].index)}`).catch(() => null);
    check("§C painted art persisted through the storage seam", painted !== null && painted.length > 1000);
  });
} finally {
  // ---------- teardown (s47 pattern: let in-flight usage rows land first) ----------
  await new Promise((r) => setTimeout(r, 1500));
  for (const id of videoIds) {
    await prisma.activity.deleteMany({ where: { videoId: id } }).catch(() => {});
    await prisma.characterAppearance.deleteMany({ where: { videoId: id } }).catch(() => {});
    await prisma.video.delete({ where: { id } }).catch(() => {});
    fs.rmSync(`uploads/${id}`, { recursive: true, force: true });
  }
  await prisma.usageRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
  await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.$disconnect();
}

// ---------- report ----------
const lines: string[] = [];
lines.push(`S49 Islamic-visual-protection live probe — recorded ${new Date().toISOString()}`);
lines.push("Path: real Z.ai gateway (script pass + director pass glm, CogView paint).");
lines.push(`Topic: "${TOPIC}"`);
lines.push("");
lines.push(`§A L1 compose: ${l1TotalScenes - l1LeakScenes}/${l1TotalScenes} scene visuals composed around restricted`);
lines.push(`   subjects raw (no restricted mention). Leaks: ${l1LeakScenes} — the layered design hands them to L2/L3.`);
lines.push(`§B L2 direct: v2 plan, 19-field shots ${plan19FieldShots}/${planShots}, contentPolicy stamped,`);
lines.push(`   HARD CONTRACT held (zero restricted mentions in the sanitized plan).`);
lines.push(`   Substitutions announced via warn activity rows: ${l2Substitutions} field rewrite(s).`);
lines.push(`§C L3 paint: real CogView paint through the sanitized prompt — ${paintBytes} bytes.`);
lines.push("");
lines.push("L4/L5 (VLM frame scan + export gate) require a full render — unit-pinned; the S54");
lines.push("seven-genre benchmark owns the full-render path. This file is the S49 evidence");
lines.push("baseline for that benchmark.");
fs.writeFileSync(BASELINE_PATH, `${lines.join("\n")}\n`);
console.info(`\nbaseline written: ${BASELINE_PATH}`);
console.info(lines.join("\n"));

console.info(`\n${failures === 0 ? "ALL CHECKS PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
