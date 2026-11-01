import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { invalidateRenderedArtifacts } from "@/lib/tubeforge/render";
import { brandLogoKey, sanitizeBrandAccent } from "@/lib/tubeforge/slides";
import * as storage from "@/lib/tubeforge/storage";

type Ctx = { params: Promise<{ id: string }> };

const LOGO_MIME: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
};
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

/** GET — serve the uploaded brand logo (UI preview on the brand kit card). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  // Scoped lookup FIRST — the uploads/<id>/brand-logo.* file is only served
  // after the row is proven to belong to the caller's organization.
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const key = await brandLogoKey(id);
  if (!key)
    return NextResponse.json({ error: "No brand logo uploaded" }, { status: 404 });

  const ext = key.split(".").pop() ?? "";
  let body: Buffer;
  try {
    body = await storage.get(key);
  } catch {
    return NextResponse.json({ error: "No brand logo uploaded" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": LOGO_MIME[ext] ?? "application/octet-stream",
      "Content-Length": String(body.length),
      "Cache-Control": "private, no-cache",
    },
  });
}

/**
 * POST — upload the brand logo (multipart: file). PNG / WebP / SVG up to
 * 5 MB; transparency-friendly formats so it sits clean on any slide.
 * The badge shows on every keynote slide (until switched off), and the
 * rendered video becomes stale.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form with a logo file" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ error: "Attach the logo as the 'file' field" }, { status: 400 });

  const ext =
    file.type === "image/png" ? "png"
    : file.type === "image/webp" ? "webp"
    : file.type === "image/svg+xml" ? "svg"
    : null;
  if (!ext)
    return NextResponse.json(
      { error: "Logos must be PNG, WebP, or SVG (transparency-friendly formats)" },
      { status: 400 }
    );
  if (file.size > MAX_LOGO_BYTES)
    return NextResponse.json({ error: "Logo exceeds the 5 MB limit" }, { status: 413 });

  // One logo per video — remove other variants first (ext may change).
  // Stage 4a (T-4.0): the logo is a storage object, so variant swaps go
  // through the driver (s3-safe, quota-correct).
  for (const e of Object.keys(LOGO_MIME)) {
    if (e !== ext) await storage.remove(`${id}/brand-logo.${e}`).catch(() => {});
  }
  await storage.put(`${id}/brand-logo.${ext}`, Buffer.from(await file.arrayBuffer()));

  // The badge is baked into slide PNGs at screenshot time — stale now.
  await invalidateRenderedArtifacts(id, { slidePngs: true });
  await db.video.update({
    where: { id },
    data: { brandLogoOn: true, hasVideo: false, videoDuration: null, error: null },
  });
  await db.activity.create({
    data: {
      organizationId: auth.ctx.organizationId,
      userId: auth.ctx.userId,
      videoId: id,
      stage: "storyboard",
      message: `Brand logo uploaded (${ext.toUpperCase()}) — badge shows on every slide`,
    },
  });

  return NextResponse.json({ ok: true, hasLogo: true, logoUrl: `/api/videos/${id}/brand` });
}

/**
 * PATCH — brand kit settings. Body: { accent?: "#rrggbb"|null,
 * showLogo?: boolean }. Accent null = back to the built-in per-slide
 * catalog accents. Both are baked into the slide PNGs, so both invalidate.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const data: Record<string, unknown> = {};
  let changed = false;

  if (body?.accent !== undefined) {
    if (body.accent === null) {
      data.brandAccent = null;
      changed = true;
    } else {
      const hex = sanitizeBrandAccent(body.accent);
      if (!hex)
        return NextResponse.json(
          { error: "Accent must be a hex color like #0A7CFF" },
          { status: 400 }
        );
      data.brandAccent = hex;
      changed = true;
    }
  }
  if (typeof body?.showLogo === "boolean") {
    data.brandLogoOn = body.showLogo;
    changed = true;
  }

  if (!changed)
    return NextResponse.json({ error: "Nothing to update — send accent or showLogo" }, { status: 400 });

  await invalidateRenderedArtifacts(id, { slidePngs: true });
  const updated = await db.video.update({
    where: { id },
    data: { ...data, hasVideo: false, videoDuration: null, error: null },
  });

  return NextResponse.json({
    ok: true,
    brandAccent: updated.brandAccent,
    brandLogoOn: updated.brandLogoOn ?? true,
  });
}

/** DELETE — remove the brand logo (badge disappears from every slide). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  for (const e of Object.keys(LOGO_MIME)) {
    await storage.remove(`${id}/brand-logo.${e}`).catch(() => {});
  }

  await invalidateRenderedArtifacts(id, { slidePngs: true });
  await db.video.update({ where: { id }, data: { brandLogoOn: null } });
  await db.activity.create({
    data: {
      organizationId: auth.ctx.organizationId,
      userId: auth.ctx.userId,
      videoId: id,
      stage: "storyboard",
      message: "Brand logo removed",
    },
  });

  return NextResponse.json({ ok: true, hasLogo: false });
}
