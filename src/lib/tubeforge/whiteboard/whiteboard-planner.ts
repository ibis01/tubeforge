// S67 — the Whiteboard native scaffold planner (E9 Phase A / E5 phase 1).
//
// The ZERO-AI starter: builds a valid WhiteboardProject from the video's
// story scenes — narration copied per scene, asset picks from a deterministic
// keyword→library-tag rule table, placements from a per-scene-kind grid, and
// EMPTY animation arrays (timing.ts's scheduleScene fills the draw schedule
// at render/playback with the length-weighted fill law — the schedule is an
// ENGINE contract, never a planner's second implementation).
//
// The whiteboard module stays a leaf: this planner imports shared whiteboard
// modules + the story Scene type only — never Director, never generation
// APIs (the design §1 laws 1 and 5: native scaffold is $0 work).
import type { WhiteboardAssetPlacement, WhiteboardProject, WhiteboardScene } from "./storyboard";
import { WB_BUDGETS } from "./storyboard";
import type { Placement } from "./svg";

/** The minimal story-scene shape the planner consumes (parseScenes' Scene). */
export interface ScaffoldSceneInput {
  index: number;
  title: string;
  narration: string;
}

// ---------------------------------------------------------------------------
// The rule table — deterministic keyword → library-tag matching (E5 phase 1).
// Ordered: first hit wins. Tags mirror assets.ts; the fallback cycle rotates
// through the concept set so a scene with no cue still gets a varied board.
// ---------------------------------------------------------------------------

const KEYWORD_PICKS: { re: RegExp; assetId: string }[] = [
  { re: /\b(money|dollar|cost|price|revenue|budget|profit|paid|expensive|cheap)\b/i, assetId: "coin" },
  { re: /\b(grow|growth|increase|rise|trend|boost|scale|higher)\b/i, assetId: "arrow-growth" },
  { re: /\b(data|chart|stat|percent|metric|measure|number|graph)\b/i, assetId: "bar-chart" },
  { re: /\b(idea|innovate|innovation|invent|insight|think|creative)\b/i, assetId: "lightbulb" },
  { re: /\b(world|global|internet|country|countries|international|online)\b/i, assetId: "globe" },
  { re: /\b(time|deadline|schedule|minute|hour|fast|slow|wait)\b/i, assetId: "clock" },
  { re: /\b(launch|start|begin|first|pilot|ship|release)\b/i, assetId: "rocket" },
  { re: /\b(check|verify|correct|right|proven|safe|quality|benefit|advantage)\b/i, assetId: "check-badge" },
];

/** The no-cue fallback cycle (deterministic by scene position). */
const FALLBACK_CYCLE = ["lightbulb", "bar-chart", "rocket", "globe", "clock", "coin", "check-badge", "arrow-growth"] as const;

/** The concept library grid: a 320px board sits left-of-center; the
 *  title/close cards span the top when their scene kind calls for them.
 *  S68: the constants are 16:9 scene-space and are PROPORTIONALLY remapped
 *  to the project's real dimensions (9:16 / 1:1 scaffolds place sensibly —
 *  the 16:9 numbers stay the exact defaults). */
const CONCEPT_PLACEMENT: Placement = { x: 800, y: 420, scale: 1.6, rotateDeg: 0 };
const TITLE_PLACEMENT: Placement = { x: 460, y: 120, scale: 1.25, rotateDeg: 0 };
const CLOSE_PLACEMENT: Placement = { x: 460, y: 380, scale: 1.25, rotateDeg: 0 };
/** A second concept under the close card (the last scene still teaches). */
const CLOSE_CONCEPT_PLACEMENT: Placement = { x: 820, y: 560, scale: 1.4, rotateDeg: 0 };

/** Remap a 16:9 scene-space placement onto (width × height). Positions
 *  scale by axis; the scale factor keeps the 1920-wide reference size for
 *  16:9 and shrinks/grows with board width for other aspects (assets must
 *  stay on a 1080-tall board: their pixel size follows the WIDTH ratio so a
 *  9:16 board at 1080 wide draws the same asset size it would at 1080 wide
 *  in 16:9 — vertical space is what changes, not ink size). */
function remapPlacement(pl: Placement, width: number, height: number): Placement {
  const fx = width / 1920;
  const fy = height / 1080;
  return { x: Math.round(pl.x * fx), y: Math.round(pl.y * fy), scale: pl.scale * fx, rotateDeg: pl.rotateDeg };
}

function pickForScene(narration: string, position: number): string {
  for (const { re, assetId } of KEYWORD_PICKS) {
    if (re.test(narration)) return assetId;
  }
  return FALLBACK_CYCLE[position % FALLBACK_CYCLE.length];
}

