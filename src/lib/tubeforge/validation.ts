// validation.ts — shared Zod schemas + a consistent parse-or-400 helper for
// TubeForge API routes.
//
// Why: request bodies were validated ad-hoc per route (some not at all).
// Every schema here enforces string length caps, enums and numeric ranges so
// a runaway or hostile payload fails fast with a readable message instead of
// reaching the pipeline. Add new schemas here rather than inline checks.

import { z } from "zod";
import { NextResponse } from "next/server";

// ------------------------------------------------------------- helpers

export class ApiValidationError extends Error {
  constructor(
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "ApiValidationError";
  }
}

/** Parse a JSON request body against a schema; throws ApiValidationError. */
export async function parseJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiValidationError("Request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ApiValidationError(`${where}${issue?.message ?? "Invalid request body"}`);
  }
  return parsed.data;
}

/**
 * Like parseJson, but an empty/invalid JSON body falls back to `fallback`
 * (for endpoints that treat "no body" as "use defaults"). Schema violations
 * still throw — only the body's ABSENCE is lenient.
 */
export async function parseJsonLenient<T>(
  req: Request,
  schema: z.ZodType<T>,
  fallback: T
): Promise<T> {
  let text = "";
  try {
    text = await req.text();
  } catch {
    return fallback;
  }
  if (!text.trim()) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiValidationError("Request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ApiValidationError(`${where}${issue?.message ?? "Invalid request body"}`);
  }
  return parsed.data;
}

/** Turn an ApiValidationError into the standard 400 JSON response. */
export function validationError(err: unknown): NextResponse {
  if (err instanceof ApiValidationError)
    return NextResponse.json({ error: err.message }, { status: 400 });
  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "Must be a valid http(s) URL");

// ------------------------------------------------------------- schemas

/** POST /api/videos — create a video (script or story format). */
export const videoCreateSchema = z.object({
  topic: z.string().trim().min(1, "Topic is required").max(300, "Topic is limited to 300 characters"),
  niche: z.string().trim().min(1).max(80).default("Motivation"),
  tone: z.string().trim().min(1).max(40).default("informative"),
  length: z.enum(["short", "medium", "long"]).default("medium"),
  voice: z.string().trim().min(1).max(40).default("jam"),
  ttsSpeed: z.coerce.number().min(0.5).max(2).default(1.0),
  thumbStyle: z.string().trim().min(1).max(40).default("cinematic"),
  channelId: z.string().trim().max(64).nullish(),
  characterId: z.string().trim().max(64).nullish(),
  format: z.string().max(20).default("script"), // whitelisted against FORMATS in the route
  renderMode: z.string().max(20).default("kenburns"), // whitelisted against RENDER_MODES
  transition: z.string().max(24).optional(),
  musicTrack: z.string().trim().max(80).optional(),
  sceneLimit: z.coerce.number().int().min(1).max(32).optional(),
  language: z.string().trim().max(30).optional(),
});

/** PUT /api/settings — key/value app settings (route filters to its whitelist). */
export const settingsUpdateSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(2000), z.boolean(), z.number()])
);

/** PUT/POST /api/settings/ai — Z.ai credentials or one capability's provider.
 *  baseUrl accepts "" (the UI sends it to clear a saved endpoint). */
export const aiSettingsSchema = z.object({
  scope: z.string().max(20).optional(),
  capability: z.string().max(20).optional(),
  baseUrl: z.union([httpUrl, z.literal("")]).optional(),
  apiKey: z.string().trim().max(400).optional(),
  provider: z.string().trim().max(40).optional(),
  model: z.string().trim().max(120).optional(),
  visionModel: z.string().trim().max(120).optional(),
  copyCredsFrom: z.string().max(20).optional(),
  // TTS test overrides + explicit-cost confirmation for video tests
  voice: z.string().trim().max(80).optional(),
  confirmCost: z.boolean().optional(),
});

/** POST /api/videos/[id]/voiceover — bring-your-own-voice url branch. */
export const voiceImportSchema = z.object({
  mode: z.literal("url"),
  url: httpUrl,
  label: z.string().trim().max(80).optional(),
});

/** POST /api/research — topic research runs (topic string + optional opts). */
export const researchSchema = z.object({
  topic: z.string().trim().min(1).max(200),
  niche: z.string().trim().max(80).optional(),
});

// ------------------------------------------------------------- Stage 6 schemas

/** POST /api/videos/[id]/publish — enqueue a YouTube upload job.
 *  Title/description/tags clamp to YouTube's own limits (the upload path
 *  re-clamps too; this lets the UI show "97/100 chars" against the same
 *  boundary). publishAt accepts a future ISO timestamp (or null = publish
 *  immediately). thumbnailStorageKey is the storage key of a custom thumbnail
 *  the user picked from the variant set; null/omitted → use the project's
 *  primary thumbnail.png. */
export const publishSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(100, "YouTube caps titles at 100 chars"),
  description: z.string().trim().max(4900, "YouTube caps descriptions at ~5000 chars").default(""),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  thumbnailStorageKey: z.string().trim().max(256).nullish(),
  privacyStatus: z.enum(["public", "unlisted", "private"]).optional(),
  publishAt: z.string().trim().max(40).nullish(), // ISO date or null
});

/** PUT /api/videos/[id]/assemble — save a user-edited timeline.
 *  The body is the AssembledTimeline JSON itself; the schema validates
 *  structure (not the deep scene content — that's the video row's job).
 *  The route persists it so the render job consumes the saved version.
 *
 *  sceneOrder (optional): the play order as an array of scene indices —
 *  present whenever the editor reordered clips. The route rewrites the
 *  video row's scenes array into the SAME order (one update, doc + row
 *  in lockstep) so the render — which maps timeline durations onto the
 *  row's scenes by POSITION — can never see the two disagree. */
export const assembleSaveSchema = z.object({
  scenes: z
    .array(
      z.object({
        index: z.number().int().min(1),
        startSec: z.number().min(0),
        endSec: z.number().min(0),
        durationSec: z.number().min(0.1),
      }).passthrough()
    )
    .min(1, "Timeline must contain at least one scene"),
  totalDurationSec: z.number().min(0),
  generatedAt: z.string().optional(),
  sceneOrder: z.array(z.number().int().min(1)).optional(),
  /** S3 — render preferences riding the doc root (quality tier). */
  renderPrefs: z
    .object({
      quality: z.enum(["draft", "standard", "high"]),
    })
    .optional(),
});

/** PATCH /api/videos/[id] — Stage 6 render defaults (aspect / frameRate /
 *  burnCaptions). These ride alongside the existing fields on the same
 *  PATCH endpoint (route-level schema extension). */
export const renderDefaultsSchema = z.object({
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
  frameRate: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(),
  burnCaptions: z.boolean().optional(),
});

/** POST /api/videos/[id]/studio/clip — Timeline Studio clip operations
 *  (split / duplicate / delete / revoice). Split needs the playhead's local
 *  time in the scene window; revoice needs the edited narration text. */
export const clipOpSchema = z
  .object({
    action: z.enum(["split", "duplicate", "delete", "revoice"]),
    sceneIndex: z.number().int().min(1).max(9999),
    atSec: z.number().finite().min(0).max(3600).optional(),
    narration: z.string().max(4000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "split" && typeof v.atSec !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["atSec"],
        message: "atSec is required for split",
      });
    }
    if (v.action === "revoice" && !(v.narration ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["narration"],
        message: "narration is required for revoice",
      });
    }
  });
