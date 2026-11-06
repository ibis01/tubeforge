// S47 unit benchmark — the continuity audition (T-47.8).
//
// The external audit's open item: "visual continuity acceptance —
// character/object consistency across scenes". One scratch character with a
// FIXED identity anchor (the seed-director-smoke "Nova", for comparability
// with the historical smoke), the FULL production path:
//
//   portrait (runPortraitJob — CogView, identity anchor verbatim)
//     → director pass (narrative, glm-4.6 pinned) → APPROVED
//     → 3 host scenes painted through generateSceneImage (the identity-
//        locked imageEdit path: portrait as reference, approved outfit
//        clause woven in)
//     → runContinuityCheck — the production VLM pass comparing every painted
//       scene against the identity anchor + portrait.
//
// Every number lands in docs/baselines/ as the RECORDED BASELINE — the
// acceptance THRESHOLD is an S54 decision with human review on record, not a
// claim made here. Live path: Z.ai platform gateway (ungated, metered-only).
// Run: node --import tsx scripts/s47-continuity-benchmark.mts

process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import fs from "node:fs";
import { withCtx, hashPassword } from "../src/lib/tubeforge/tenant";
import { runDirectorPass, setDirectorState, runContinuityCheck, type ContinuityReport } from "../src/lib/tubeforge/director";
import { generateSceneImage, parseScenes, sceneImageFile } from "../src/lib/tubeforge/story";
import { runPortraitJob } from "../src/lib/tubeforge/character-jobs";
import { readPortrait } from "../src/lib/tubeforge/characters";
import { saveCapability } from "../src/lib/tubeforge/providers/settings";
import * as storage from "../src/lib/tubeforge/storage";

const prisma = new PrismaClient();
const SUFFIX = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const UTC_DAY = new Date().toISOString().slice(0, 10);
const BASELINE_PATH = `docs/baselines/s47-continuity-benchmark-${UTC_DAY}.txt`;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// The fixed Nova anchor — byte-identical to scripts/seed-director-smoke.mjs
// so this benchmark's numbers stay comparable with the historical smoke.
const NOVA_ANCHOR = "nova: late-20s presenter, short silver hair, sharp green eyes, dark green flight jacket, small silver ear stud";

const SCENES = [
  {
    index: 1,
    title: "Rooftop",
    narration: "Every forecast starts somewhere high, dry, and windy — tonight, that's Nova's rooftop station.",
    visual: "host presenting beside a small rooftop weather station at dusk, city skyline behind",
    camera: "push-in",
    mood: "dusk skyline, cool blues with warm rim light",
    caption: "the station",
    hostInScene: true,
    rehook: false,
    sfx: "none",
  },
  {
    index: 2,
    title: "Street",
    narration: "And when the radar says run, Nova runs — umbrella first, questions second.",
    visual: "host walking a rain-slick street under a dark umbrella, streetlights reflecting on asphalt",
    camera: "pan-right",
    mood: "night rain, glossy reflections",
    caption: "the run",
    hostInScene: true,
    rehook: true,
    sfx: "whoosh",
  },
  {
    index: 3,
    title: "Wrap",
    narration: "By sunset the front has passed, and the park gets the calm Nova promised at the top of the show.",
    visual: "host standing in a calm park at golden hour, relaxed, closing the segment",
    camera: "pull-out",
    mood: "golden hour warmth, soft haze",
    caption: "the calm",
    hostInScene: true,
    rehook: false,
    sfx: "none",
  },
];

const EMAIL = `s47-cont-${SUFFIX}@e2e.local`;
const passwordHash = await hashPassword("probe-password-123");
const user = await prisma.user.create({ data: { email: EMAIL, passwordHash, name: "s47 continuity benchmark" } });
const org = await prisma.organization.create({
  data: { name: "s47 continuity benchmark org", slug: `s47-cont-${SUFFIX}`, memberships: { create: { userId: user.id, role: "owner" } } },
});

let videoId = "";
let characterId = "";
let report: ContinuityReport | null = null;
const sceneRows: { index: number; bytes: number; sha16: string }[] = [];

