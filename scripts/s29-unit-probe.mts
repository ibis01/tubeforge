// S29 unit probe — the chain's pure invariants, cheap and exhaustive.
//
// The route e2e walks the hallway; this probe pins the LAWS the hallway is
// built on, the ones a refactor could silently break while every route
// still answers 200:
//
//   A. parseScenes — the script→scenes hand-off contract (what the script
//      job's output must look like before ANY machine stage can run)
//   B. scene file naming — the storage contract the render's up-front
//      validation and the vo cut both depend on (zero-padded, stable)
//   C. the export ZIP laws — safeZipName can't smuggle a path, media is
//      STORED not deflated, buildZip emits a structurally valid archive
//   D. parseSrt — the caption hand-off (monotonic cue math, garbage in →
//      empty out, never a half-parsed cue)
//
// Run: node --import tsx scripts/s29-unit-probe.mts

import {
  parseScenes,
  sceneImageFile,
  sceneWavFile,
} from "../src/lib/tubeforge/story";
import {
  buildZip,
  safeZipName,
  zipMethodFor,
} from "../src/lib/tubeforge/zip";
import crypto from "crypto";
import { parseSrt } from "../src/lib/tubeforge/qc";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (ok) pass++; else fail++;
};

// ---- A. parseScenes: the script→scenes hand-off ----
{
  // Full shape: every field normalized.
  const full = parseScenes(
    JSON.stringify([
      { index: 1, title: "Hook", narration: "n1", visual: "v1", camera: "zoom-in", mood: "tense", caption: "c1", hostInScene: true, rehook: true, sfx: "sting" },
      { index: 2, title: "Pay", narration: "n2", visual: "v2", camera: "bogus-camera", caption: "x".repeat(90), rehook: true },
    ])
  );
  check("A.1 both well-formed scenes survive", full.length === 2, full.length);
  check("A.2 unknown camera normalizes to the safe default", full[1].camera === "zoom-in", full[1].camera);
  check("A.3 caption is clamped to 60 chars", full[1].caption.length === 60, full[1].caption.length);
  check("A.4 rehook survives the boolean coercion", full[0].rehook === true && full[1].rehook === true, [full[0].rehook, full[1].rehook]);
  check("A.5 rehook with no sfx defaults to the sting", full[1].sfx === "sting", full[1].sfx);
  check("A.5b a plain first-position scene defaults to rehook (legacy rows are hooks)", parseScenes(JSON.stringify([{ narration: "n", visual: "v" }, { narration: "n2", visual: "v2" }])).map((s) => s.rehook).join(",") === "true,false");
  check("A.5c a mid-scene with no sfx gets none", parseScenes(JSON.stringify([{ index: 3, narration: "n", visual: "v" }]))[0].sfx === "none");

  // The law that guards the whole chain: a scene without narration or
  // visual is NOT a scene — render/vo would divide by zero on it.
  const filtered = parseScenes(
    JSON.stringify([
      { narration: "has narration", visual: "" }, // no visual
      { narration: "", visual: "has visual" }, // no narration
      { narration: "ok", visual: "ok" }, // the one real scene
    ])
  );
  check("A.6 scenes missing narration OR visual are dropped", filtered.length === 1 && filtered[0].narration === "ok", filtered.length);

  check("A.7 null / garbage JSON → empty scenes (never throws)", parseScenes(null).length === 0 && parseScenes("not json").length === 0 && parseScenes('{"a":1}').length === 0);
  check("A.8 index defaults to position when absent", parseScenes(JSON.stringify([{ narration: "n", visual: "v" }]))[0].index === 1);
}

// ---- B. scene file naming: the storage contract ----
{
  check("B.1 sceneImageFile zero-pads to two digits", sceneImageFile(1) === "scene-01.png" && sceneImageFile(12) === "scene-12.png", [sceneImageFile(1), sceneImageFile(12)]);
  check("B.2 sceneWavFile zero-pads to two digits", sceneWavFile(1) === "scene-01.wav" && sceneWavFile(12) === "scene-12.wav", [sceneWavFile(1), sceneWavFile(12)]);
  check("B.3 image and wav names never collide", sceneImageFile(7) !== sceneWavFile(7));
}

