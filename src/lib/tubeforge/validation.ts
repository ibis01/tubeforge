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
