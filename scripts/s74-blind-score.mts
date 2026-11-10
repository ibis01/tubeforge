#!/usr/bin/env node
/**
 * S74 — blind visual scoring of the 16 PAIRED i2v clips (8 profiles ×
 * before/after, one shared art per pair).
 *
 *   node --import tsx scripts/s74-blind-score.mts
 *
 * The S62 protocol verbatim (docs/audits/s62-i2v-quality-record.md §3),
 * widened to a 16-slot pool: three frames per clip (1.0 / 2.5 / 4.0 s)
 * enter a shuffled pool A–P (fresh seed 20261110; the key lands in
 * validation/s74/blind-key.json and is NOT read during scoring); one real
 * vision call per pool letter with the SAME generic rubric (the scorer
 * never learns a profile name or which clip is before/after); unmask AFTER
 * the blind pass, then — post-unmask only — the per-pair before/after
 * table, the S63 falsification check (explainer/social/islamic-history
 * motion_realism must rise without coherence/composition degrading), and
 * the original S62 scores as historical context.
 *
 * Resumable per letter: already-scored letters are reused from
 * validation/s74/scores.json when the key matches (a mid-run 429 loses
 * nothing).
 */

import fs from "node:fs";
import path from "node:path";

import { llmVision } from "../src/lib/tubeforge/llm";
import { parseJsonLoose } from "../src/lib/tubeforge/ai";

const OUT_DIR = path.join(process.cwd(), "validation", "s74");
const S62_SCORES = path.join(process.cwd(), "validation", "s62", "scores.json");
const MANIFEST = path.join(OUT_DIR, "manifest.json");
const KEY_FILE = path.join(OUT_DIR, "blind-key.json");
const SCORES_FILE = path.join(OUT_DIR, "scores.json");

const LETTERS = "ABCDEFGHIJKLMNOP".split("");
const SEED = 20261110;

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

interface KeyRow {
  letter: string;
  profile: string;
  variant: "before" | "after";
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

  // 1. build (or reuse) the blind pool — 16 slots, before/after interleaved
  //    BEFORE the shuffle so the layout is deterministic.
  let key: KeyRow[] = [];
  if (fs.existsSync(KEY_FILE)) {
    key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8")) as KeyRow[];
    if (key.length !== 16) throw new Error(`blind-key.json has ${key.length} rows — expected 16; delete it to reshuffle`);
    console.log("blind pool: reusing existing key");
  } else {
    const pool: { profile: string; variant: "before" | "after" }[] = [];
    for (const p of okProfiles) {
      pool.push({ profile: p, variant: "before" });
      pool.push({ profile: p, variant: "after" });
    }
    const order = seededOrder(pool.length, SEED);
    key = order.map((i, slot) => ({ letter: LETTERS[slot], ...pool[i] }));
    fs.writeFileSync(KEY_FILE, JSON.stringify(key, null, 2) + "\n");
    console.log("blind pool: fresh 16-slot shuffle written (key withheld from scoring)");
  }

  const frameFor = (profile: string, variant: string, t: string) =>
    path.join(OUT_DIR, `${profile}.${variant}.f${t}.jpg`);

  // 2. blind pass — one call per letter, resumable
  let scores: BlindScore[] = [];
  if (fs.existsSync(SCORES_FILE)) {
    try {
      const prior = JSON.parse(fs.readFileSync(SCORES_FILE, "utf8")) as { blind?: BlindScore[] };
      if (Array.isArray(prior.blind)) {
        scores = prior.blind.filter((s) => key.some((k) => k.letter === s.letter));
        if (scores.length > 0) console.log(`resuming: ${scores.length}/${key.length} letters already scored`);
      }
    } catch { /* fresh start */ }
  }
  for (const { letter, profile, variant } of key) {
    if (scores.some((s) => s.letter === letter)) continue;
    const frames = ["1", "2.5", "4"].map((t) => frameFor(profile, variant, t));
    for (const f of frames) if (!fs.existsSync(f)) throw new Error(`missing frame ${f}`);
    process.stdout.write(`[pool ${letter}] scoring 3 frames … `);
    const s = await scoreLetter(letter, frames);
    scores.push(s);
    console.log(`overall ${s.overall}/5 — ${s.notes.slice(0, 90)}`);
    // checkpoint after every letter — a mid-run 429 loses nothing
    fs.writeFileSync(SCORES_FILE, JSON.stringify({
      scoredAt: new Date().toISOString(),
      rubric: "motion_realism, artifact_load (5=few), temporal_coherence, composition, overall — 1..5, blind pool A–P (16 paired clips)",
      blind: scores,
      complete: false,
    }, null, 2) + "\n");
  }

  // 3. unmask — attribute and emit
  const byPair = new Map<string, { before?: BlindScore; after?: BlindScore }>();
  for (const k of key) {
    const s = scores.find((x) => x.letter === k.letter);
    if (!s) throw new Error(`blind pass lost the score for pool ${k.letter}`);
    const cell = byPair.get(k.profile) ?? {};
    cell[k.variant] = s;
    byPair.set(k.profile, cell);
  }

