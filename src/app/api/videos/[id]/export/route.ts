import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { Readable } from "stream";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { safeZipName, streamZip, zipMethodFor, type StreamZipEntry } from "@/lib/tubeforge/zip";
import { listVariants } from "@/lib/tubeforge/ai";
import { parseScenes, sceneImageFile } from "@/lib/tubeforge/story";
import { LENGTHS, TONES, VOICES } from "@/lib/tubeforge/types";
import { resolveMusicForVideo, isMusicEnabledForVideo, musicBedActive } from "@/lib/tubeforge/music";
import { docMusicPick } from "@/lib/tubeforge/studio-doc";
import { parseTimeline } from "@/lib/tubeforge/timeline";
import { getApprovedAudioMap } from "@/lib/tubeforge/director-plan";
import { applyQcPolicy, parseQcReport, qcEnforcementMode, qcOverrideValid } from "@/lib/tubeforge/qc-policy";
import { renderStaleness } from "@/lib/tubeforge/render-assembly";
import * as storage from "@/lib/tubeforge/storage";

 type Ctx = { params: Promise<{ id: string }> };

/** GET — download the full upload-ready package as a ZIP.
 *
 * S40 — the ship gate: when a final.mp4 ships in the bundle, the standing QC
 * report goes through the enforcement matrix (qc-policy.ts). Blocking
 * findings (or no report at all) hold the export with 409 — the two ways
 * through are fixing the finding (re-run QC / re-render) or POSTing an
 * audited override below. TUBEFORGE_QC_ENFORCEMENT=report turns the gate
 * advisory for operators who want the pre-S40 behavior. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({
    where: { id },
    include: {
      channel: { select: { name: true, niche: true } },
      character: { select: { name: true, role: true, identityAnchor: true } },
    },
  });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  // S40 — the ship gate. Only a bundle that ships final.mp4 is gated:
  // script-only exports (no render) have nothing to measure.
  const qcReport = video.hasVideo ? parseQcReport(video.qcReport) : null;
  const gate = applyQcPolicy(qcReport, { mode: qcEnforcementMode() });
  const overrideOk = qcOverrideValid(video, qcReport);
  if (video.hasVideo && gate.blocked && !overrideOk) {
    return NextResponse.json(
      {
        error: gate.missingReport
          ? "Export on hold — no QC report stands behind this render. Re-run QC (one click, no re-render), then export."
          : `Export on hold — ${gate.blockers.length} blocking QC finding${gate.blockers.length === 1 ? "" : "s"}. Fix and re-run QC, or accept the findings to ship anyway.`,
        blocked: true,
        gate,
        override: { method: "POST", url: `/api/videos/${id}/export`, body: { note: "why this ships anyway (3-500 chars)" } },
      },
      { status: 409 }
    );
  }

  // S117 — the staleness gate, same shape: a final that cannot prove its
  // assembly (or provably assembled from superseded content) never ships.
  // No override here either — staleness is a fact about WHICH bytes ship,
  // not a judgment a human can accept.
  if (video.hasVideo) {
    const staleness = await renderStaleness(video);
    if (staleness.status !== "fresh") {
      return NextResponse.json(
        {
          error:
            staleness.status === "stale"
              ? `Export on hold — the final is stale: ${staleness.reasons.slice(0, 3).join("; ")}. Re-render to assemble the current approved content.`
              : staleness.reason,
          blocked: true,
          stale: true,
          staleness,
        },
        { status: 409 }
      );
    }
  }

  // Stage 3 (T-3.6, closes D-24): media assets STREAM from disk through the
  // data-descriptor ZIP builder — the whole package flows through a few MB of
  // memory instead of buffering every asset plus the archive. Text metadata
  // stays in memory (KBs) and uses the same stream with a one-shot source.
  //
  // Stage 3 (T-3.7): files resolve through the STORAGE DRIVER — the export
  // works unchanged under local disk and s3 (where each asset is fetched
  // whole from the bucket; still per-file, never the whole folder at once).
  const entries: StreamZipEntry[] = [];
  const addText = (name: string, data: Buffer | string | null) => {
    if (data !== null && data !== undefined) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
      entries.push({
        name: safeZipName(name),
        stream: () => Readable.from([buf]),
        method: 8,
      });
    }
  };
  const addFile = async (name: string, rel: string) => {
    const key = `${video.id}/${rel}`;
    if (!(await storage.exists(key))) return;
    if (storage.storageDriverKind() === "local") {
      const p = await storage.materialize(key);
      entries.push({
        name: safeZipName(name),
        stream: () => fs.createReadStream(p),
        method: zipMethodFor(name),
      });
    } else {
      const buf = await storage.get(key);
      entries.push({
        name: safeZipName(name),
        stream: () => Readable.from([buf]),
        method: zipMethodFor(name),
      });
    }
  };

  const base = safeZipName(video.title ?? video.topic) || "video-package";
  const scenes = video.format === "story" ? parseScenes(video.scenes) : [];

  // Core metadata for manual YouTube upload
  const tags = video.tags ? video.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  addText(
    `${base}/upload-metadata.txt`,
    [
      `TITLE: ${video.title ?? ""}`,
      ``,
      `TOPIC: ${video.topic}`,
      `NICHE: ${video.niche}`,
      `CHANNEL: ${video.channel?.name ?? "—"}${video.channel ? ` (${video.channel.niche})` : ""}`,
      `TONE: ${TONES.find((t) => t.id === video.tone)?.label ?? video.tone}`,
      `LENGTH: ${LENGTHS.find((l) => l.id === video.length)?.label ?? video.length}`,
      `FORMAT: ${video.format === "story" ? `Scene-based story (${scenes.length} scenes)` : "Narration script"}`,
      `VOICE: ${VOICES.find((v) => v.id === video.voice)?.label ?? video.voice}`,
      `CAST: ${video.character ? `${video.character.name} — ${video.character.role ?? "recurring host"}` : "—"}`,
      `WORD COUNT: ${video.wordCount ?? "—"}`,
      `AUDIO DURATION: ${video.audioDuration ? `${Math.round(video.audioDuration)} seconds` : "—"}`,
      video.hasVideo && video.videoDuration
        ? `RENDERED VIDEO: final.mp4 (${Math.round(video.videoDuration)} seconds, ${video.renderMode})`
        : ``,
      // S40 — the override travels WITH the artifact: anyone opening the
      // bundle months later sees that it shipped on a human's explicit
      // acceptance, which findings, and why.
      video.hasVideo && overrideOk && video.qcOverrideNote
        ? `QC OVERRIDE: shipped on accepted findings — ${video.qcOverrideNote} (accepted ${
            video.qcOverrideAt ? video.qcOverrideAt.toISOString() : "unknown time"
          } for the report checked at ${qcReport?.checkedAt ?? "unknown"})`
        : ``,
      video.youtubeUrl ? `UPLOADED TO YOUTUBE: ${video.youtubeUrl}` : ``,
      ``,
      `DESCRIPTION:`,
      video.description ?? "—",
      ``,
      `TAGS (${tags.length}):`,
      tags.join(", ") || "—",
      ``,
      `HOW TO UPLOAD:`,
      video.hasVideo
        ? [
            `1. Upload final.mp4 as the video file.`,
            `2. Paste the description from this file into the YouTube upload form.`,
            `3. Add the tags in YouTube Studio's tag field.`,
            `4. Upload thumbnail.png as the custom thumbnail.`,
            `5. subtitles.srt can be uploaded as the caption track.`,
            `6. After publishing, post engagement-kit.txt's pinned comment and pin it.`,
          ].join("\n")
        : [
            `1. Combine the voiceover with visuals (use the thumbnail as cover art).`,
            `2. Paste the description from this file into the YouTube upload form.`,
            `3. Add the tags in YouTube Studio's tag field.`,
            `4. Upload thumbnail.png as the custom thumbnail.`,
          ].join("\n"),
    ].join("\n")
  );

  addText(`${base}/script.txt`, video.script);
  addText(`${base}/description.txt`, video.description);
  addText(`${base}/tags.csv`, tags.length ? "tag\n" + tags.join("\n") : null);

  // Engagement kit (Phase 4) — paste into the comment section right after upload.
  let kit: { pinnedComment?: string; replies?: { trigger: string; text: string }[]; heartTargets?: string[]; strategy?: string } | null = null;
  try {
    kit = video.commentsKit ? JSON.parse(video.commentsKit) : null;
  } catch {
    kit = null;
  }
  if (kit?.pinnedComment) {
    addText(
      `${base}/engagement-kit.txt`,
      [
        `ENGAGEMENT KIT — post these in the first golden hour after upload.`,
        ``,
        `=== PINNED COMMENT (post this first, then pin it) ===`,
        kit.pinnedComment,
        ``,
        `=== REPLY TEMPLATES ===`,
        ...(kit.replies ?? []).map(
          (r, i) => `${i + 1}) WHEN: ${r.trigger}\n   REPLY: ${r.text}`
        ),
        ``,
        `=== HEART THESE EARLY COMMENTS ===`,
        ...(kit.heartTargets ?? []).map((t) => `- ${t}`),
        ``,
        `=== PLAYBOOK ===`,
        kit.strategy ?? "",
      ].join("\n")
    );
  }

  addText(
    `${base}/metadata.json`,
    JSON.stringify(
      {
        topic: video.topic,
        niche: video.niche,
        tone: video.tone,
        length: video.length,
        voice: video.voice,
        thumbnailStyle: video.thumbStyle,
        format: video.format,
        renderMode: video.renderMode,
        scenes: scenes.length
          ? scenes.map((s) => ({
              index: s.index,
              title: s.title,
              narration: s.narration,
              camera: s.camera,
              mood: s.mood,
              caption: s.caption,
            }))
          : undefined,
        cast: video.character
          ? {
              name: video.character.name,
              role: video.character.role,
              identityAnchor: video.character.identityAnchor,
            }
          : null,
        wordCount: video.wordCount,
        audioDurationSec: video.audioDuration,
        videoDurationSec: video.hasVideo ? video.videoDuration : undefined,
        description: video.description,
        tags,
        channel: video.channel
          ? { name: video.channel.name, niche: video.channel.niche }
          : null,
        generatedBy: "TubeForge Auto-Pilot",
        exportedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  // CREDITS.txt — every music + footage license in one paste-ready file, so a
  // monetized upload can always prove its soundtrack and b-roll are safe.
  // ("a technically good video does not create copyright problems later")
  try {
    // S7 (audit) — credits mirror the render's music truth EXACTLY (doc pick
    // > plan > row, via musicBedActive + the same resolver inputs), so the
    // license listed is the track the render actually lays: a doc pick or a
    // plan mood can no longer make the credits name a different bed — or
    // skip one — than the export ships.
    const docPick = docMusicPick(parseTimeline(video.timeline)?.renderPrefs ?? null);
    const musicEnabled = musicBedActive(docPick, await isMusicEnabledForVideo(video));
    const planAudio = await getApprovedAudioMap(video.id);
    const resolvedMusic = musicEnabled
      ? await resolveMusicForVideo(video, planAudio.musicMood, docPick)
      : null;
    const creditLines: string[] = [
      `CREDITS & LICENSES — "${video.title ?? video.topic}"`,
      `Exported ${new Date().toISOString()}`,
      ``,
      `== BACKGROUND MUSIC ==`,
    ];
    if (!musicEnabled) {
      creditLines.push("Music disabled for this video — no soundtrack license needed.");
    } else if (resolvedMusic) {
      const t = resolvedMusic.track;
      creditLines.push(
        `Track: "${t.name}"${t.genre ? ` (${t.genre})` : ""}`,
        `License: ${t.licenseType}`,
        t.sourceUrl ? `Source: ${t.sourceUrl}` : `Source: TubeForge in-app library`,
        `Commercial use: ${t.commercialUse ? "allowed" : "NOT allowed — check before monetizing"}`,
        `Attribution required: ${t.attributionRequired ? "YES" : "no"}`,
        t.attributionRequired && t.attributionText ? `Credit line: ${t.attributionText}` : ``,
        t.licenseEvidence ? `License evidence: ${t.licenseEvidence}` : ``,
        t.contentIdNotes ? `Content ID notes: ${t.contentIdNotes}` : ``
      );
    } else {
      creditLines.push(
        "Synthesized in-app ambient bed (TubeForge original — generated from pure sine synthesis,",
        "no third-party samples; no attribution needed, cannot match any Content ID fingerprint)."
      );
    }
    const stockScenes = scenes.filter((s) => s.stock);
    creditLines.push(``, `== STOCK FOOTAGE ==`);
    if (stockScenes.length === 0) {
      creditLines.push("None — all visuals are generated storyboard art.");
    } else {
      // The filter above proved s.stock; the guard keeps it total (S58/T-58.1).
      for (const s of stockScenes) {
        const stock = s.stock;
        if (!stock) continue;
        creditLines.push(`Scene ${s.index}: ${stock.credit} — ${stock.pageUrl}`);
      }
    }
    creditLines.push(
      ``,
      `== SOUND EFFECTS ==`,
      "All accents are synthesized in-app (royalty-free by construction — no sampled SFX).",
      ``,
      `Paste the attribution lines above into your YouTube description when the license requires it.`
    );
    addText(`${base}/CREDITS.txt`, creditLines.join("\n").replace(/\n==/g, "\n\n=="));
  } catch {
    // Credits must never block an export — a resolveMusicForVideo failure
    // (e.g. deleted pinned track) just omits the file.
  }

  // Media assets — resolved through the storage driver (T-3.7)
  await addFile(`${base}/voiceover.wav`, "voiceover.wav");
  await addFile(`${base}/thumbnail.png`, "thumbnail.png");

  for (const v of await listVariants(video.id)) {
    await addFile(`${base}/thumbnail-variants/${v.style}.png`, v.fileName);
  }

  // Story engine artifacts — storyboard art, captions, rendered video
  for (const scene of scenes) {
    await addFile(`${base}/storyboard/scene-${String(scene.index).padStart(2, "0")}.png`, sceneImageFile(scene.index));
  }
  await addFile(`${base}/subtitles.srt`, "subtitles.srt");
  await addFile(`${base}/final.mp4`, "final.mp4");

  if (entries.length === 0)
    return NextResponse.json(
      { error: "Nothing to export yet — run the Auto-Pilot pipeline first" },
      { status: 400 }
    );

  // Chunked transfer (no Content-Length — the ZIP is composed on the fly).
  // Browsers handle attachment downloads over chunked responses fine.
  return new NextResponse(streamZip(entries), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${base.replace(/[^\w.-]/g, "_").slice(0, 80)}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}

/** POST — S40: the audited human override. Accept the STANDING report's
 * blocking findings and unlock the ship. Body: { note } (3–500 chars — the
 * audit trail must say why). The acceptance is anchored to the report's
 * checkedAt: a re-render or QC re-run lands a new report and the override
 * goes stale automatically, so this never becomes a permanent bypass.
 *
 * Refused (409) when there is nothing standing to accept — a human accepts
 * FINDINGS, not the absence of a report; that case is one "Re-run QC" click. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.hasVideo)
    return NextResponse.json(
      { error: "Cannot accept QC findings — render the video first" },
      { status: 400 }
    );

  let body: { note?: unknown };
  try {
    body = (await req.json()) as { note?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length < 3 || note.length > 500)
    return NextResponse.json(
      { error: "An override note of 3–500 characters is required — the audit trail must say why this ships" },
      { status: 400 }
    );

  const report = parseQcReport(video.qcReport);
  // A null report IS the missingReport case (applyQcPolicy fails closed on
  // it) — checked here explicitly so the anchor below is non-null.
  if (!report)
    return NextResponse.json(
      { error: "No QC report stands behind this render — re-run QC first, then accept its findings if needed" },
      { status: 409 }
    );
  const gate = applyQcPolicy(report, { mode: qcEnforcementMode() });
  if (!gate.blocked)
    return NextResponse.json(
      { error: "Nothing to override — the standing QC report does not block this video" },
      { status: 409 }
    );

  await db.video.update({
    where: { id },
    data: {
      qcOverrideAt: new Date(),
      qcOverrideNote: note,
      qcOverrideForCheckedAt: report.checkedAt,
    },
  });
  await db.activity.create({
    data: {
      organizationId: video.organizationId,
      userId: auth.ctx.userId,
      videoId: id,
      stage: "qc",
      level: "warn",
      message:
        `QC override accepted — shipping despite ${gate.blockers.length} blocking finding(s) ` +
        `(${gate.blockers.map((b) => b.id).join(", ")}). Note: ${note}`,
    },
  });

  return NextResponse.json({ accepted: true, unlocked: true, forCheckedAt: report.checkedAt });
}
