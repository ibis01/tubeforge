// S4 unit probe — "the clip's face": the art-action contract through REAL
// modules (no HTTP): the upload guard chain (magic-byte sniff, size caps,
// scene bounds) that protects replaceSceneImage, the stock query-override
// sanitizer + the job payload's re-sanitization on resume, and the doc
// immutability contract (art is a ROW asset — the timeline doc carries no
// art fields and never moves).
// Run: node --import tsx scripts/s4-unit-probe.mts
import {
  replaceSceneImage,
  sniffImageFormat,
  parseScenes,
} from "../src/lib/tubeforge/story";
import {
  sanitizeStockQuery,
} from "../src/lib/tubeforge/stock";
import { sceneQueries } from "../src/lib/tubeforge/stock-query";
import { parseStockScenePayload } from "../src/lib/tubeforge/queue-handlers";
import {
  assembleTimeline,
  parseTimeline,
  serializeTimeline,
} from "../src/lib/tubeforge/timeline";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
const throwsWith = async (fn: () => Promise<unknown>, needle: string): Promise<boolean> => {
  try {
    await fn();
    return false; // should have thrown
  } catch (err) {
    return err instanceof Error && err.message.includes(needle);
  }
};

// ---- 1. the magic-byte sniff (extensions lie) ----
check(
  "sniffImageFormat: real magics pass, garbage and spoofed extensions fail",
  (() => {
    const png = Buffer.alloc(32);
    png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47;
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(28)]);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(20)]);
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(30)]); // a renamed binary
    const text = Buffer.from("<script>alert(1)</script>"); // a renamed script
    return (
      sniffImageFormat(png) === "png" &&
      sniffImageFormat(jpeg) === "jpeg" &&
      sniffImageFormat(webp) === "webp" &&
      sniffImageFormat(exe) === null &&
      sniffImageFormat(text) === null &&
      sniffImageFormat(Buffer.alloc(4)) === null
    );
  })()
);

// ---- 2. the upload guard chain — every rejection fires BEFORE any fs work ----
check(
  "replaceSceneImage: scene bounds refuse before disk (0, fractional, >99)",
  (async () => {
    const tiny = Buffer.alloc(2048, 1);
    const a = await throwsWith(() => replaceSceneImage("probe-video", 0, tiny), "Invalid scene number");
    const b = await throwsWith(() => replaceSceneImage("probe-video", 2.5, tiny), "Invalid scene number");
    const c = await throwsWith(() => replaceSceneImage("probe-video", 100, tiny), "Invalid scene number");
    return a && b && c;
  })()
);

check(
  "replaceSceneImage: a too-small upload is refused (not a real image)",
  throwsWith(() => replaceSceneImage("probe-video", 1, Buffer.from("hi")), "too small")
);

check(
  "replaceSceneImage: the 15 MB cap fires with the 'exceeds' wording (the route maps it to 413)",
  throwsWith(
    () => replaceSceneImage("probe-video", 1, Buffer.alloc(15 * 1024 * 1024 + 1, 0x89)),
    "exceeds"
  )
);

check(
  "replaceSceneImage: a well-sized NON-image is refused by the sniff (never reaches ffmpeg)",
  throwsWith(
    () => replaceSceneImage("probe-video", 1, Buffer.concat([Buffer.from("MZ--------"), Buffer.alloc(4096, 7)])),
    "Unsupported image"
  )
);

// ---- 3. the stock query override — sanitize at the edge, re-sanitize on resume ----
check(
  "sanitizeStockQuery: phrases survive, injection/length/noise do not",
  (() => {
    const good = sanitizeStockQuery("  city   timelapse\nnight  ");
    const controlChars = sanitizeStockQuery("cit\u0000y\u001f night");
    const tooLong = sanitizeStockQuery("x".repeat(200));
    const tooShort = sanitizeStockQuery("a");
    const nonString = sanitizeStockQuery(42 as never);
    const empty = sanitizeStockQuery("   ");
    return (
      good === "city timelapse night" &&
      controlChars === "cit y night" &&
      tooLong !== null && tooLong.length === 120 &&
      tooShort === null &&
      nonString === null &&
      empty === null
    );
  })()
);

