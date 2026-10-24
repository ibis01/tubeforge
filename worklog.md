# Worklog

---
Task ID: 1
Agent: main (Z.ai)
Task: Build "TubeForge" — a fully-automated faceless YouTube content platform (Next.js web app) with AI script generation, TTS voiceover, AI thumbnails, dark premium YouTube-inspired design.

Work Log:
- Clarified requirements via AskUserQuestion: web platform, AI content gen as core feature, fully automated pipeline, faceless/generic niche, dark premium style, MVP 5-7 screens, built-in Z.ai SDK.
- Loaded skills: fullstack-dev, LLM, TTS, image-generation, agent-browser.
- Verified SDK in sandbox: GLM chat, TTS (24kHz 16-bit mono WAV), CogView (1344x768 PNG) all working.
- Defined Prisma schema (Channel, Video, Activity, Setting) and pushed to SQLite.
- Built server libs in src/lib/tubeforge/: types.ts (shared constants/DTOs), wav.ts (WAV parse + merge for multi-chunk TTS), ai.ts (script generation via GLM with loose-JSON parsing, TTS chunking ≤950 chars with sentence splitting, WAV merge, thumbnail gen), status.ts (derived pipeline status).
- Built API routes: /api/videos (list + create-with-script), /api/videos/[id] (GET/PATCH/DELETE), /api/videos/[id]/voiceover (POST gen + GET stream WAV), /api/videos/[id]/thumbnail (POST gen + GET stream PNG), /api/stats, /api/channels (+[id]), /api/settings (key-value with defaults).
- Created dark premium forced theme in globals.css: near-black background, YouTube red primary (oklch 0.628/0.258/29.23), glassmorphism utilities (.glass, .glow-red, .text-gradient, .bg-grid), custom scrollbars, pulse-dot keyframes.
- Built app shell (single / route): AppSidebar (desktop) + Sheet nav (mobile), sticky header, sticky footer, Zustand store for view switching.
- Built 5 views: Dashboard (stat cards, 7-day production chart, pipeline breakdown, activity feed), Create (blueprint form + 3-stage Auto-Pilot stepper with live stage states, results panels, per-stage retry), Library (status filter tabs, video cards with thumbnails, detail dialog with audio player/script/tags/publish/delete), Channels (CRUD lite with active toggle), Settings (auto-pilot toggles + content defaults persisted to DB).
- Seeded demo data: 1 channel (MindFuel Daily), 3 videos produced end-to-end via real AI pipeline (published + 2 ready, 5.9 min total narration).
- Fixed lint errors (react-hooks/set-state-in-effect in dashboard/library views).
- Browser self-verification with agent-browser + VLM subagent verification loop. Found and fixed 3 bugs:
  1. Chart bars invisible (percentage height collapse) → restructured with h-full columns + flex-1 definite-height bar wrappers.
  2. ScrollArea content spill (missing overflow-hidden in shadcn scroll-area Root) → added overflow-hidden.
  3. Radix ScrollArea not scrollable inside dialogs → replaced with native overflow-y-auto divs (.scroll-area-bar styled scrollbars).
- Disabled Next.js dev indicator (devIndicators: false) to clean UI overlap.
- Verified golden path through UI: filled topic in Create → "Run Full Auto-Pilot" → GLM script (286 words) → TTS voiceover (2m43s WAV) → CogView thumbnail → stepper all-green "Package complete — ready to upload". Verified dialog, filters, channels, settings persistence, mobile 375px layout with hamburger drawer. No JS errors, no page errors, lint clean.

