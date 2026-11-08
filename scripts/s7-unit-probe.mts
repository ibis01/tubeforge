// S7 unit probe — "the score": the music-pick contract through REAL modules.
// Two layers, mirroring the sprint's evidence pattern:
//   1. PURE boundaries (no I/O): the MusicPick sanitizer at the doc choke
//      point, the renderPrefs round-trip through the real doc serializer,
//      the zod save boundary, the off/absent semantics, and the bed-flag
//      truth matrix (musicBedActive — the S7-audit one-truth every surface
//      shares: render flag, mix preview, audition, export credits).
//   2. DB-backed precedence (real rows, real resolver): the doc pick re-tops
//      the chain (doc > plan > row), "auto" skips the pins, "off" refuses to
//      pick, junk falls down the chain — never a crash, never a hostile hit.
// Run: node --import tsx scripts/s7-unit-probe.mts
import {
  sanitizeMusicPick,
  docMusicPick,
  sanitizeRenderPrefs,
  type MusicPick,
} from "../src/lib/tubeforge/studio-doc";
import { assembleSaveSchema } from "../src/lib/tubeforge/validation";
import { assembleTimeline, parseTimeline, serializeTimeline } from "../src/lib/tubeforge/timeline";
import { parseScenes } from "../src/lib/tubeforge/story";
import { resolveMusicForVideo, musicBedActive } from "../src/lib/tubeforge/music";
import { withCtx } from "../src/lib/tubeforge/tenant";
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

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

const sceneJson = () =>
  JSON.stringify([
    {
      index: 1, title: "A", narration: "First scene narration here.", visual: "v", camera: "static",
      mood: "m", caption: "cap", hostInScene: false, rehook: false, sfx: "none",
    },
    {
      index: 2, title: "B", narration: "Second scene narration here.", visual: "v2", camera: "static",
      mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none",
    },
  ]);

// =====================================================================
// 1. the doc boundary (pure)
// =====================================================================
check(
  "sanitizeMusicPick: the four modes survive, junk dies, ids normalize",
  (() => {
    const ok = sanitizeMusicPick({ mode: "auto" });
    const off = sanitizeMusicPick({ mode: " OFF " });
    const mood = sanitizeMusicPick({ mode: "Mood", moodId: " Calm " });
    const track = sanitizeMusicPick({ mode: "track", trackId: "cmabc123def" });
    return (
      !!ok && ok.mode === "auto" &&
      !!off && off.mode === "off" &&
      !!mood && mood.mode === "mood" && mood.moodId === "calm" &&
      !!track && track.mode === "track" && track.trackId === "cmabc123def"
    );
  })()
);

check(
  "sanitizeMusicPick: a mood/track pick without a sane id is no pick at all",
  sanitizeMusicPick({ mode: "mood" }) === null &&
    sanitizeMusicPick({ mode: "mood", moodId: "../../etc/passwd" }) === null &&
    sanitizeMusicPick({ mode: "mood", moodId: 42 }) === null &&
    sanitizeMusicPick({ mode: "track" }) === null &&
    sanitizeMusicPick({ mode: "track", trackId: "DROP TABLE" }) === null &&
    sanitizeMusicPick({ mode: "track", trackId: "x".repeat(80) }) === null
);

check(
  "sanitizeMusicPick: irrelevant fields are dropped — a pick is self-consistent",
  (() => {
    const m = sanitizeMusicPick({ mode: "auto", moodId: "calm", trackId: "cmx", hostile: "x" });
    const o = sanitizeMusicPick({ mode: "off", trackId: "cmx" });
    return (
      !!m && !("moodId" in m) && !("trackId" in m) && !("hostile" in m) &&
      !!o && !("trackId" in o)
    );
  })()
);

check(
  "sanitizeMusicPick: non-objects and unknown modes read as no pick",
  sanitizeMusicPick(null) === null &&
    sanitizeMusicPick("off") === null &&
    sanitizeMusicPick(42) === null &&
    sanitizeMusicPick({ mode: "louder" }) === null &&
    sanitizeMusicPick({}) === null
);