  const out = {
    scoredAt: new Date().toISOString(),
    rubric: "motion_realism, artifact_load (5=few), temporal_coherence, composition, overall — 1..5, blind pool A–P (16 paired clips)",
    blind: scores,
    complete: true,
    unmasked: Object.fromEntries(
      [...byPair.entries()].map(([p, cell]) => [p, { before: cell.before, after: cell.after }])
    ),
  };
  fs.writeFileSync(SCORES_FILE, JSON.stringify(out, null, 2) + "\n");

  console.log("\n===== UNMASKED — per-pair before → after (SAME art; the prompt is the only variable) =====");
  console.log(`${"profile".padEnd(17)} ${"motion".padEnd(9)} ${"artifact".padEnd(9)} ${"cohere".padEnd(9)} ${"compos".padEnd(9)} overall`);
  const deltas: { profile: string; motion: number; coherence: number; composition: number; overall: number }[] = [];
  for (const [p, cell] of byPair) {
    const b = cell.before, a = cell.after;
    if (!b || !a) { console.log(`${p.padEnd(17)} (incomplete pair)`); continue; }
    const fmt = (k: keyof BlindScore) => `${b[k]}→${a[k]}`;
    console.log(
      `${p.padEnd(17)} ${fmt("motion_realism").padEnd(9)} ${fmt("artifact_load").padEnd(9)} ${fmt("temporal_coherence").padEnd(9)} ${fmt("composition").padEnd(9)} ${b.overall}→${a.overall}`
    );
    deltas.push({
      profile: p,
      motion: a.motion_realism - b.motion_realism,
      coherence: a.temporal_coherence - b.temporal_coherence,
      composition: a.composition - b.composition,
      overall: a.overall - b.overall,
    });
  }

  const mean = (k: "before" | "after", d: keyof BlindScore) => {
    const rows = [...byPair.values()].filter((c) => c[k]).map((c) => c[k] as BlindScore);
    return (rows.reduce((x, s) => x + (s[d] as number), 0) / rows.length).toFixed(2);
  };
  console.log(`\nfield means:      ${"motion".padEnd(9)} ${"artifact".padEnd(9)} ${"cohere".padEnd(9)} ${"compos".padEnd(9)} overall`);
  console.log(`  before pool:    ${mean("before", "motion_realism").padEnd(9)} ${mean("before", "artifact_load").padEnd(9)} ${mean("before", "temporal_coherence").padEnd(9)} ${mean("before", "composition").padEnd(9)} ${mean("before", "overall")}`);
  console.log(`  after  pool:    ${mean("after", "motion_realism").padEnd(9)} ${mean("after", "artifact_load").padEnd(9)} ${mean("after", "temporal_coherence").padEnd(9)} ${mean("after", "composition").padEnd(9)} ${mean("after", "overall")}`);

  // 4. the S63 falsification check (post-unmask only)
  console.log("\n===== S63 falsification check (pose-killed / tempo-contradicted profiles) =====");
  const critical = ["explainer", "social", "islamic-history"];
  let falsified = false;
  for (const p of critical) {
    const d = deltas.find((x) => x.profile === p);
    if (!d) { console.log(`${p.padEnd(17)} (missing)`); falsified = true; continue; }
    const motionUp = d.motion > 0;
    const noDegradation = d.coherence >= 0 && d.composition >= 0;
    const verdict = motionUp && noDegradation ? "SUPPORTED" : (motionUp ? "motion↑ but quality degenerated" : "motion NOT improved");
    if (!(motionUp && noDegradation)) falsified = true;
    console.log(`${p.padEnd(17)} motion ${d.motion >= 0 ? "+" : ""}${d.motion} · coherence ${d.coherence >= 0 ? "+" : ""}${d.coherence} · composition ${d.composition >= 0 ? "+" : ""}${d.composition} — ${verdict}`);
  }
  console.log(falsified
    ? "\nFALSIFICATION CRITERIA TRIGGERED — the record must say so honestly (S63 record §3)."
    : "\nFalsification criteria NOT triggered — the repair's attribution holds on the paired measurement.");

  // 5. the original S62 scores — historical context only (different art
  //    sampling; the paired deltas above are the stage's measurement).
  if (fs.existsSync(S62_SCORES)) {
    const s62 = JSON.parse(fs.readFileSync(S62_SCORES, "utf8")) as {
      unmasked: Record<string, BlindScore>;
    };
    console.log("\n===== historical context: the ORIGINAL S62 blind scores (old art, old laws) =====");
    console.log(`${"profile".padEnd(17)} motion artifact cohere compos OVERALL`);
    for (const [p, s] of Object.entries(s62.unmasked ?? {})) {
      console.log(`${p.padEnd(17)} ${String(s.motion_realism).padEnd(6)} ${String(s.artifact_load).padEnd(8)} ${String(s.temporal_coherence).padEnd(6)} ${String(s.composition).padEnd(8)} ${s.overall}/5`);
    }
    console.log("(cross-art comparison — the S62 art was lost to the sandbox rebuild; treat as context, not the measurement)");
  }
}

await main();
