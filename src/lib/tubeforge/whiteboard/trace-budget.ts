// P0 — the raster-to-stroke TRACE BUDGETS (the whiteboard-production-system
// audit's P0-5). Pure constants + one pure cap arithmetic — no imports, no
// fs, no clock, no randomness. The upload gates (upload.ts), the scheduler
// cap (timing.ts / beat-plan.ts) and the unit battery
// (scripts/test-whiteboard-trace.mts) all cite THIS file as the one source.
//
// Why the budgets exist, in one paragraph: a photo trace explodes the two
// walls the SVG upload lane already enforces (512 commands/path,
// 2,048/asset — assets.ts WB_PATH_COMMAND_BUDGET + upload.ts
// WB_UPLOAD_TOTAL_COMMAND_BUDGET). Skeleton centerlines simplify well below
// the per-path wall, but photo-density assets legitimately need a higher
// per-asset total. Over-budget output is never silently truncated: the
// shortest strokes drop FIRST and the receipt records the drop (the honest-
// receipt law, same shape as the frame-truth and QC receipts).

/** Per-path command ceiling for a traced stroke (expanded commands, the
 *  countPathCommands unit of account). A skeleton polyline simplifies far
 *  below this; a winding stroke that refuses is re-simplified with a
 *  growing epsilon until it fits (endpoints always survive Douglas-
 *  Peucker, so geometry stays connected). */
export const WB_TRACED_PATH_BUDGET = 96;

/** Per-asset TOTAL command ceiling for traced output — raised from the
 *  SVG upload's 2,048 because photo-density line art legitimately carries
 *  more ink. Over-budget → drop the shortest strokes first, record the
 *  drop in the receipt, never silently. */
export const WB_TRACED_TOTAL_BUDGET = 4096;

/** Per-placement stroke ceiling: a placement of a traced asset draws at
 *  most its first `cap` strokes under the fill-law window; the remainder
 *  reveal with a group fade at the stroke-completion boundary (the
 *  reveal_color grammar — no new event type). The EFFECTIVE cap is
 *  window-aware: the fill law pays MIN_PATH_MS (260) + PATH_GAP_MS (130)
 *  per drawn stroke, so a window only honestly fits
 *  floor(windowMs / WB_TRACED_ITEM_FLOOR_MS) strokes. */
export const WB_TRACED_STROKES_PER_PLACEMENT = 120;

/** The fade that reveals the over-cap remainder of a traced placement —
 *  rides the existing reveal_color event (per-path), no new event type. */
export const WB_TRACED_FADE_MS = 600;

/** Per-drawn-stroke window cost used by the effective-cap arithmetic:
 *  MIN_PATH_MS (260) + PATH_GAP_MS (130). Mirrors timing.ts's constants —
 *  kept here as a literal because trace-budget must stay import-free
 *  (timing.ts imports THIS module, not the reverse). */
export const WB_TRACED_ITEM_FLOOR_MS = 390;

/** The effective cap for one draw window: never more than `cap` strokes,
 *  never more than the window honestly fits, never fewer than 1. PURE and
 *  deterministic — the scheduler and the unit battery pin this arithmetic. */
export function tracedCapForWindow(winMs: number, cap: number = WB_TRACED_STROKES_PER_PLACEMENT): number {
  const byWindow = Math.floor(winMs / WB_TRACED_ITEM_FLOOR_MS);
  return Math.max(1, Math.min(cap, byWindow));
}
