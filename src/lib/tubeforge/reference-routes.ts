// S51 — the reference-photo HTTP seam, shared by all three libraries
// (characters / locations / props). One factory, one contract: cap
// enforcement, key validation, activity rows, and error shapes live HERE so
// the three families can never drift apart — the exact class of divergence
// the audits keep catching. Route files are thin re-exports.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "./tenant";
import { db } from "./tenant-db";
import * as storage from "./storage";
import {
  parseReferenceKeys,
  isReferenceKey,
  saveReferenceImage,
  removeReferenceFile,
  referenceInfos,
} from "./references";

/** What every carrier row must give the seam (all three models have exactly
 * these columns — tenant-db injects organizationId so a foreign id reads as
 * the same 404 as a missing one). */
export interface ReferenceCarrier {
  id: string;
  name: string;
  referenceImages: string | null;
}

export interface ReferenceHandlerDeps {
  /** "character" | "location" | "prop" — error copy + activity stage. */
  noun: "character" | "location" | "prop";
  /** Storage prefix for this carrier: `characters/<id>` etc. */
  prefixFor: (id: string) => string;
  /** Per-library cap (6 cast / 4 world). */
  cap: number;
  /** Tenant-scoped row load, or null. */
  find: (id: string) => Promise<ReferenceCarrier | null>;
  /** Persist the new key array (the prisma update result is ignored). */
  saveKeys: (id: string, keys: string[]) => Promise<unknown>;
  /** Activity stage for the log rows. */
  stage: string;
}

export function makeReferenceHandlers(deps: ReferenceHandlerDeps) {
  const listUrl = (id: string, key: string) =>
    `/api/${deps.noun === "character" ? "characters" : deps.noun === "location" ? "locations" : "props"}/${id}/references/${key.split("/").pop()}`;

  async function currentKeys(id: string): Promise<string[] | null> {
    const row = await deps.find(id);
    return row ? parseReferenceKeys(row.referenceImages) : null;
  }

  /** GET — the reference list (key, url, bytes; oldest first). */
  const list = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await requireUser(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    auth.enter();

    const { id } = await ctx.params;
    const keys = await currentKeys(id);
    if (keys === null)
      return NextResponse.json({ error: `${deps.noun} not found` }, { status: 404 });
    return NextResponse.json({
      references: await referenceInfos(keys, (key) => listUrl(id, key)),
    });
  };

  /** POST — append one reference photo (multipart: file). */
  const add = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await requireUser(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    auth.enter();

    const { id } = await ctx.params;
    const row = await deps.find(id);
    if (!row) return NextResponse.json({ error: `${deps.noun} not found` }, { status: 404 });

    const keys = parseReferenceKeys(row.referenceImages);
    if (keys.length >= deps.cap)
      return NextResponse.json(
        { error: `Reference limit reached — up to ${deps.cap} per ${deps.noun}` },
        { status: 409 }
      );

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { error: "Expected a multipart form with an image file" },
        { status: 400 }
      );
    }
    const file = form.get("file");
    if (!(file instanceof File))
      return NextResponse.json({ error: "Attach the image as the 'file' field" }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    let saved: { key: string; bytes: number };
    try {
      saved = await saveReferenceImage(deps.prefixFor(id), keys, buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Reference upload failed";
      const status = message.includes("exceeds") ? 413 : 400;
      return NextResponse.json({ error: message }, { status });
    }

    const next = [...keys, saved.key];
    await deps.saveKeys(id, next);
    await db.activity.create({
      data: {
        organizationId: auth.ctx.organizationId,
        userId: auth.ctx.userId,
        stage: deps.stage,
        message: `Reference photo added to ${deps.noun} "${row.name}" (${Math.round(saved.bytes / 1024)} KB)`,
      },
    });

    return NextResponse.json(
      { references: await referenceInfos(next, (key) => listUrl(id, key)) },
      { status: 201 }
    );
  };

  /** DELETE — remove one reference (?key=<storage key>). */
  const remove = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await requireUser(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    auth.enter();

    const { id } = await ctx.params;
    const row = await deps.find(id);
    if (!row) return NextResponse.json({ error: `${deps.noun} not found` }, { status: 404 });

    const key = new URL(req.url).searchParams.get("key") ?? "";
    const prefix = deps.prefixFor(id);
    if (!isReferenceKey(prefix, key) || !parseReferenceKeys(row.referenceImages).includes(key))
      return NextResponse.json({ error: "No such reference on this " + deps.noun }, { status: 404 });

    const next = parseReferenceKeys(row.referenceImages).filter((k) => k !== key);
    await removeReferenceFile(key);
    await deps.saveKeys(id, next);
    await db.activity.create({
      data: {
        organizationId: auth.ctx.organizationId,
        userId: auth.ctx.userId,
        stage: deps.stage,
        message: `Reference photo removed from ${deps.noun} "${row.name}"`,
      },
    });

    return NextResponse.json({
      references: await referenceInfos(next, (k) => listUrl(id, k)),
    });
  };

  /** GET — serve one reference PNG (the [file] dynamic segment). */
  const serve = async (req: NextRequest, ctx: { params: Promise<{ id: string; file: string }> }) => {
    const auth = await requireUser(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    auth.enter();

    const { id, file } = await ctx.params;
    if (!/^ref-\d+\.png$/.test(file))
      return NextResponse.json({ error: "Not a reference file" }, { status: 404 });

    const row = await deps.find(id);
    if (!row) return NextResponse.json({ error: `${deps.noun} not found` }, { status: 404 });

    const key = `${deps.prefixFor(id)}/${file}`;
    if (!parseReferenceKeys(row.referenceImages).includes(key))
      return NextResponse.json({ error: "Reference not found" }, { status: 404 });

    const png = await storage.get(key).catch(() => null);
    if (!png) return NextResponse.json({ error: "Reference not found" }, { status: 404 });
    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
        "Cache-Control": "no-store",
      },
    });
  };

  return { list, add, remove, serve };
}
