import { NextRequest, NextResponse } from "next/server";
import { readPose } from "@/lib/tubeforge/characters";

type Ctx = { params: Promise<{ id: string; pose: string }> };

/** GET — stream one identity-locked pose PNG. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id, pose } = await ctx.params;
  const png = readPose(id, pose);
  if (!png)
    return NextResponse.json({ error: "Pose not generated yet" }, { status: 404 });
  return new NextResponse(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.length),
      "Cache-Control": "no-store",
    },
  });
}
