// POST /api/videos/analyze-script
//
// Runs a pasted script through the LLM analysis engine and returns a
// structured verdict. The UI uses this BEFORE creating a video so the user
// can approve / edit / reject the script with full information.
//
// This endpoint does NOT persist anything — pure analysis. The actual
// video creation happens via POST /api/videos with `script` + `approved: true`
// (the approval is the user's signal they accept the analysis verdict).

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { analyzeScript } from "@/lib/tubeforge/script-analysis";

const MAX_SCRIPT = 50000;
const MAX_TOPIC = 300;

export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  try {
    const body = await req.json();

    // Script is required — analyze nothing without it.
    if (typeof body.script !== "string")
      return NextResponse.json(
        { error: "Field `script` (string) is required" },
        { status: 400 }
      );
    if (body.script.length > MAX_SCRIPT)
      return NextResponse.json(
        { error: `Script too long (max ${MAX_SCRIPT} chars)` },
        { status: 400 }
      );

    const topic = String(body.topic ?? "").trim();
    if (topic.length > MAX_TOPIC)
      return NextResponse.json({ error: "Topic too long" }, { status: 400 });

    const niche = String(body.niche ?? "Motivation");
    const tone = String(body.tone ?? "informative");
    const length = String(body.length ?? "medium");

    const analysis = await analyzeScript({ script: body.script, topic, niche, tone, length });
    return NextResponse.json({ analysis });
  } catch {
    return NextResponse.json(
      { error: "Script analysis failed — check Settings → AI Providers" },
      { status: 500 }
    );
  }
}