check(
  "docMusicPick reads the doc's renderPrefs; absent/junk reads as no opinion",
  docMusicPick({ quality: "standard", music: { mode: "track", trackId: "cmx" } })?.mode === "track" &&
    docMusicPick({ quality: "standard" }) === null &&
    docMusicPick({ quality: "standard", music: null }) === null &&
    docMusicPick({ quality: "standard", music: "off" as never }) === null &&
    docMusicPick(null) === null
);

check(
  "sanitizeRenderPrefs keeps quality + caption + music, drops junk keys, omits absent picks",
  (() => {
    const full = sanitizeRenderPrefs({
      quality: "high", captionStyle: "bold-pop", music: { mode: "mood", moodId: "calm" }, hostile: "x",
    });
    const bare = sanitizeRenderPrefs({ quality: "standard" });
    return (
      !!full && full.quality === "high" && full.captionStyle === "bold-pop" &&
      !!full.music && full.music.mode === "mood" && full.music.moodId === "calm" && !("hostile" in full) &&
      !!bare && bare.captionStyle === undefined && bare.music === undefined
    );
  })()
);

check(
  "serializeTimeline → parseTimeline round-trips the music pick (and drops junk)",
  (() => {
    const scenes = parseScenes(sceneJson());
    const doc = assembleTimeline(scenes, { sceneDurationsSec: [5, 5] });
    doc.renderPrefs = { quality: "high", music: { mode: "track", trackId: "cmtrack123" } };
    const round = parseTimeline(serializeTimeline(doc));
    if (!round || round.renderPrefs?.music?.mode !== "track" || round.renderPrefs.music.trackId !== "cmtrack123")
      return false;
    doc.renderPrefs = { quality: "high", music: { mode: "mood", moodId: "../../x" } as never };
    const round2 = parseTimeline(serializeTimeline(doc));
    return !!round2 && round2.renderPrefs?.music === undefined;
  })()
);

check(
  "assembleSaveSchema accepts a catalog pick and rejects a hostile mode",
  (() => {
    const base = { scenes: [{ index: 1, startSec: 0, endSec: 5, durationSec: 5 }], totalDurationSec: 5 };
    const ok = assembleSaveSchema.safeParse({
      ...base,
      renderPrefs: { quality: "high", music: { mode: "track", trackId: "cmtrack123" } },
    });
    const badMode = assembleSaveSchema.safeParse({
      ...base,
      renderPrefs: { quality: "high", music: { mode: "earblast" } },
    });
    const badId = assembleSaveSchema.safeParse({
      ...base,
      renderPrefs: { quality: "high", music: { mode: "track", trackId: "a".repeat(200) } },
    });
    return ok.success && !badMode.success && !badId.success;
  })()
);

// =====================================================================
// 1b. the bed flag (pure) — the S7-audit one-truth matrix
// =====================================================================
// The pre-audit render computed its music flag from the body option and the
// doc pick ONLY, so a Settings-off resolver-null was conflated with
// "no match" and the finalizer droned over a bed the user had switched off
// (isMusicEnabledForVideo's own contract says "false → NO bed whatsoever").
// musicBedActive is now the single truth — this matrix is the contract.
check(
  "musicBedActive: \"off\" is true silence even when the chain is on",
  musicBedActive({ mode: "off" }, true) === false &&
    musicBedActive({ mode: "off" }, false) === false
);
check(
  "musicBedActive: any other pick overrides the Settings master switch",
  musicBedActive({ mode: "auto" }, false) === true &&
    musicBedActive({ mode: "mood", moodId: "calm" }, false) === true &&
    musicBedActive({ mode: "track", trackId: "cmx" }, false) === true
);
check(
  "musicBedActive: no pick follows the row/Settings chain (off finally silences the render)",
  musicBedActive(null, true) === true &&
    musicBedActive(undefined, false) === false
);
check(
  "musicBedActive: junk reads as no pick through docMusicPick — silence stays silent",
  musicBedActive(
    docMusicPick({ quality: "standard", music: { mode: "track", trackId: "../../etc/passwd" } }),
    false
  ) === false
);

