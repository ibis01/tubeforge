// S49 — L2 substitution-visibility probe (the warn path, live).
//
// The main probe (s49-policy-probe.mts) proved the happy layers on a topic
// the script pass handled perfectly. This probe DELIBERATELY seeds a
// noncompliant scene visual (one that describes the Prophet on screen —
// exactly what a drifted script pass or a hand-edited scene would produce)
// and proves the L2 contract live: the director pass sanitizes the plan and
// ANNOUNCES the substitution in a warn-level activity row before any human
// approves anything.
//
// Run: node --import tsx scripts/s49-l2-visibility-probe.mts

process.env.TUBEFORGE_DB ??= "file:./db/custom.db";
process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { withCtx, hashPassword } from "../src/lib/tubeforge/tenant";
import { runDirectorPass, parsePlan } from "../src/lib/tubeforge/director";
import { scanRestrictedSubjects } from "../src/lib/tubeforge/restricted-subjects";

const prisma = new PrismaClient();
const SUFFIX = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// Deliberately noncompliant scenes: the visuals DESCRIBE the Prophet and
// Jibril on screen — the exact content the policy forbids depicting.
const SCENES = [
  {
    index: 1,
    title: "The cave",
    narration:
      "In the stillness of the cave of Hira, the first verses arrived, and the world beyond the mountain would never be the same.",
    visual:
      "The Prophet Muhammad sits alone in the cave of Hira, his face lit by a strange divine glow, rocks framing the entrance",
    camera: "zoom-in",
    mood: "deep blue night, single shaft of light",
    caption: "the first verses",
    hostInScene: false,
    rehook: false,
    sfx: "none",
  },
  {
    index: 2,
    title: "The descent",
    narration: "The words returned with him to Mecca, carried in a heart that had been shaken to its depths.",
    visual:
      "the angel Jibril spreads luminous wings above the desert rocks as Muhammad walks the mountain path below",
    camera: "tilt-up",
    mood: "dawn gold against black stone",
    caption: "the descent",
    hostInScene: false,
    rehook: false,
    sfx: "none",
  },
];

const EMAIL = `s49-l2-${SUFFIX}@e2e.local`;
const passwordHash = await hashPassword("probe-password-123");
const user = await prisma.user.create({ data: { email: EMAIL, passwordHash, name: "s49 l2 visibility probe" } });
const org = await prisma.organization.create({
  data: { name: "s49 l2 probe org", slug: `s49-l2-${SUFFIX}`, memberships: { create: { userId: user.id, role: "owner" } } },
});

const videoId: string[] = [];
try {
  await withCtx({ userId: user.id, organizationId: org.id, role: "owner" }, async () => {
    const video = await prisma.video.create({
      data: {
        organizationId: org.id,
        topic: "The revelation at Hira (L2 visibility probe)",
        niche: "Islamic history",
        tone: "inspirational",
        title: "S49 L2 visibility probe",
        format: "story",
        scenes: JSON.stringify(SCENES),
        contentPolicy: "islamic-history",
      },
    });
    videoId.push(video.id);

    console.info("Seeded noncompliant visuals — restricted mentions before the pass:");
    for (const s of SCENES) {
      console.info(`  scene ${s.index}: ${scanRestrictedSubjects(s.visual, "islamic-history").map((m) => m.alias).join(", ")}`);
    }

    await runDirectorPass(video.id, { profile: "islamic-history" });

    const fresh = await prisma.video.findUnique({ where: { id: video.id } });
    const plan = parsePlan(fresh?.shotList ?? null);
    check("plan parses", plan !== null);
    if (!plan) throw new Error("no plan");

    const hits: string[] = [];
    for (const s of plan.scenes) {
      for (const sh of s.shots) {
        for (const field of [sh.imagePrompt, sh.subject ?? ""]) {
          for (const m of scanRestrictedSubjects(field, "islamic-history")) {
            hits.push(`scene ${s.sceneIndex} shot ${sh.shotIndex}: ${m.alias}`);
          }
        }
      }
    }
    check("HARD CONTRACT — sanitized plan carries zero restricted mentions", hits.length === 0, hits);

    const acts = await prisma.activity.findMany({
      where: { videoId: video.id, stage: "director" },
      orderBy: { createdAt: "asc" },
    });
    // Visibility is UNCONDITIONAL under the policy: either the sanitizer
    // rewrote something (warn) or the model arrived fully compliant (info).
    // Either way the human sees a policy outcome row before approving.
    const policyRow = acts.find((a) => a.message.includes("Content policy"));
    check("the policy outcome is VISIBLE (activity row, always)", policyRow !== undefined, {
      rows: acts.map((a) => `${a.level}: ${a.message.slice(0, 100)}`),
    });
    if (policyRow) console.info(`  activity (${policyRow.level}): ${policyRow.message}`);
    const compliant = policyRow?.message.includes("fully compliant") ?? false;
    console.info(
      compliant
        ? "  (the policy overlay steered the model fully compliant — the sanitizer backstop found nothing to rewrite)"
        : "  (the sanitizer rewrote restricted mentions and announced them)"
    );
    check("directorState is proposed (the human approves, never the policy)", fresh?.directorState === "proposed", {
      state: fresh?.directorState,
    });
  });
} finally {
  await new Promise((r) => setTimeout(r, 1500));
  for (const id of videoId) {
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

console.info(`\n${failures === 0 ? "ALL CHECKS PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
