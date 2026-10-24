// Character (Cast) AI services — character bible via GLM, reference portraits via
// CogView, and identity-consistent pose sheets via image-to-image editing.
// The `identityAnchor` is the canonical visual description reused verbatim in
// every future generation so the character stays recognizable across scenes.

import fs from "fs";
import path from "path";
import type { Character } from "@prisma/client";
import { POSES, ART_STYLES } from "./types";
import { getZAI, parseJsonLoose } from "./ai";
import { aiCall } from "./budget";
import { characterJobSnapshot, lastJobError } from "./jobs";

const CHARACTER_ROOT = path.join(process.cwd(), "uploads", "characters");

/** Shape a Prisma character row (with optional video count) into the API DTO. */
export function serializeCharacter(
  c: Character,
  videoCount = 0
): import("./types").CharacterDTO {
  const poseIds = new Set(listPoses(c.id));
  return {
    id: c.id,
    name: c.name,
    role: c.role,
    personality: c.personality,
    appearance: c.appearance,
    identityAnchor: c.identityAnchor,
    voice: c.voice,
    artStyle: c.artStyle,
    hasPortrait: c.hasPortrait,
    videoCount,
    poseCount: poseIds.size,
    portraitUrl: c.hasPortrait ? `/api/characters/${c.id}/portrait` : null,
    poseUrls: POSES.filter((p) => poseIds.has(p.id)).map((p) => ({
      pose: p.id,
      label: p.label,
      url: `/api/characters/${c.id}/poses/${p.id}`,
    })),
    generating: characterJobSnapshot(c.id),
    error: lastJobError(c.id, "portrait") ?? lastJobError(c.id, "poses"),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function characterDir(characterId: string) {
  const dir = path.join(CHARACTER_ROOT, characterId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function portraitExists(characterId: string): boolean {
  return fs.existsSync(path.join(CHARACTER_ROOT, characterId, "portrait.png"));
}

export function readPortrait(characterId: string): Buffer | null {
  const p = path.join(CHARACTER_ROOT, characterId, "portrait.png");
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

export function readPose(
  characterId: string,
  pose: string
): Buffer | null {
  if (!POSES.some((p) => p.id === pose)) return null;
  const p = path.join(CHARACTER_ROOT, characterId, `pose-${pose}.png`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

export function listPoses(characterId: string): string[] {
  const dir = path.join(CHARACTER_ROOT, characterId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^pose-[\w-]+\.png$/.test(f))
    .map((f) => f.replace("pose-", "").replace(".png", ""));
}

export function deleteCharacterFiles(characterId: string) {
  const dir = path.join(CHARACTER_ROOT, characterId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Fallback anchor built from user fields when GLM hasn't crafted one. */
export function buildAnchorFallback(appearance: string | null, artStyle: string): string {
  const style =
    ART_STYLES.find((s) => s.id === artStyle)?.prompt ?? ART_STYLES[0].prompt;
  return [appearance?.trim(), style].filter(Boolean).join(". ");
}

export interface CharacterBible {
  personality: string;
  appearance: string;
  identityAnchor: string;
  voice: string;
  artStyle: string;
  role: string;
}

/** GLM "character bible" — expands a short concept into a full, generation-ready profile. */
export async function generateCharacterBible(opts: {
  name: string;
  concept: string;
  niche?: string;
}): Promise<CharacterBible> {
  const zai = await getZAI();
  const completion = await aiCall("llm", "character bible LLM", () =>
    zai.chat.completions.create({
    messages: [
      {
        role: "assistant",
        content:
          "You are a character designer for faceless YouTube channels. You invent memorable recurring hosts/personas that stay visually consistent across hundreds of videos and speak in ways that keep retention high. You always respond with STRICT JSON only — no markdown, no commentary.",
      },
      {
        role: "user",
        content: `Design a recurring on-screen persona for a faceless YouTube channel${opts.niche ? ` in the "${opts.niche}" niche` : ""}.

Name: ${opts.name}
Concept/notes: ${opts.concept || "(designer's choice — invent something compelling)"}

Return JSON with exactly these keys:
{
  "role": "one-line role, e.g. 'Host — skeptical science storyteller'",
  "personality": "2-3 sentences: on-screen energy, speech style, catchphrases or verbal tics, how they open and close videos",
  "appearance": "2-3 sentences of FIXED visual identity: age range, hair, face, glasses/accessories, signature outfit, body language. Specific enough that an artist could draw them identically every time",
  "identityAnchor": "ONE dense comma-separated visual prompt fragment (age, hair, facial hair, glasses, outfit colors, art style hints) describing ONLY the invariant visual traits. Max 60 words. No camera or lighting words.",
  "voice": "one of: jam, kazi, xiaochen, tongtong, chuichui, douji, luodo — pick the TTS voice that matches the persona's energy",
  "artStyle": "one of: cinematic, stylized, anime, comic, noir — pick the portrait art style that fits"
}`,
      },
    ],
    thinking: { type: "disabled" },
    }));

  const raw = completion.choices[0]?.message?.content ?? "";
  const parsed = parseJsonLoose(raw);

  const bible: CharacterBible = {
    role: String(parsed.role ?? "").trim(),
    personality: String(parsed.personality ?? "").trim(),
    appearance: String(parsed.appearance ?? "").trim(),
    identityAnchor: String(parsed.identityAnchor ?? "").trim(),
    voice: String(parsed.voice ?? "jam").trim(),
    artStyle: String(parsed.artStyle ?? "cinematic").trim(),
  };
  if (!bible.appearance) throw new Error("Character bible returned no appearance");
  return bible;
}

/** Reference portrait via CogView (1024x1024) — the canonical look of the character. */
export async function generateCharacterPortrait(opts: {
  characterId: string;
  name: string;
  appearance: string | null;
  identityAnchor: string | null;
  artStyle: string;
}): Promise<{ fileBytes: number }> {
  const zai = await getZAI();
  const anchor = opts.identityAnchor?.trim() || buildAnchorFallback(opts.appearance, opts.artStyle);
  const style =
    ART_STYLES.find((s) => s.id === opts.artStyle)?.prompt ?? ART_STYLES[0].prompt;

  const response = await aiCall(
    "image",
    "character portrait",
    () =>
      zai.images.generations.create({
        prompt: `Official character reference portrait of "${opts.name}". ${anchor}. ${style}. Head-and-shoulders framing, facing camera, neutral studio backdrop, crisp detail, personality visible in the expression. Absolutely no text, no letters, no watermarks.`,
        size: "1024x1024",
      }),
    { attempts: 4, baseDelayMs: 5000 }
  );

  const base64 = response.data[0]?.base64;
  if (!base64) throw new Error("Portrait generation returned no data");
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length < 1000) throw new Error("Generated portrait is empty");

  fs.writeFileSync(
    path.join(characterDir(opts.characterId), "portrait.png"),
    buffer
  );
  return { fileBytes: buffer.length };
}

/**
 * Identity-consistency sheet — re-renders the SAME character in 3 canonical poses
 * using image-to-image editing seeded from the reference portrait.
 * These poses are the storyboard building blocks for Phase 2 (story engine).
 */
export async function generateCharacterPoses(opts: {
  characterId: string;
  identityAnchor: string | null;
}): Promise<{ generated: string[] }> {
  const zai = await getZAI();
  const portrait = readPortrait(opts.characterId);
  if (!portrait)
    throw new Error("Generate the reference portrait first — poses are derived from it");

  const anchor = opts.identityAnchor?.trim();
  const dir = characterDir(opts.characterId);
  const generated: string[] = [];

  for (const [i, pose] of POSES.entries()) {
    const dataUrl = `data:image/png;base64,${portrait.toString("base64")}`;
    const response = await aiCall(
      "image",
      `pose:${pose.id}`,
      () =>
        zai.images.generations.edit({
          prompt: `Exact same character, identical face, hair, glasses, outfit and art style as the reference image. ${anchor ? `Visual identity: ${anchor}.` : ""} New pose: ${pose.desc}. Identical lighting and backdrop as the reference. Absolutely no text, no letters, no watermarks.`,
          images: [{ url: dataUrl }],
          size: "1024x1024",
        }),
      { attempts: 4, baseDelayMs: 5000 }
    );
    const base64 = response.data[0]?.base64;
    if (!base64) throw new Error(`Pose "${pose.id}" returned no data`);
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length < 1000) throw new Error(`Pose "${pose.id}" image is empty`);
    fs.writeFileSync(path.join(dir, `pose-${pose.id}.png`), buffer);
    generated.push(pose.id);
    // Pace the edit calls — back-to-back image calls trip upstream burst limits.
    if (i < POSES.length - 1) await new Promise((r) => setTimeout(r, 2000));
  }

  return { generated };
}

/** Prompt fragment that stamps the character's identity onto any scene generation. */
export function characterSceneFragment(character: {
  name: string;
  identityAnchor: string | null;
  appearance: string | null;
}): string {
  const anchor =
    character.identityAnchor?.trim() ||
    character.appearance?.trim() ||
    "";
  if (!anchor) return "";
  return `Featuring the recurring host "${character.name}" — invariant visual identity: ${anchor}. Keep every identifying trait exactly consistent.`;
}
