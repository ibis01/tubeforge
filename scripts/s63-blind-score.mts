#!/usr/bin/env node
/**
 * S63 — blind visual scoring of the eight RE-MEASURED i2v clips.
 *
 *   node --import tsx scripts/s63-blind-score.mts
 *
 * The S62 protocol verbatim (docs/audits/s62-i2v-quality-record.md §3):
 * three frames per clip (1.0 / 2.5 / 4.0 s) enter a shuffled pool A–H
 * (fresh seed 20261109; the key lands in validation/s63/blind-key.json and
 * is NOT read during scoring); one real vision call per pool letter with
 * the SAME generic rubric (the scorer never learns a profile name); unmask
 * AFTER the blind pass, then — post-unmask only — join the S62 scores for
 * the per-profile before/after table the record publishes.
 */

import fs from "node:fs";
import path from "node:path";

import { llmVision } from "../src/lib/tubeforge/llm";
import { parseJsonLoose } from "../src/lib/tubeforge/ai";

const OUT_DIR = path.join(process.cwd(), "validation", "s63");
const S62_SCORES = path.join(process.cwd(), "validation", "s62", "scores.json");
const MANIFEST = path.join(OUT_DIR, "manifest.json");
const KEY_FILE = path.join(OUT_DIR, "blind-key.json");
const SCORES_FILE = path.join(OUT_DIR, "scores.json");

const LETTERS = "ABCDEFGH".split("");

const RUBRIC = `You are a strict visual QC reviewer. You are given THREE frames from a 5-second AI-generated video clip, taken at 1.0s, 2.5s and 4.0s. You know NOTHING else about the clip — judge only what the frames show.

Score each dimension 1–5 (5 = best):
- motion_realism: do the three frames suggest believable, ongoing motion (subject/camera progression across frames) rather than a still image repeated or warped?
- artifact_load: 5 = essentially no AI artifacts; 1 = heavy warping, melted geometry, garbled text/faces, impossible structures.
- temporal_coherence: is the scene the SAME scene across all three frames (consistent objects, lighting, geometry), or do elements appear/vanish/teleport between frames?
- composition: framing, subject clarity, lighting quality as a standalone image.
- overall: your holistic 1–5 as a QC gate for a video production pipeline.

Respond with ONLY a JSON object:
{"motion_realism":n,"artifact_load":n,"temporal_coherence":n,"composition":n,"overall":n,"notes":"2-3 sentences, concrete and specific"}`;

interface BlindScore {
  letter: string;
  motion_realism: number;
  artifact_load: number;
  temporal_coherence: number;
  composition: number;
  overall: number;
  notes: string;
}

function frameToDataUrl(p: string): string {
  return `data:image/jpeg;base64,${fs.readFileSync(p).toString("base64")}`;
}

