// S51 live benchmark — the visual continuity engine's audition.
//
// Three legs, one file:
//
//   A. THE PORTRAIT-AGE RE-MEASUREMENT — the S47 continuity audition re-run
//      under the restructured portrait prompt (anchor primacy + apparent-age
//      fidelity clause + anchor echo). Same fixed Nova anchor, byte-identical
//      to scripts/s47-continuity-benchmark.mts, so the numbers are
//      comparable: portrait → approved narrative plan (glm-4.6 pinned) →
//      3 identity-locked paints → production VLM continuity check. The S47
//      finding: every scene flagged "appears 50s-60s, not late-20s as
//      stated" (the portrait drifted and the edit propagated it).
//
//   B. REFERENCE-SEEDED PORTRAIT — a synthetic "user ground truth" photo
//      attached through the REAL seam (saveReferenceImage), then the
//      portrait job. The portrait must derive from the newest reference
//      (imageEdit seed); a VLM then checks same-person + apparent age.
//
//   C. LOCATION-REF SCENE SEED — a location reference photo attached through
//      the seam, a hand-crafted APPROVED v2 plan naming it (the script is the
//      human approver, exactly like setDirectorState in leg A), and a
//      non-host scene paint that must seed its edit with the location's
//      reference. A VLM checks same-place.
//
// Live path: Z.ai platform gateway (ungated, metered-only — S47/S49
// precedent). Every number lands in docs/baselines/ as the RECORDED
// BASELINE; thresholds are S54 decisions, not claims made here.
// Run: node --import tsx scripts/s51-continuity-benchmark.mts

process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import fs from "node:fs";
import { withCtx, hashPassword } from "../src/lib/tubeforge/tenant";
import { runDirectorPass, setDirectorState, runContinuityCheck, type ContinuityReport } from "../src/lib/tubeforge/director";
import { generateSceneImage, parseScenes, sceneImageFile } from "../src/lib/tubeforge/story";
import { runPortraitJob } from "../src/lib/tubeforge/character-jobs";
import { readPortrait } from "../src/lib/tubeforge/characters";
import { saveReferenceImage } from "../src/lib/tubeforge/references";
import { imageGenerate } from "../src/lib/tubeforge/providers/image";
import { aiCall } from "../src/lib/tubeforge/budget";
import { llmVision } from "../src/lib/tubeforge/llm";
import { parseJsonLoose } from "../src/lib/tubeforge/ai";
import { saveCapability } from "../src/lib/tubeforge/providers/settings";
import * as storage from "../src/lib/tubeforge/storage";

const prisma = new PrismaClient();
const SUFFIX = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const UTC_DAY = new Date().toISOString().slice(0, 10);
const BASELINE_PATH = `docs/baselines/s51-continuity-benchmark-${UTC_DAY}.txt`;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
const sha16 = (buf: Buffer | null) =>
  buf ? crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16) : "";

// Byte-identical to the S47 audition's anchor — comparability is the point.
const NOVA_ANCHOR =
  "nova: late-20s presenter, short silver hair, sharp green eyes, dark green flight jacket, small silver ear stud";

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

/** One STRICT-JSON VLM verdict comparing two images (the bench's own probe,
 *  independent of the production continuity checker). */
async function vlmCompare(system: string, user: string, a: Buffer, b: Buffer): Promise<Record<string, unknown>> {
  const raw = await aiCall("llm", "s51 bench VLM", () =>
    llmVision({
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: user },
            { type: "image_url", image_url: { url: `data:image/png;base64,${a.toString("base64")}` } },
            { type: "image_url", image_url: { url: `data:image/png;base64,${b.toString("base64")}` } },
          ],
        },
      ],
      temperature: 0.1,
    })
  );
  return parseJsonLoose(raw.choices?.[0]?.message?.content ?? "") as Record<string, unknown>;
}

const EMAIL = `s51-cont-${SUFFIX}@e2e.local`;
const passwordHash = await hashPassword("probe-password-123");
const user = await prisma.user.create({ data: { email: EMAIL, passwordHash, name: "s51 continuity benchmark" } });
const org = await prisma.organization.create({
  data: { name: "s51 continuity benchmark org", slug: `s51-cont-${SUFFIX}`, memberships: { create: { userId: user.id, role: "owner" } } },
});

// Teardown registry — every id/prefix the legs create.
const made = { videos: [] as string[], characters: [] as string[], locations: [] as string[] };

// Leg results for the report writer (assigned inside withCtx).
let legA: { report: ContinuityReport | null; sceneRows: { index: number; bytes: number; sha16: string }[] } | null = null;
let legB: { verdict: Record<string, unknown>; refKey: string; portraitSha: string } | null = null;
let legC: { verdict: Record<string, unknown>; refKey: string; paintedSha: string } | null = null;

