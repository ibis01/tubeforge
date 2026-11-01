import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { readPose } from "@/lib/tubeforge/characters";

type Ctx = { params: Promise<{ id: string; pose: string }> };

/** GET — stream one identity-locked pose PNG. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id, pose } = await ctx.params;
  // Scoped lookup FIRST — uploads/characters/<id>/pose-*.png files are only
  // read after the row is proven to belong to the caller's organization.
  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  const png = await readPose(id, pose);
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