// Deterministic shuffle (xorshift on a fixed seed) — same pool every rerun.
function seededOrder(n: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  for (let i = n - 1; i > 0; i--) {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    const j = s % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

async function scoreLetter(letter: string, frames: string[]): Promise<BlindScore> {
  const content: Record<string, unknown>[] = [
    { type: "text", text: RUBRIC },
  ];
  for (const f of frames) content.push({ type: "image_url", image_url: { url: frameToDataUrl(f) } });
  const res = await llmVision({
    messages: [{ role: "user", content }],
    thinking: { type: "disabled" },
  });
  const raw = res.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonLoose(raw);
  const num = (k: string) => Math.max(1, Math.min(5, Number(parsed[k] ?? 0) || 0));
  const score: BlindScore = {
    letter,
    motion_realism: num("motion_realism"),
    artifact_load: num("artifact_load"),
    temporal_coherence: num("temporal_coherence"),
    composition: num("composition"),
    overall: num("overall"),
    notes: String(parsed.notes ?? "").slice(0, 600),
  };
  if (!score.overall) throw new Error(`scorer returned no overall for ${letter}: ${raw.slice(0, 120)}`);
  return score;
}

async function main(): Promise<void> {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as { profile: string; ok: boolean }[];
  const okProfiles = manifest.filter((m) => m.ok).map((m) => m.profile);
  if (okProfiles.length !== 8) throw new Error(`expected 8 re-measured profiles, manifest has ${okProfiles.length}`);

  // 1. build (or reuse) the blind pool
  let key: { letter: string; profile: string }[] = [];
  if (fs.existsSync(KEY_FILE)) {
    key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    console.log("blind pool: reusing existing key");
  } else {
    const order = seededOrder(8, 20261109);
    key = order.map((i, slot) => ({ letter: LETTERS[slot], profile: okProfiles[i] }));
    fs.writeFileSync(KEY_FILE, JSON.stringify(key, null, 2) + "\n");
    console.log("blind pool: fresh shuffle written (key withheld from scoring)");
  }

  const frameFor = (profile: string, t: string) => path.join(OUT_DIR, `${profile}.f${t}.jpg`);

  // 2. blind pass — one call per letter, resumable
  const scores: BlindScore[] = [];
  for (const { letter, profile } of key) {
    const frames = ["1", "2.5", "4"].map((t) => frameFor(profile, t));
    for (const f of frames) if (!fs.existsSync(f)) throw new Error(`missing frame ${f}`);
    process.stdout.write(`[pool ${letter}] scoring 3 frames … `);
    const s = await scoreLetter(letter, frames);
    scores.push(s);
    console.log(`overall ${s.overall}/5 — ${s.notes.slice(0, 90)}`);
  }

  // 3. unmask — attribute and emit
  const byProfile = Object.fromEntries(
    key.map((k) => {
      const s = scores.find((x) => x.letter === k.letter);
      if (!s) throw new Error(`blind pass lost the score for pool ${k.letter}`);
      return [k.profile, s];
    })
  );
  const out = {
    scoredAt: new Date().toISOString(),
    rubric: "motion_realism, artifact_load (5=few), temporal_coherence, composition, overall — 1..5, blind pool A–H",
    blind: scores,
    unmasked: byProfile,
  };
  fs.writeFileSync(SCORES_FILE, JSON.stringify(out, null, 2) + "\n");

  console.log("\n===== UNMASKED (blind scores → profiles) =====");
  console.log(`${"profile".padEnd(17)} motion artifact cohere compos OVERALL`);
  const rows = Object.entries(byProfile) as [string, BlindScore][];
  for (const [p, s] of rows) {
    console.log(
      `${p.padEnd(17)} ${String(s.motion_realism).padEnd(6)} ${String(s.artifact_load).padEnd(8)} ${String(s.temporal_coherence).padEnd(6)} ${String(s.composition).padEnd(8)} ${s.overall}/5`
    );
  }
  const avg = (k: keyof BlindScore) =>
    (rows.reduce((a, [, s]) => a + (s[k] as number), 0) / rows.length).toFixed(2);
  console.log(
    `\nfield means: motion ${avg("motion_realism")} · artifacts ${avg("artifact_load")} · coherence ${avg("temporal_coherence")} · composition ${avg("composition")} · overall ${avg("overall")}`
  );

  // 4. POST-unmask comparison against S62 (protocol-safe: the blind pass is
  //    complete before the S62 scores are read).
  if (fs.existsSync(S62_SCORES)) {
    const s62 = JSON.parse(fs.readFileSync(S62_SCORES, "utf8")) as {
      unmasked: Record<string, BlindScore>;
    };
    console.log("\n===== BEFORE (S62) → AFTER (S63) =====");
    console.log(`${"profile".padEnd(17)} ${"motion".padEnd(13)} ${"artifact".padEnd(13)} ${"cohere".padEnd(13)} ${"compos".padEnd(13)} overall`);
    for (const [p, s] of rows) {
      const before = s62.unmasked?.[p];
      const d = (k: keyof BlindScore) =>
        before ? `${before[k]}→${s[k]}` : `${s[k]} (no S62)`;
      console.log(
        `${p.padEnd(17)} ${d("motion_realism").padEnd(13)} ${d("artifact_load").padEnd(13)} ${d("temporal_coherence").padEnd(13)} ${d("composition").padEnd(13)} ${before ? `${before.overall}→${s.overall}` : `${s.overall}`}`
      );
    }
  } else {
    console.log("(no S62 scores.json found — comparison table skipped)");
  }
}

await main();
