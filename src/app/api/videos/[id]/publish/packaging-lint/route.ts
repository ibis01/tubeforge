// POST /api/videos/[id]/publish/packaging-lint — S70 Creator Intelligence
// CI-2: Packaging Intelligence for the publish form.
//
// Lints title + thumbnail as ONE pairing — truncation at render width,
// duplication (the title says what the thumb shows), vagueness — plus an
// optional VLM lookability pass when a thumbnail exists. Deterministic
// checks always run (unit-pinned); the VLM rides the llm.ts seam through
// budget.ts's choke point.
//
// Inputs default from the video row (title; the standing thumbnail.png
// when hasThumbnail), and the publish form's DRAFT edits can be sent as
// body overrides — the lint runs on suggest output and user edits alike
// (the record's requirement). PROPSES, never blocks: the report informs
// the human; the publish gate is untouched. Every score is a heuristic.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { lintPackaging } from "@/lib/tubeforge/packaging-lint";
import { readMedia } from "@/lib/tubeforge/ai";
import { errorText } from "@/lib/tubeforge/redact";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    thumbnailText?: string;
    /** Skip the VLM pass even when a thumbnail exists (cheap lint). */
    deterministicOnly?: boolean;
  };
  const title = (body.title ?? video.title ?? "").trim();
  if (!title)
    return NextResponse.json({ error: "No title to lint — write one first" }, { status: 400 });

  // The standing thumbnail (when one exists) feeds the VLM pass; a
  // body.thumbnailText override carries the overlay words the form is
  // drafting. readMedia is the scoped media seam the thumbnail route uses.
  let thumbnailDataUrl: string | undefined;
  if (!body.deterministicOnly && video.hasThumbnail) {
    try {
      const bytes = await readMedia(id, "thumbnail.png");
      if (bytes && bytes.length > 0) {
        thumbnailDataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
      }
    } catch {
      /* no servable thumbnail — the deterministic lint still runs */
    }
  }

  try {
    const report = await lintPackaging({
      title,
      thumbnailText: body.thumbnailText,
      thumbnailDataUrl,
    });
    return NextResponse.json({ report, heuristic: true });
  } catch (err) {
    const message = errorText(err, "Packaging lint failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
