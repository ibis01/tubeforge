// Engagement kit (Phase 4 — retention comments).
//
// YouTube's comment section is a retention & distribution engine: a good
// pinned comment extends watch sessions, reply templates keep the algorithm's
// "engaged viewers" signals flowing in the first golden hour, and hearting the
// right early comments compounds reach. GLM writes a per-video kit so the
// creator can paste-and-go right after upload.

import { db } from "@/lib/db";
import { parseJsonLoose } from "./ai";
import { aiCall } from "./budget";
import { chatComplete } from "./providers/chat";
import type { CommentsKitDTO } from "./types";

export interface EngagementKitInput {
  videoId: string;
  title: string;
  topic: string;
  niche: string;
  tone: string;
  scriptExcerpt: string; // first ~1200 chars — enough context, bounded prompt
  channelName: string | null;
  characterName: string | null; // recurring host, if any
}

/** GLM writes the full engagement kit for one video. */
export async function generateEngagementKit(
  opts: EngagementKitInput
): Promise<CommentsKitDTO> {
  const toneMap: Record<string, string> = {
    informative: "knowledgeable and precise",
    dramatic: "intense and cinematic",
    humorous: "witty and playful",
    mysterious: "enigmatic and teasing",
    inspirational: "warm and uplifting",
  };
  const voice = toneMap[opts.tone] ?? "clear and engaging";

  const raw = await aiCall("llm", "engagement kit LLM", () =>
    chatComplete({
      system:
        "You are a YouTube community strategist who has managed comment sections for channels above 5M subscribers. You know exactly which pinned comments extend session time, which replies convert lurkers into commenters, and how to seed discussion without ever sounding like marketing. You always respond with STRICT JSON only — no markdown, no commentary.",
      user: `Write the launch-day engagement kit for this video.

CHANNEL: ${opts.channelName ?? "an independent faceless channel"}
${opts.characterName ? `HOST CHARACTER: ${opts.characterName} (the channel's recurring on-screen persona)` : ""}
NICHE: ${opts.niche}
VIDEO TITLE: "${opts.title}"
TOPIC: ${opts.topic}
CHANNEL VOICE: ${voice}

SCRIPT OPENING (for context only, do not quote it verbatim):
"""
${opts.scriptExcerpt}
"""

Return JSON with exactly these keys:
{
  "pinnedComment": "the pinned comment the channel posts under its own video the moment it goes live. 2-4 sentences. Opens with a hook line about the video's most surprising moment, asks ONE specific question viewers can answer without thinking hard, and ends with a light subscribe nudge. Same voice as the channel. No hashtags, no emojis, no links.",
  "replies": [
    {
      "trigger": "the archetype of viewer comment this reply is for, e.g. 'Viewer says the video was too short / wanted more depth'",
      "text": "a ready-to-paste reply, 1-2 sentences, warm and specific to this video's content, never generic. Ends with a question or forward-reference when natural."
    },
    ...exactly 4 entries covering: (1) praise/reaction, (2) a factual or 'how do you know' skeptic, (3) someone asking what to watch next, (4) a critical or negative take
  ],
  "heartTargets": ["3-4 short descriptions of early comment types to heart within the first hour, e.g. 'comments quoting their favorite scene moment'"],
  "strategy": "one paragraph (60-90 words) playbook: when to post the pinned comment, how fast to answer the first comments, what to pin later if the pinned one underperforms, and one metric to watch. Plain sentences, no bullets."
}`,
    })
  );
  const parsed = parseJsonLoose(raw);

  const pinnedComment = String(parsed.pinnedComment ?? "").trim();
  const replies = Array.isArray(parsed.replies)
    ? (parsed.replies as Record<string, unknown>[])
        .map((r) => ({
          trigger: String(r.trigger ?? "").trim(),
          text: String(r.text ?? "").trim(),
        }))
        .filter((r) => r.trigger && r.text)
        .slice(0, 4)
    : [];
  const heartTargets = Array.isArray(parsed.heartTargets)
    ? parsed.heartTargets.map(String).filter(Boolean).slice(0, 4)
    : [];
  const strategy = String(parsed.strategy ?? "").trim();

  if (!pinnedComment || replies.length < 2)
    throw new Error("Model returned an incomplete engagement kit");

  const kit: CommentsKitDTO = {
    pinnedComment,
    replies,
    heartTargets,
    strategy,
    generatedAt: new Date().toISOString(),
  };

  await db.video.update({
    where: { id: opts.videoId },
    data: { commentsKit: JSON.stringify(kit) },
  });

  await db.activity.create({
    data: {
      videoId: opts.videoId,
      stage: "comments",
      message: `Engagement kit ready — pinned comment + ${kit.replies.length} reply templates for "${opts.title}"`,
    },
  });

  return kit;
}

/** Parse a stored kit (or null). */
export function parseCommentsKit(raw: string | null): CommentsKitDTO | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CommentsKitDTO;
  } catch {
    return null;
  }
}