try {
  await withCtx({ userId: user.id, organizationId: org.id, role: "owner" }, async () => {
    await saveCapability("chat", { provider: "zai", model: "glm-4.6" });

    // ================= Leg A — the portrait-age re-measurement =================
    console.info("\n— Leg A: the restructured portrait prompt, S47's audition re-run —");
    const nova = await prisma.character.create({
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
    made.characters.push(nova.id);
    await runPortraitJob(nova.id);
    const novaPortrait = await readPortrait(nova.id);
    check("A: portrait generated", !!novaPortrait && novaPortrait.length > 1000, {
      bytes: novaPortrait?.length ?? 0,
      sha16: sha16(novaPortrait),
    });

    const videoA = await prisma.video.create({
      data: {
        organizationId: org.id,
        topic: "Nova's field guide to city weather",
        niche: "weather",
        tone: "warm",
        title: "S51 continuity benchmark — leg A",
        format: "story",
        characterId: nova.id,
        scenes: JSON.stringify(SCENES),
      },
    });
    made.videos.push(videoA.id);

    await runDirectorPass(videoA.id, { profile: "narrative" });
    await setDirectorState(videoA.id, "approved");
    const appearances = await prisma.characterAppearance.count({ where: { videoId: videoA.id } });
    check("A: director logged cast appearances for every host scene", appearances === SCENES.length, { appearances });

    const sceneRows: { index: number; bytes: number; sha16: string }[] = [];
    const novaForPaint = {
      id: nova.id,
      name: nova.name,
      identityAnchor: nova.identityAnchor,
      appearance: nova.appearance,
    };
    for (const scene of parseScenes(JSON.stringify(SCENES))) {
      await generateSceneImage({ videoId: videoA.id, scene, character: novaForPaint });
      const buf = await storage.get(`${videoA.id}/${sceneImageFile(scene.index)}`).catch(() => null);
      check(`A: scene ${scene.index} painted`, !!buf && buf.length > 1000, { bytes: buf?.length ?? 0 });
      sceneRows.push({ index: scene.index, bytes: buf?.length ?? 0, sha16: sha16(buf) });
    }

    const reportA = await runContinuityCheck(videoA.id);
    check("A: continuity report produced", !!reportA && reportA.scenes.length === SCENES.length, {
      checked: reportA?.scenes.length ?? 0,
      overall: reportA?.overall ?? 0,
    });
    const ageFlags = (reportA?.scenes ?? []).filter((s) =>
      // Word-bounded on purpose: the run-1 baseline taught us unanchored
      // "old" matches "g(old)en-blonde" — a hair-COLOR drift read as an age
      // flag (the run's only false FAIL; the recorded issues prove the age
      // finding itself had dissolved).
      s.issues.some((i) => /\bage\b|\byears?\b|\bold(?:er)?\b|\byounger\b|[3-9]0s/i.test(i))
    );
    check(
      "A: the portrait-age finding dissolved (no age-mismatch issues)",
      ageFlags.length === 0,
      { ageIssues: ageFlags.flatMap((s) => s.issues) }
    );
    legA = { report: reportA, sceneRows };

    // ================= Leg B — the reference-seeded portrait =================
    console.info("\n— Leg B: a user reference photo becomes the portrait's ground truth —");
    // Synthetic ground truth: a DIFFERENT look than the anchor would freehand.
    const vegaAnchor =
      "vega: late-20s field engineer, freckled cheeks, auburn hair in a tight ponytail, amber-tinted safety glasses pushed up on her forehead, charcoal canvas work jacket";
    const groundTruth = await aiCall("image", "s51 bench: synthetic user reference", () =>
      imageGenerate({
        prompt: `Candid phone photo of a woman in her late 20s: freckled cheeks, auburn hair in a tight ponytail, amber-tinted safety glasses pushed up on her forehead, charcoal canvas work jacket. Natural daylight, casual pose, sharp focus on the face. Absolutely no text, no letters, no watermarks.`,
        size: "1024x1024",
      })
    );
    const vega = await prisma.character.create({
      data: {
        organizationId: org.id,
        name: "Vega",
        role: "host",
        appearance: "late-20s field engineer, freckles, auburn ponytail, canvas work jacket",
        identityAnchor: vegaAnchor,
        voice: "jam",
        isActive: true,
      },
    });
    made.characters.push(vega.id);
    // THE SEAM: exactly what the upload route does.
    const saved = await saveReferenceImage(`characters/${vega.id}`, [], groundTruth);
    await prisma.character.update({
      where: { id: vega.id },
      data: { referenceImages: JSON.stringify([saved.key]) },
    });
    check("B: reference stored through the seam", saved.key === `characters/${vega.id}/ref-1.png`, saved);

    await runPortraitJob(vega.id);
    const vegaPortrait = await readPortrait(vega.id);
    check("B: portrait generated with the reference attached", !!vegaPortrait && vegaPortrait.length > 1000, {
      bytes: vegaPortrait?.length ?? 0,
      sha16: sha16(vegaPortrait),
    });

    if (vegaPortrait) {
      const verdict = await vlmCompare(
        "You are a strict likeness auditor. You compare a REFERENCE photo (first image) with a GENERATED portrait (second image). Respond with STRICT JSON only: {\"same_person\": <boolean>, \"apparent_age\": \"<e.g. mid-20s>\", \"confidence\": <0-100>, \"notes\": \"<one sentence>\"}. same_person means the same identifiable individual (face shape, freckles, hair, build), allowing for style differences.",
        "Reference photo, then the generated portrait:",
        groundTruth,
        vegaPortrait
      );
      check("B: VLM sees the SAME person (reference → portrait)", verdict.same_person === true, verdict);
      check(
        "B: apparent age sits in the stated window (20s)",
        typeof verdict.apparent_age === "string" && /2\d|twent/i.test(verdict.apparent_age),
        { apparent_age: verdict.apparent_age }
      );
      legB = { verdict, refKey: saved.key, portraitSha: sha16(vegaPortrait) };
    }

    // ================= Leg C — the location-ref scene seed =================
    console.info("\n— Leg C: a location reference seeds the scene edit —");
    const marketRef = await aiCall("image", "s51 bench: location reference", () =>
      imageGenerate({
        prompt: `A narrow night-market street: red paper lanterns strung overhead, steaming food stalls on both sides, wet asphalt reflecting pink and teal neon, hanging handwritten signs (unreadable), crowds blurred in motion. Wide establishing view down the street's center. Absolutely no readable text, no letters, no watermarks.`,
        size: "1344x768",
      })
    );
    const market = await prisma.location.create({
      data: {
        organizationId: org.id,
        name: "the lantern market",
        description:
          "a narrow night-market street with red paper lanterns overhead, steaming food stalls, wet asphalt reflecting pink and teal neon",
        isActive: true,
      },
    });
    made.locations.push(market.id);
    const savedLoc = await saveReferenceImage(`locations/${market.id}`, [], marketRef);
    await prisma.location.update({
      where: { id: market.id },
      data: { referenceImages: JSON.stringify([savedLoc.key]) },
    });
    check("C: location reference stored through the seam", savedLoc.key === `locations/${market.id}/ref-1.png`, savedLoc);

    // The APPROVED plan names the market on a NON-host scene — hand-crafted
    // (the script is the approving human, same as setDirectorState in leg A).
    const plan = {
      version: 2,
      generatedAt: new Date().toISOString(),
      concept: "a night walk through the lantern market",
      profile: "narrative",
      scenes: [
        {
          sceneIndex: 1,
          mood: "neon night, steam and reflections",
          transitionIn: "",
          motion: "smart",
          needsI2V: false,
          useStock: false,
          pacing: "normal",
          ambience: "none",
          sfx: "none",
          locations: ["the lantern market"],
          props: [],
          shots: [
            {
              shotIndex: 0,
              framing: "wide",
              camera: "static",
              lens: "35mm",
              composition: "rule of thirds",
              duration: 3,
              imagePrompt: "establishing view down the lantern-lit market street, stalls steaming on both sides",
              subject: "the night market street",
              subjectAction: "steam rising, crowd flowing",
            },
          ],
        },
      ],
    };
    const sceneC = {
      index: 1,
      title: "Arrival",
      narration: "The lantern market never sleeps, and neither does the story it hides.",
      visual: "a narrow night-market street with red paper lanterns and steaming food stalls, wet asphalt reflecting neon",
      camera: "push-in",
      mood: "neon night, steam and reflections",
      caption: "the market",
      hostInScene: false,
      rehook: false,
      sfx: "none",
    };
    const videoC = await prisma.video.create({
      data: {
        organizationId: org.id,
        topic: "the lantern market at night",
        niche: "food",
        tone: "warm",
        title: "S51 continuity benchmark — leg C",
        format: "story",
        scenes: JSON.stringify([sceneC]),
        shotList: JSON.stringify(plan),
        directorState: "approved",
      },
    });
    made.videos.push(videoC.id);

    await generateSceneImage({ videoId: videoC.id, scene: sceneC, character: null });
    const paintedC = await storage.get(`${videoC.id}/${sceneImageFile(1)}`).catch(() => null);
    check("C: non-host scene painted", !!paintedC && paintedC.length > 1000, {
      bytes: paintedC?.length ?? 0,
      sha16: sha16(paintedC),
    });

    if (paintedC) {
      const verdictC = await vlmCompare(
        "You are a strict location auditor. You compare a LOCATION REFERENCE photo (first image) with a GENERATED scene frame (second image). Respond with STRICT JSON only: {\"same_place\": <boolean>, \"confidence\": <0-100>, \"notes\": \"<one sentence>\"}. same_place means the generated frame depicts the same location identity — matching lantern style, stall layout, neon reflections and overall architecture — even though framing and moment may differ.",
        "Location reference, then the generated scene frame:",
        marketRef,
        paintedC
      );
      check("C: VLM sees the SAME place (reference → painted scene)", verdictC.same_place === true, verdictC);
      legC = { verdict: verdictC, refKey: savedLoc.key, paintedSha: sha16(paintedC) };
    }
  });
} finally {
  // ---------- teardown ----------
  await new Promise((r) => setTimeout(r, 1500));
  for (const videoId of made.videos) {
    await prisma.activity.deleteMany({ where: { videoId } }).catch(() => {});
    await prisma.characterAppearance.deleteMany({ where: { videoId } }).catch(() => {});
    await prisma.video.delete({ where: { id: videoId } }).catch(() => {});
    fs.rmSync(`uploads/${videoId}`, { recursive: true, force: true });
  }
  for (const id of made.characters) {
    await prisma.character.delete({ where: { id } }).catch(() => {});
    await storage.removePrefix(`characters/${id}`).catch(() => {});
  }
  for (const id of made.locations) {
    await prisma.location.delete({ where: { id } }).catch(() => {});
    await storage.removePrefix(`locations/${id}`).catch(() => {});
  }
  await prisma.usageRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
  await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.$disconnect();
}

// ---------- report ----------

const lines: string[] = [];
lines.push(`S51 visual continuity benchmark — recorded ${new Date().toISOString()}`);
lines.push(`Leg A re-runs the S47 audition under the restructured portrait prompt (same fixed`);
lines.push(`Nova anchor, byte-identical). Legs B/C exercise the new reference-photo seam on the`);
lines.push(`live Z.ai metered path. BASELINE, not a threshold claim — thresholds are S54.`);
lines.push("");
lines.push("Leg A — portrait (no refs, anchor-primacy prompt) → approved narrative plan (glm-4.6)");
lines.push("        → 3 identity-locked paints → production VLM continuity check:");
if (legA?.report) {
  lines.push(`  scene  bytes    sha256-16          score  verdict      issues`);
  for (const s of legA.report.scenes) {
    const row = legA.sceneRows.find((r) => r.index === s.sceneIndex);
    lines.push(
      `    ${String(s.sceneIndex).padStart(2)} ${String(row?.bytes ?? 0).padStart(7)} ${(row?.sha16 ?? "").padEnd(16)} ${String(s.score).padStart(6)}  ${s.verdict.padEnd(12)} ${s.issues.join(" | ").slice(0, 100)}`
    );
  }
  lines.push(`  Overall continuity score: ${legA.report.overall}/100 across ${legA.report.scenes.length} scenes.`);
  lines.push(
    `  S47 finding (portrait renders 50s-60s vs stated late-20s): ${legA.report.scenes.some((s) =>
      s.issues.some((i) => /\bage\b|\byears?\b|\bold(?:er)?\b|\byounger\b|[3-9]0s/i.test(i))
    ) ? "STILL PRESENT — see issues above" : "not flagged this run"}`
  );
}
lines.push("");
lines.push("Leg B — synthetic user reference (CogView) → saveReferenceImage → portrait job:");
if (legB) {
  lines.push(`  reference: ${legB.refKey}`);
  lines.push(`  portrait:  sha256-16 ${legB.portraitSha}`);
  lines.push(`  VLM verdict: ${JSON.stringify(legB.verdict)}`);
} else {
  lines.push("  (leg incomplete — see the checks above)");
}
lines.push("");
lines.push("Leg C — location reference (CogView) → saveReferenceImage → approved plan names it");
lines.push("        → non-host scene paint (the set-piece edit seed):");
if (legC) {
  lines.push(`  reference: ${legC.refKey}`);
  lines.push(`  painted:   sha256-16 ${legC.paintedSha}`);
  lines.push(`  VLM verdict: ${JSON.stringify(legC.verdict)}`);
} else {
  lines.push("  (leg incomplete — see the checks above)");
}
lines.push("");
lines.push(`${failures} check(s) failed. The seam's code-path contracts are pinned by the unit`);
lines.push(`suite (227/227); this file records the LIVE behavior on the metered gateway.`);

fs.writeFileSync(BASELINE_PATH, lines.join("\n") + "\n");
console.info(`\nbaseline written: ${BASELINE_PATH} (${failures} failed checks)`);
process.exit(failures > 0 ? 1 : 0);