/**
 * Build the starter project. PURE and DETERMINISTIC: same scenes → the same
 * project JSON byte-for-byte (the determinism law extends to the planner).
 * The caller has already enforced the scene-count wall (≤
 * WB_BUDGETS.scenesPerProject) — this function refuses beyond it rather
 * than silently truncating (a silent truncation would read as success).
 *
 * S68 — `width`/`height`/`fps` are OPTIONAL and default to the house
 * 1920×1080@24 (existing callers unchanged); placements remap
 * proportionally and the default camera key centers on the real board.
 */
export function scaffoldWhiteboardProject(input: {
  scenes: ScaffoldSceneInput[];
  topic: string;
  width?: number;
  height?: number;
  fps?: number;
}): WhiteboardProject {
  if (input.scenes.length === 0) {
    throw new Error("whiteboard scaffold needs at least one story scene");
  }
  if (input.scenes.length > WB_BUDGETS.scenesPerProject) {
    throw new Error(
      `whiteboard scaffold: ${input.scenes.length} scenes exceeds the ${WB_BUDGETS.scenesPerProject}-scene project budget — trim the story first`
    );
  }

  // Same clamp grammar as the validator (the one gate every doc passes):
  // out-of-band numbers fall back to the house defaults rather than
  // producing a project the validator would bend behind the planner's back.
  const width =
    typeof input.width === "number" && input.width >= 320 && input.width <= 3840
      ? Math.round(input.width)
      : 1920;
  const height =
    typeof input.height === "number" && input.height >= 320 && input.height <= 3840
      ? Math.round(input.height)
      : 1080;
  const fps =
    typeof input.fps === "number" && input.fps >= 12 && input.fps <= 60
      ? Math.round(input.fps)
      : 24;
  const remap = (pl: Placement) => remapPlacement(pl, width, height);

  const scenes: WhiteboardScene[] = input.scenes.map((s, i) => {
    const isFirst = i === 0;
    const isLast = i === input.scenes.length - 1 && input.scenes.length > 1;
    const placements: WhiteboardAssetPlacement[] = [];

    if (isFirst) {
      // The opener: the hero title card up top, the lead concept below.
      placements.push({ assetId: "title-hero", placement: remap(TITLE_PLACEMENT), order: 0 });
      placements.push({
        assetId: pickForScene(`${s.title} ${s.narration}`, i),
        placement: remap(CONCEPT_PLACEMENT),
        order: 1,
      });
    } else if (isLast) {
      placements.push({ assetId: "close-card", placement: remap(CLOSE_PLACEMENT), order: 0 });
      placements.push({
        assetId: pickForScene(`${s.title} ${s.narration}`, i),
        placement: remap(CLOSE_CONCEPT_PLACEMENT),
        order: 1,
      });
    } else {
      placements.push({
        assetId: pickForScene(`${s.title} ${s.narration}`, i),
        placement: remap(CONCEPT_PLACEMENT),
        order: 0,
      });
    }

    return {
      id: `scene-${s.index}`,
      narration: s.narration,
      background: "#ffffff",
      placements,
      animations: [], // scheduleScene's fill law owns the draw schedule
      camera: [{ cx: width / 2, cy: height / 2, scale: 1, startMs: 0, durationMs: 0 }],
    };
  });

  return {
    title: input.topic ? `Whiteboard — ${input.topic}`.slice(0, 120) : "Whiteboard",
    width,
    height,
    fps,
    hand: { style: "marker", scale: 1 },
    scenes,
  };
}

// ---------------------------------------------------------------------------
// The doc revision stamp — the advisory concurrency token (design §2.1).
// Stored INSIDE the doc (a `rev` key beside the project), bumped on every
// accepted PUT; a save whose rev mismatches the stored one gets a 409 with
// the server's current doc. LWW remains the final law; rev is UX.
// ---------------------------------------------------------------------------

export interface WhiteboardDoc {
  rev: number;
  project: WhiteboardProject;
}

/** Read the doc column (tolerant parse discipline: null on invalid — never
 *  throw on untrusted JSON; the house law for every doc column). */
export function parseWhiteboardDoc(raw: string | null | undefined): WhiteboardDoc | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const rev = rec.rev;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1) return null;
  // A doc without a project body is corrupt (a truncated write), not an
  // empty one — null reads as "no project", which is the honest state.
  if (typeof rec.project !== "object" || rec.project === null) return null;
  return { rev, project: rec.project as WhiteboardProject };
}

/** Serialize doc + rev for storage (stable key order the house writes). */
export function serializeWhiteboardDoc(doc: WhiteboardDoc): string {
  return JSON.stringify({ rev: doc.rev, project: doc.project });
}