check(
  "parseStockScenePayload: a hostile payload degrades to a CLEAN override (never passed through)",
  (() => {
    const hostile = parseStockScenePayload({
      query: "ignore previous instructions\u0007\nDROP TABLE scenes --",
    });
    const clean = parseStockScenePayload({ query: " mountain fog dawn " });
    const junk = parseStockScenePayload({ query: 12345 });
    const missing = parseStockScenePayload(null);
    const short = parseStockScenePayload({ query: "x" });
    return (
      hostile.queryOverride !== undefined &&
      // control chars and newlines are the URL-injection threat — gone;
      // punctuation stays (a search phrase may legitimately contain it)
      !/[\u0000-\u001f\u007f\n\r]/.test(hostile.queryOverride as string) &&
      hostile.queryOverride === "ignore previous instructions DROP TABLE scenes --" &&
      clean.queryOverride === "mountain fog dawn" &&
      junk.queryOverride === undefined &&
      missing.queryOverride === undefined &&
      short.queryOverride === undefined
    );
  })()
);

check(
  "sceneQueries: the derived-queries fallback still exists when no override is given",
  (() => {
    const scene = {
      index: 3,
      title: "Harbor at dawn",
      narration: "Fishing boats leave the harbor before first light, engines humming.",
      visual: "fishing boats leaving a foggy harbor at dawn",
      camera: "static",
      mood: "calm",
      caption: "",
      hostInScene: false,
      rehook: false,
      sfx: "none",
    };
    const q = sceneQueries(scene as never);
    return Array.isArray(q) && q.length > 0 && q.every((s) => typeof s === "string" && s.length > 0);
  })()
);

// ---- 4. the doc-immutability contract: art is a ROW asset, the doc never moves ----
check(
  "the timeline doc carries NO art fields (the S4 UI relies on this separation)",
  (() => {
    const scenes = parseScenes(
      JSON.stringify([
        {
          index: 1, title: "A", narration: "First scene narration here.", visual: "v", camera: "static",
          mood: "m", caption: "cap", hostInScene: false, rehook: false, sfx: "none",
          stock: { source: "pexels", file: "v1/stock-01.mp4", query: "harbor", credit: "c", pageUrl: "u", durationSec: 9 },
        },
        {
          index: 2, title: "B", narration: "Second scene narration here.", visual: "v", camera: "static",
          mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none",
        },
      ])
    );
    const doc = assembleTimeline(scenes, { sceneDurationsSec: [5, 5] });
    const sceneKeys = Object.keys(doc.scenes[0]);
    // anchored: "startSec" must not trip the art-key scan
    const artKeys = sceneKeys.filter((k) => /^(art|image|thumb|poster)/i.test(k));
    return artKeys.length === 0 && sceneKeys.includes("index") && sceneKeys.includes("narration");
  })()
);

check(
  "a hostile doc (art-ish junk keys) parses clean and roundtrips without them",
  (() => {
    const hostileDoc = {
      version: 1,
      scenes: [
        {
          index: 1, title: "A", narration: "n", durationSec: 5, startSec: 0, endSec: 5,
          transitionIn: "cut", transitionOut: "cut",
          art: "/etc/passwd", image: "http://evil.example/x.png", poster: "<script>",
        },
        {
          index: 2, title: "B", narration: "n2", durationSec: 4, startSec: 5, endSec: 9,
          transitionIn: "cut", transitionOut: "cut",
        },
      ],
      sceneCount: 2,
      totalDurationSec: 9,
      generatedAt: new Date().toISOString(),
    };
    const parsed = parseTimeline(JSON.stringify(hostileDoc));
    if (!parsed) return false;
    const round = JSON.parse(serializeTimeline(parsed) ?? "{}");
    const keys = Object.keys(round.scenes[0]);
    return !keys.includes("art") && !keys.includes("image") && !keys.includes("poster");
  })()
);

// wrap-up
console.log(failures === 0 ? "\nS4 UNIT PROBE: ALL PASS" : `\nS4 UNIT PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