Stage Summary:
- Deliverable: TubeForge — fully-automated faceless YouTube content engine at / (Next.js 16, TypeScript, Tailwind 4, shadcn/ui, Prisma/SQLite, z-ai-web-dev-sdk).
- Core capability: topic → complete video package (script + title + description + tags + voiceover WAV + 16:9 thumbnail) via one click, with per-stage control and resumable pipeline.
- Key artifacts: src/lib/tubeforge/* (AI pipeline), src/app/api/* (8 route files), src/components/tubeforge/* (5 views + dialog + shared), uploads/{videoId}/ (generated media).
- Status: all browser-verified (dashboard, library, detail dialog, auto-pilot golden path, channels, settings, mobile) — task complete.

---
Task ID: 2
Agent: main (Z.ai)
Task: TubeForge Phase 2 "Growth Suite" — Topic Radar (AI keyword research), Publishing Calendar, Thumbnail A/B variants, and upload-ready ZIP export, following the 4 suggested next steps from Phase 1.

Work Log:
- Extended Prisma schema with ResearchSession (JSON ideas) and ScheduleSlot (videoId/channelId/slotDate/timeOfDay/note/done) + inverse Video.slots relation; db push + client regenerate. Dev server needed restart + .next wipe to pick up new client (stale-client pitfall: db.scheduleSlot undefined).
- Built src/lib/tubeforge/zip.ts — dependency-free ZIP writer (zlib deflateRaw, CRC32 table, local headers + central dir + EOCD). Fixed JS gotcha: `0o100644 << 16` is a NEGATIVE signed int32 → writeUInt32LE ERR_OUT_OF_RANGE; fixed with `>>> 0`.
- Extended ai.ts: generateTopicResearch (GLM strategist returns 8 ideas w/ title, angle, keywords, searchVolume, competition, viralScore, suggestedLength, why + nicheSummary), generateThumbnail(variant) saves variant-<style>.png, pickVariantStyles (chosen style + 2 others), listVariants, promoteVariant (copy → thumbnail.png). readMedia type widened.
- New shared libs: research.ts (serializeSession), schedule.ts (serializeSlot + parseDay) — helpers moved OUT of route.ts files (Next.js forbids extra exports from route files).
- New API routes: /api/research (GET list, POST live scan), /api/research/[id] (DELETE); /api/schedule (GET range + ?limit upcoming + schedulable videos, POST create), /api/schedule/[id] (PATCH move/done/markVideoPublished, DELETE); /api/videos/[id]/variants (GET list, POST generate 3-style set ~2.5min, PATCH promote), /api/videos/[id]/variants/[style] (PNG stream), /api/videos/[id]/export (ZIP: upload-metadata.txt + script + description + tags.csv + metadata.json + voiceover.wav + thumbnail.png + variant files).
- Frontend: added "research" + "calendar" to store ViewId (+ prefillSlotDate, scheduleVideoId), 7-item nav (Topic Radar, Calendar), VIEW_META + view rendering in page.tsx.
- New ResearchView: scan panel (niche select + focus input + example chips), live 10–20s scan with skeleton loading, niche-analysis summary card, idea cards (viral score badge w/ color tiers, competition/volume/length chips, keyword pills, italic why-line, "Create with Auto-Pilot" CTA → prefillTopic → Create view), recent-scans sidebar w/ active highlight + delete, empty state.
- New CalendarView: month grid (Mon-start, date-fns) w/ prev/next/today, slot chips color-coded (done emerald, published red, video sky, placeholder zinc), hover "+" per day, today red circle, out-month dimming; mobile agenda list (lg:hidden grid); "Ready to schedule" sidebar w/ thumbnails + quick-schedule; new-slot dialog (video select or custom title, day, time, note); slot detail dialog (Open in library, Mark uploaded → done + video published, Reopen, Remove); consumes scheduleVideoId prefill from detail dialog.
- Detail dialog upgrades: Thumbnail A/B lab (3-up gallery, Primary badge, set-primary on click, Re-roll set), Schedule button → calendar with video preselected, Export download link.
- Seeded 3 demo slots (+1 created during UI test), generated 3 real CogView variants for demo video, promoted bold→cinematic.
- Environment pitfall: background processes die between tool calls in this sandbox → dev server must be double-fork daemonized (python os.fork×2 + setsid + start_new_session) to survive.
- Verification: lint clean; API smoke suite (schedule CRUD, live research scan = 8 real Finance/money-psychology ideas, export ZIP validated by python zipfile incl. 4.2MB wav, variants GET/POST/PATCH with on-disk md5 verification of promoted thumbnail); browser E2E via agent-browser + VLM subagents: dashboard 7-item sidebar PASS, Topic Radar PASS, idea→Create prefill PASS, calendar grid + slots PASS, slot mark-uploaded→done+published PASS, new slot via day "+" PASS, detail-dialog Schedule handoff PASS, A/B promote in dialog PASS (thumbnail.png == variant-cinematic.png), mobile 375px research PASS; found+fixed 1 real bug (Card base flex-col vs agenda row merge conflict → clipped titles + 19px overflow; fixed with explicit flex-row, scrollWidth 375==375 after).

Stage Summary:
- TubeForge now ships 7 views (added Topic Radar + Publishing Calendar) with full research→create→schedule→export loop: niche scan → idea → Auto-Pilot package → A/B thumbnail test → calendar slot → ZIP export for manual YouTube upload.
- Key artifacts: src/lib/tubeforge/{zip,research,schedule}.ts, src/app/api/{research,schedule,videos/[id]/{variants,export}}/routes, src/components/tubeforge/views/{research,calendar}-view.tsx.
- All flows verified desktop + mobile, lint clean, no page errors. Real YouTube Data API v3 OAuth upload remains the only future step (needs user credentials; ZIP export bridges the gap today).

---
Task ID: 3
Agent: main (Z.ai)
Task: Fix "voiceover and thumbnail not working" — diagnose + repair + harden pipeline.

Work Log:
- Diagnosed via dev.log + DB: video cmvmjupoy0001ritgx1m4aytm hit transient upstream TTS 500 ("network error, please retry later"); voiceover.wav was actually saved on the first pass, but a subsequent call failed and marked the video "failed", blocking the thumbnail stage. No retry logic existed — one blip killed the stage.
- Verified upstream health directly with SDK sandbox script (scripts/test-ai-services.mjs): TTS OK (1.6s), image OK (27s) — outage was transient and had recovered.
- Hardened src/lib/tubeforge/ai.ts with withRetry() helper (3 attempts, exponential backoff 2s/4s, console.warn logging) wrapping all 4 AI call sites: script LLM, TTS chunks, CogView thumbnail, research LLM.
- Repaired the failed video via API: regenerated thumbnail (146KB PNG), status → ready, error cleared; re-ran voiceover through the new retry path (200 in 73s, 151.1s audio) to prove the hardening works.
- Verified both media streaming endpoints return 200 with correct content-type/size.

Stage Summary:
- Root cause: transient upstream AI service 500, amplified by zero-retry code. Fixed with withRetry() across the pipeline; affected video fully repaired and confirmed "ready" with playable audio + visible thumbnail. All 4 library videos now ready.