try {
  await withCtx({ userId: user.id, organizationId: org.id, role: "owner" }, async () => {
    // Director-grade model for the pass (the default glm-4.5-flash finding is
    // recorded in the director benchmark's baseline; see T-47.7).
    await saveCapability("chat", { provider: "zai", model: "glm-4.6" });

    // 1 — the character + portrait (the identity every scene must keep).
    const character = await prisma.character.create({
      data: {
        organizationId: org.id,
        name: "Nova",
        role: "host",
        appearance: "late-20s presenter, short silver hair, dark green flight jacket",
        identityAnchor: NOVA_ANCHOR,
        voice: "jam",
        isActive: true,
      },
    });
    characterId = character.id;
    await runPortraitJob(characterId);
    const portrait = await readPortrait(characterId);
    const portraitSha = portrait ? crypto.createHash("sha256").update(portrait).digest("hex").slice(0, 16) : "";
    check("portrait generated", !!portrait && portrait.length > 1000, { bytes: portrait?.length ?? 0, portraitSha });

    // 2 — the video: 3 host scenes, cast linked.
    const video = await prisma.video.create({
      data: {
        organizationId: org.id,
        topic: "Nova's field guide to city weather",
        niche: "weather",
        tone: "warm",
        title: "S47 continuity benchmark",
        format: "story",
        characterId: character.id,
        scenes: JSON.stringify(SCENES),
      },
    });
    videoId = video.id;

    // 3 — director pass (narrative) + approval, so the appearance clauses
    // (per-scene outfit from CharacterAppearance) weave into the paints.
    await runDirectorPass(videoId, { profile: "narrative" });
    await setDirectorState(videoId, "approved");
    const appearances = await prisma.characterAppearance.count({ where: { videoId } });
    check("director logged cast appearances for every host scene", appearances === SCENES.length, { appearances });

    // 4 — paint all three scenes through the real path (portrait-seeded
    // imageEdit on the edit-capable default provider).
    const characterForPaint = {
      id: character.id,
      name: character.name,
      identityAnchor: character.identityAnchor,
      appearance: character.appearance,
    };
    for (const scene of parseScenes(JSON.stringify(SCENES))) {
      await generateSceneImage({ videoId, scene, character: characterForPaint });
      const buf = await storage.get(`${videoId}/${sceneImageFile(scene.index)}`).catch(() => null);
      const sha16 = buf ? crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16) : "";
      check(`scene ${scene.index} painted`, !!buf && buf.length > 1000, { bytes: buf?.length ?? 0 });
      sceneRows.push({ index: scene.index, bytes: buf?.length ?? 0, sha16 });
    }

    // 5 — the production continuity check (VLM vs anchor + portrait).
    report = await runContinuityCheck(videoId);
    check("continuity report produced", !!report && report.scenes.length === SCENES.length, {
      checked: report?.scenes.length ?? 0,
    });
  });
} finally {
  // ---------- teardown ----------
  await new Promise((r) => setTimeout(r, 1500));
  if (videoId) {
    await prisma.activity.deleteMany({ where: { videoId } }).catch(() => {});
    await prisma.characterAppearance.deleteMany({ where: { videoId } }).catch(() => {});
    await prisma.video.delete({ where: { id: videoId } }).catch(() => {});
    fs.rmSync(`uploads/${videoId}`, { recursive: true, force: true });
  }
  if (characterId) {
    await prisma.character.delete({ where: { id: characterId } }).catch(() => {});
    await storage.removePrefix(`characters/${characterId}`).catch(() => {});
  }
  await prisma.usageRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
  await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.$disconnect();
}

// ---------- report ----------
const portrait = report ? report : { checkedAt: "", overall: 0, scenes: [] as ContinuityReport["scenes"] };
const lines: string[] = [];
lines.push(`S47 visual continuity benchmark — recorded ${new Date().toISOString()}`);
lines.push("Character: Nova (fixed anchor, byte-identical to seed-director-smoke) · 3 host scenes ·");
lines.push("path: portrait (CogView) → approved narrative director plan (glm-4.6) → identity-locked");
lines.push("scene paints (portrait-seeded imageEdit) → production VLM continuity check.");
lines.push("");
lines.push("scene  bytes    sha256-16          score  verdict      issues");
for (const s of portrait.scenes) {
  const row = sceneRows.find((r) => r.index === s.sceneIndex);
  lines.push(
    `${String(s.sceneIndex).padStart(5)} ${String(row?.bytes ?? 0).padStart(7)} ${(row?.sha16 ?? "").padEnd(18)} ${String(s.score).padStart(5)}  ${s.verdict.padEnd(12)} ${s.issues.join("; ").slice(0, 100)}`
  );
}
lines.push("");
lines.push(`Overall continuity score: ${portrait.overall}/100 across ${portrait.scenes.length} scenes.`);
lines.push("");
lines.push("BASELINE, not a threshold claim: the acceptance threshold (and the human review");
lines.push("protocol behind it) is an S54 decision. This file exists so S54 has a measured");
lines.push("starting point, and so regressions in the continuity path have a number to beat.");
fs.writeFileSync(BASELINE_PATH, `${lines.join("\n")}\n`);
console.info(`\nbaseline written: ${BASELINE_PATH}`);
console.info(lines.join("\n"));

check("§gate: full continuity evidence recorded", portrait.scenes.length === SCENES.length && sceneRows.length === SCENES.length && sceneRows.every((r) => r.bytes > 1000));
console.info(`\n${failures === 0 ? "ALL CHECKS PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
