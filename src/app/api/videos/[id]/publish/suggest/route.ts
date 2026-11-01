// POST /api/videos/[id]/publish/suggest — Stage 6 T-6.5: LLM-driven
// publish metadata suggestions for the publish form.
//
// Returns a draft { title, description, tags } the user reviews and edits
// before clicking Publish. The "AI suggests + human approves" doctrine from
// Stage 5 carries over — the LLM never publishes anything; the user does.
//
// Body (all optional): { toneStyle?: "clickbait"|"descriptive"|"question"|"curiosity" }
// 400 when the video has neither a script nor scene captions (nothing to draft from).
// 503 / 400 when the LLM call fails or returns junk (the message surfaces to the form).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes } from "@/lib/tubeforge/story";
import { suggestPublishMeta, type SuggestTone } from "@/lib/tubeforge/publish-suggest";
import { errorText } from "@/lib/tubeforge/redact";

type Ctx = { params: Promise<{ id: string }> };

const TONE_STYLES: SuggestTone[] = ["clickbait", "descriptive", "question", "curiosity"];

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const toneStyle: SuggestTone =
    typeof body?.toneStyle === "string" && TONE_STYLES.includes(body.toneStyle)
      ? body.toneStyle
      : "descriptive";

  const scenes = parseScenes(video.scenes);
  const captions = scenes.map((s) => s.caption).filter((c) => c.trim().length > 0);

  if (!video.script && captions.length === 0) {
    return NextResponse.json(
      { error: "Cannot suggest metadata — generate a script first" },
      { status: 400 }
    );
  }

  try {
    const suggestion = await suggestPublishMeta({
      topic: video.topic,
      niche: video.niche,
      tone: video.tone,
      script: video.script,
      sceneCaptions: captions,
      toneStyle,
    });
    return NextResponse.json({ suggestion });
  } catch (err) {
    const message = errorText(err, "Publish suggestion failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