// =====================================================================
// 2. the resolver precedence (real DB rows, real resolver)
// =====================================================================
const MARK = crypto.randomBytes(4).toString("hex");
const raw = new PrismaClient();
let orgA = "";
let orgB = "";
let userId = "";

/** The resolver runs behind a REAL tenant scope (org A) — the same way the
 *  render job body does — so every db.musicTrack read is org-filtered. */
const resolve = (
  video: Parameters<typeof resolveMusicForVideo>[0],
  planMood: string | null,
  docPick: MusicPick | null
) => {
  if (!userId) throw new Error("fixture user missing");
  return withCtx(
    { userId, organizationId: orgA, role: "owner" },
    () => resolveMusicForVideo(video, planMood, docPick)
  );
};

const videoShaped = (over: Partial<Parameters<typeof resolveMusicForVideo>[0]> = {}) => ({
  musicEnabled: null,
  musicTrackId: null,
  musicVolume: null,
  musicFadeIn: null,
  musicFadeOut: null,
  musicDucking: null,
  musicDuckingIntensity: null,
  musicMood: null,
  niche: "Psychology",
  audioDuration: null,
  ...over,
});

try {
  orgA = (
    await raw.organization.create({ data: { name: `s7 A ${MARK}`, slug: `s7a-${MARK}` } })
  ).id;
  orgB = (
    await raw.organization.create({ data: { name: `s7 B ${MARK}`, slug: `s7b-${MARK}` } })
  ).id;
  userId = (
    await raw.user.create({
      data: { email: `s7-${MARK}@probe.test`, passwordHash: `pbkdf2$1$s$${MARK}`, name: "s7 probe" },
    })
  ).id;
  await raw.membership.create({
    data: { userId, organizationId: orgA, role: "owner" },
  });

  // org A: a calm-tagged bed and a suspenseful one; org B: an isolated track.
  const calmTrack = await raw.musicTrack.create({
    data: {
      organizationId: orgA, name: `S7 Calm ${MARK}`, moods: "soft,airy,minimal,neutral",
      durationSec: 90, filePath: `_music/s7-calm-${MARK}.wav`,
    },
  });
  const suspenseTrack = await raw.musicTrack.create({
    data: {
      organizationId: orgA, name: `S7 Suspense ${MARK}`, moods: "mysteries,dark",
      durationSec: 60, filePath: `_music/s7-suspense-${MARK}.wav`,
    },
  });
  await raw.musicTrack.create({
    data: {
      organizationId: orgB, name: `S7 Foreign ${MARK}`, moods: "soft,airy",
      durationSec: 90, filePath: `_music/s7-foreign-${MARK}.wav`,
    },
  });

  // --- the pre-S7 chain is intact when the doc has no opinion ---
  // (inside org A's scope the library is exactly the two seeded tracks, so
  // the auto-match is deterministic: Psychology asks for psychology/soft —
  // only the calm bed answers.)
  const rowPinned = await resolve(
    videoShaped({ musicTrackId: calmTrack.id }),
    null,
    null
  );
  check(
    "no doc pick: the row pin still wins (pre-S7 chain byte-stable)",
    rowPinned?.track.id === calmTrack.id && rowPinned.why.startsWith("pinned track"),
    rowPinned?.why
  );

  const autoNoPick = await resolve(videoShaped(), null, null);
  check(
    "no doc pick: auto-match answers the niche deterministically in-scope",
    autoNoPick?.track.id === calmTrack.id && autoNoPick.why.includes("auto mood-match"),
    autoNoPick?.why
  );

  // --- S7: a mood pick re-tops the mood chain ---
  const moodPicked = await resolve(
    videoShaped({ musicMood: "suspenseful" }),
    null,
    { mode: "mood", moodId: "calm" }
  );
  check(
    "doc mood pick outranks the row's mood — why explains the studio pick",
    !!moodPicked && moodPicked.why.startsWith("studio mood calm") &&
      ["soft", "airy", "minimal", "neutral"].some((t) => moodPicked.track.moods.includes(t)),
    moodPicked?.why
  );

  // --- S7: a track pick outranks the row's pin ---
  const trackPicked = await resolve(
    videoShaped({ musicTrackId: calmTrack.id }),
    "suspenseful",
    { mode: "track", trackId: suspenseTrack.id }
  );
  check(
    "doc track pick outranks the row pin AND the plan mood",
    trackPicked?.track.id === suspenseTrack.id && trackPicked.why.startsWith("studio pick"),
    trackPicked?.why
  );

  // --- S7: "auto" is a real pick — it skips BOTH pins ---
  const autoPicked = await resolve(
    videoShaped({ musicTrackId: suspenseTrack.id }),
    null,
    { mode: "auto" }
  );
  check(
    "doc auto skips the row pin and re-matches the niche (calm, not suspense)",
    !!autoPicked && autoPicked.track.id === calmTrack.id && !autoPicked.why.startsWith("pinned track"),
    autoPicked?.why
  );

  // --- S7: a cross-tenant track id cannot be selected (org-scoped read) ---
  const foreign = await raw.musicTrack.findFirst({ where: { organizationId: orgB } });
  const crossTenant = await resolve(
    videoShaped({ musicTrackId: calmTrack.id }),
    null,
    { mode: "track", trackId: req("foreign org music track", foreign).id }
  );
  check(
    "a doc pick naming another org's track falls back to the row pin",
    crossTenant?.track.id === calmTrack.id && crossTenant.why.startsWith("pinned track"),
    crossTenant?.why
  );

  // --- S7: "off" refuses to pick (callers flip the music flag) ---
  const off = await resolve(videoShaped(), null, { mode: "off" });
  check("doc off resolves to null — the bed never plays against an explicit mute", off === null, off);

  // --- S7: junk doc picks fall down the chain (never crash, never hostile) ---
  const junk = await resolve(
    videoShaped({ musicTrackId: calmTrack.id }),
    null,
    { mode: "track", trackId: "does-not-exist-999" } as MusicPick
  );
  check(
    "a doc pick naming an unknown track falls back to the row pin",
    junk?.track.id === calmTrack.id && junk.why.startsWith("pinned track"),
    junk?.why
  );
  const hostile = await resolve(
    videoShaped({ musicTrackId: calmTrack.id }),
    null,
    { mode: "mood", moodId: "../../etc/passwd" } as MusicPick
  );
  check(
    "a hostile doc pick is shape-rejected at the resolver and reads as no pick",
    hostile?.track.id === calmTrack.id && hostile.why.startsWith("pinned track"),
    hostile?.why
  );

  // --- S7: a doc pick overrides the Settings master switch ---
  // (settings-on in this context; the switch override itself is pinned at the
  // route level in the S7 e2e — here we pin that an explicit pick resolves
  // even when the row would rather stay silent.)
  const overridden = await resolve(
    videoShaped({ musicEnabled: false }),
    null,
    { mode: "mood", moodId: "calm" }
  );
  check(
    "an explicit doc pick plays even when the video row says music off",
    !!overridden && overridden.why.startsWith("studio mood calm"),
    overridden?.why
  );
  const silentRow = await resolve(videoShaped({ musicEnabled: false }), null, null);
  check("no doc pick + row music off stays silent (pre-S7 behavior)", silentRow === null, silentRow);
} finally {
  if (userId) await raw.user.delete({ where: { id: userId } }).catch(() => {});
  if (orgA) await raw.organization.delete({ where: { id: orgA } }).catch(() => {});
  if (orgB) await raw.organization.delete({ where: { id: orgB } }).catch(() => {});
  await raw.$disconnect();
}

// wrap-up
console.log(failures === 0 ? "\nS7 UNIT PROBE: ALL PASS" : `\nS7 UNIT PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