// ---- C. the export ZIP laws ----
{
  // Path smuggling: the archive must never carry a traversal.
  const evil = safeZipName("../../etc/passwd");
  check("C.1 safeZipName strips path separators", !evil.includes("/") && !evil.includes("\\"), evil);
  check("C.2 safeZipName strips control chars and keeps a readable name", !/[\0-\x1f]/.test(evil) && evil.length > 0, evil);
  const win = safeZipName('bad<>:"|?*name');
  check("C.3 safeZipName strips Windows-forbidden chars", !/[<>:"|?*]/.test(win), win);
  check("C.4 safeZipName caps length at 120", safeZipName("x".repeat(300)).length <= 120);

  // Method pick: pre-compressed media is STORED (no double deflate).
  check("C.5 mp4/png/jpg are stored, not deflated", zipMethodFor("final.mp4") === 0 && zipMethodFor("thumb.png") === 0 && zipMethodFor("clip.JPG") === 0);
  check("C.6 text artifacts are deflated", zipMethodFor("subtitles.srt") === 8 && zipMethodFor("notes.json") === 8);

  // buildZip emits a structurally valid archive: local header + central
  // directory + EOCD, with names and CRCs in place. Random bytes are
  // incompressible, so the container must be strictly BIGGER than the
  // payload (with compressible text deflate could legitimately shrink it).
  const data = crypto.randomBytes(2048);
  const zip = buildZip([
    { name: "final.mp4", data },
    { name: "subtitles.srt", data },
  ]);
  const latin = zip.toString("latin1");
  check("C.7 buildZip emits the local-header signature", zip.subarray(0, 4).toString("hex") === "504b0304", zip.subarray(0, 4).toString("hex"));
  check("C.8 buildZip emits the EOCD trailer", zip.subarray(zip.length - 22, zip.length - 18).toString("hex") === "504b0506", zip.subarray(zip.length - 22, zip.length - 18).toString("hex"));
  check("C.9 both entry names land in the archive", latin.includes("final.mp4") && latin.includes("subtitles.srt"));
  check("C.10 the central directory is present (PK\\x01\\x02)", latin.includes("PK\x01\x02"));
  check("C.11 the container is strictly bigger than its incompressible payload", zip.length > data.length * 2, `${zip.length} vs ${data.length}`);
}

// ---- D. parseSrt: the caption hand-off ----
{
  const srt = [
    "1",
    "00:00:01,000 --> 00:00:03,500",
    "First cue",
    "",
    "2",
    "00:00:04,000 --> 00:00:06,000",
    "Second cue",
    "",
  ].join("\n");
  const cues = parseSrt(srt);
  check("D.1 two cues parsed with exact timings", cues.length === 2 && cues[0].start === 1 && cues[0].end === 3.5 && cues[1].start === 4, cues);

  // Comma OR dot decimal separator (SRT vs WebVTT-ish tolerance).
  check("D.2 dot decimal timestamps parse too", parseSrt("1\n00:00:01.250 --> 00:00:02.000\ntext")[0]?.end === 2);

  // Garbage in → empty out, never a half-parsed cue with negative time.
  const garbage = parseSrt("no timestamps here\nat all\n\n1\n00:00:05,000 --> 00:00:04,000\nbackwards");
  check("D.3 a backwards cue (end <= start) is dropped, garbage ignored", garbage.length === 0, garbage);

  check("D.4 empty input → empty cues", parseSrt("").length === 0);
}

console.log(fail === 0 ? `S29 UNIT PROBE: ALL PASS (${pass} passed)` : `S29 UNIT PROBE: ${fail} FAILED of ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
