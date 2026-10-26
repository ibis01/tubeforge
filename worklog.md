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

---
Task ID: 4
Agent: main (Z.ai)
Task: Fix HTTP 502 on Generate Voiceover/Thumbnail — gateway kills long-running requests.

Work Log:
- Root cause chain: user clicks Generate → TTS/image API returns 429 rate-limit → retry backoff stretches request past gateway timeout → preview proxy returns 502 to browser while server keeps processing. dev.log confirmed server-side 200-in-72s/53s responses that the gateway swallowed as 502s.
- Architecture fix (async job pattern):
  - NEW src/lib/tubeforge/jobs.ts — in-memory job registry (running map + lastError map, dedupe via startJob(), jobSnapshot() for GETs).
  - voiceover/thumbnail/variants POST routes now clear stale errors, start a background job via startJob(), return 202 in <100ms; job updates DB (hasVoiceover/hasThumbnail/status/error + activity) in-process, immune to client/proxy disconnects.
  - variants GET now returns {variants, generating, error}; videos/[id] GET returns {video, generating:{voiceover,thumbnail,variants}} so spinners survive reloads.
  - NEW src/lib/tubeforge/poll.ts — client pollers (pollVoiceover/pollThumbnail 2.5s interval + 6min cap; pollVariants on GET flags).
  - Clients: create-view startVoiceover/startThumbnail and detail-dialog runStage/generateVariants now POST (fast) then poll; 429-aware backoff upgraded in withRetry (x4 multiplier on 429; TTS 5 attempts/6s base, image 4 attempts/5s base).
- Verification: E2E async test (202 in 19-90ms → poll → ready), both user-stuck videos repaired concurrently via the async API (32s/65s incl. one silent 429 retry), eslint clean, browser check: library renders 6 videos, repaired video detail dialog shows thumbnail + Ready + 2m57s audio player, zero console errors.

Stage Summary:
- Stage generation is now gateway-proof: POSTs return 202 instantly, work continues server-side, clients poll to completion. Upstream 429/500 bursts self-heal with escalated backoff. All 6 library videos ready; A/B variants route also converted (same 502 risk). Research (10-20s) intentionally left synchronous — under gateway timeout.

---
Task ID: 5
Agent: main (Z.ai)
Task: Investigate 429 "Voiceover failed" screenshot — turned out to be the pre-fix failure; added TTS pacing + full E2E proof.

Work Log:
- Forensics: screenshot toast matches bf1qno's 15:39:10 UTC failure byte-for-byte (filename 16:39 Lagos = 15:39 UTC); dev.log shows NO voiceover POST after the async fix; DB has all 7 videos ready/error=null → screenshot was the already-repaired failure, not a regression.
- Re-verified upstream health: TTS OK (1.6s), image OK (27s).
- Hardening: added 2s inter-chunk pacing in generateVoiceover to stay under upstream burst/rate limits (in addition to existing 429-aware x4 backoff).
- Proof: full fresh Auto-Pilot E2E via API — script 4s, voiceover 202-in-69ms→done 21s, thumbnail 202-in-111ms→done 31s, final status=ready, zero errors (scripts/test-full-autopilot.mjs). eslint clean.

Stage Summary:
- No regression existed; TTS quota had recovered. Pipeline now paces TTS requests (2s gaps) on top of async jobs + escalated backoff. Complete Auto-Pilot run verified green end-to-end (56s total).

---
Task ID: 6
Agent: main (Z.ai)
Task: Package TubeForge for local machine deployment + setup guide.

Work Log:
- Inspected runtime deps: Node >=20 (SDK requirement), npm/bun install, Prisma/SQLite (file-based), .env DATABASE_URL (was absolute sandbox path -> .env.example uses relative file:../db/custom.db).
- SDK auth research: z-ai-web-dev-sdk reads .z-ai-config JSON (baseUrl, apiKey, chatId, token, userId) from project dir -> home dir -> /etc; sandbox copy at /etc/.z-ai-config. Credentials NOT included in package (sensitive); .z-ai-config.example template + instructions provided instead.
- Wrote LOCAL-SETUP.md: prerequisites, install, env, db push, credential setup, run (dev/prod), first-run checklist, troubleshooting table (incl. 429 + stuck-job guidance).
- Built download/tubeforge-local.zip (249KB, 144 files): src, prisma, public, scripts (tests, no screenshots), configs, bun.lock, .env.example, .z-ai-config.example, LOCAL-SETUP.md, .gitkeep placeholders; excluded node_modules/.next/db/uploads/skills/examples/worklog.
- Cleaned scripts/test-clip.mp4 (9.8MB test artifact).

Stage Summary:
- Deliverable: download/tubeforge-local.zip + LOCAL-SETUP.md. Local run needs: npm install -> cp .env.example .env -> db:generate + db:push -> cp .z-ai-config.example .z-ai-config (fill credentials) -> npm run dev. App works without credentials for UI; AI stages need valid Z.ai config values.

---
Task ID: 7
Agent: main (Z.ai)
Task: TubeForge Phase 1 — Characters ("Cast"): character model, GLM character bible, CogView reference portraits, identity-consistent pose sheets via image editing, cast integration across the video pipeline.

Work Log:
- Verified SDK image-edit capability first (scripts/test-character-edit.mjs): `zai.images.generations.edit` requires `images: [{ url: dataUrl }]` (NOT `image: string` — SDK types are wrong); portrait (48s) + identity-preserving pose edit (14s) both confirmed visually.
- Prisma: new Character model (name/role/personality/appearance/identityAnchor/voice/artStyle/hasPortrait) + Video.characterId (SetNull). db push + client regen + dev server restart with .next wipe (stale-client pitfall avoided).
- New src/lib/tubeforge/characters.ts: serializeCharacter (DTO with poseUrls/generating flags), file helpers (uploads/characters/<id>/portrait.png + pose-<pose>.png), generateCharacterBible (GLM persona designer -> role/personality/appearance/identityAnchor/voice/artStyle), generateCharacterPortrait (CogView 1024x1024), generateCharacterPoses (3 identity-locked poses via images.edit seeded from portrait, 2s pacing), characterSceneFragment, buildAnchorFallback.
- ai.ts: exported getZAI/withRetry/parseJsonLoose; generateThumbnail now accepts character — PREFERS images.edit with the reference portrait as visual seed (true likeness in thumbnails) and falls back to text identity-anchor prompting when no portrait exists.
- jobs.ts generalized to arbitrary entity ids (+ portrait/poses kinds, characterJobSnapshot).
- API: /api/characters (GET/POST), /api/characters/[id] (GET/PATCH/DELETE incl. file cleanup), /api/characters/[id]/portrait (POST 202 job + GET PNG stream), /api/characters/[id]/poses (POST 202 job + GET list), /api/characters/[id]/poses/[pose] (GET PNG), /api/characters/bible (sync GLM, applies to existing character when characterId given). Videos API: characterId in POST (validated)/PATCH, character fields in all serializers; thumbnail route passes character; export ZIP now includes CAST line + cast block in metadata.json.
- poll.ts: pollCharacter/pollPortrait/pollPoses — predicates watch job flags (NOT artifacts) so re-rolls poll correctly.
- UI: new "cast" ViewId (nav position: after Library, Users icon), CastView with character cards (portrait/placeholder, art style chip, video count, pose badge) + create dialog (name+concept -> "Auto-fill with AI bible" fills role/personality/appearance/voice/artStyle) + Character Studio dialog (portrait panel with generate/re-roll + consistency sheet strip 3 poses + editable profile incl. identity anchor + delete). Create view: "Cast (optional)" selector, adopts character's voice on selection, explains identity stamping. Detail dialog: cast badge.
- Seeded 2 demo characters: Professor Vex (History/Mysteries, cinematic, voice jam) + Nova (Space/Science, stylized, voice kazi) — scripts/seed-characters.mjs.
- E2E verified (scripts/test-characters-e2e.mjs, 162s total): GLM bible 3s (noir Archivist) + apply-to-character path; portrait 202->73s; consistency sheet 202->49s (3/3 poses); video cast to Professor Vex -> scripted -> cast thumbnail 202->28s. Visual check: pose images and thumbnail are unmistakably the same person (glasses/beard/cardigan locked).
- Browser E2E via agent-browser: Cast grid renders both characters, Character Studio shows portrait + 3/3 locked poses + editable fields, Create cast selector with voice adoption + helper text, detail dialog cast badge, export ZIP carries cast metadata, mobile 375px Cast layout OK. Zero page errors, lint clean.

Stage Summary:
- TubeForge now has a recurring-cast system: GLM designs the persona (character bible), CogView paints a canonical reference portrait, and image-editing derives an identity-locked consistency sheet (explaining/thinking/welcoming) that becomes the storyboard brick set for Phase 2 scene rendering. Thumbnails featuring the cast use the portrait as a visual seed for true likeness.
- Key artifacts: src/lib/tubeforge/characters.ts, src/app/api/characters/**, src/components/tubeforge/views/cast-view.tsx, Prisma Character model, Video.characterId.
- Demo state: Professor Vex fully generated (portrait + 3 poses + hosted demo video with cast-likeness thumbnail cmvmsjntl0004nfu7c6ollyhx); Nova awaiting portrait generation (one click in Cast).
- Next: Phase 2 Story Engine — scene-based scripts {scenes:[narration,visual,camera,mood]}, storyboard generation reusing pose sheet + identity anchor, Ken Burns vs full i2v render modes, ffmpeg compositor.

---
Task ID: 8
Agent: main (Z.ai)
Task: TubeForge Phase 2 — Story Engine: scene-based scripts, identity-locked storyboards, per-scene TTS, dual-mode rendering (Ken Burns / CogVideoX i2v) with ffmpeg compositor (captions + music), full UI integration.

Work Log:
- Verified Phase 1 (Cast system, Task 7) fully present in code + worklog; continued with confirmed Phase 2 roadmap.
- Prisma: Video += {format, renderMode, scenes(JSON), hasStoryboard, hasVideo, videoDuration}; db push + client regen + daemonized dev-server restart with .next wipe (stale-client pitfall avoided).
- types.ts: FORMATS, RENDER_MODES, CAMERAS, SCENE_COUNTS (short 4 / medium 6 / long 8), Scene + SceneDTO; VideoDTO extended (scenes only populated in detail/create responses to keep list payloads light).
- NEW src/lib/tubeforge/story.ts: generateSceneScriptPackage (GLM returns {title, description, tags, scenes[{title,narration,visual,camera,mood,caption,hostInScene}]}, narration joined into classic script field), generateSceneImage (host scenes + cast portrait -> images.edit identity lock; else CogView text gen), generateStoryboard (2s pacing), generateSceneVoiceovers (per-scene TTS -> scene-XX.wav + merged voiceover.wav for compat), buildSrtFromSegments, parseScenes/serializeScenes/storyboardComplete, scene file helpers.
- NEW src/lib/tubeforge/render.ts: ffmpeg compositor via execFile (no shell). probeDuration (ffprobe); Ken Burns zoompan chains per camera (pre-upscaled 3840x2160, deterministic on/(N-1) expressions, d=1 trick); animated mode: ensureSceneClip (zai.video.generations.create cogvideox-3 1920x1080, 10s poll, download, cache scene-XX.mp4) + stream_loop fill; segments = max(wav + 0.35 lead + 0.85 tail, 2s); concat demuxer; finalize pass burns SRT (force_style Noto Sans SC) + aevalsrc ambient drone (A1+A2detune+E3, fade in/out, amix weights 1/0.32, alimiter) + faststart; pure remux when no effects. renderVideo orchestrator with onProgress + preview (sceneLimit -> preview.mp4, never sets hasVideo).
- jobs.ts: kinds += storyboard/render/scene (single-scene re-roll keyed `${videoId}#scene${n}`), setJobProgress/jobProgress map; snapshot extended to 5 flags.
- poll.ts: pollStoryboard (hasStoryboard), pollRender (GET /render with onTick progress callback, 50-min cap for animated), pollScene (per-scene flag).
- NEW serialize.ts: shared serializeVideo (fs-checks final.mp4/preview.mp4 for videoUrl/previewUrl) — replaced 4 duplicated per-route serializers.
- API: videos POST branches on format (story -> scene package, scenes JSON persisted); videos/[id] GET includes scenes + 5 generating flags, PATCH accepts renderMode; NEW storyboard routes (GET list+flags, POST full/single-scene re-roll with render invalidation: final/preview/srt/scene clips deleted, hasVideo reset); NEW render route (GET status+progress, POST {mode, subtitles, music, sceneLimit} -> 202 job, DB hasVideo/videoDuration on full renders only); NEW mp4 route with HTTP Range 206 support (?variant=preview, ?download=1); voiceover POST branches story -> per-scene TTS + invalidates renders; export ZIP += storyboard/*.png, subtitles.srt, final.mp4, updated metadata + upload instructions.
- UI: CreateView — production-format selector (narration vs scene story), render-mode cards (Ken Burns / Full AI animation + scene-count badge), 5-stage story stepper (script→storyboard→voiceover→thumbnail→render; animated mode stops before render with explanatory toast), storyboard strip + inline <video> player in results; VideoDetailDialog — Tabs refactor for story videos (Package | Storyboard | Video; classic videos keep single flow), Storyboard tab (scene cards with images, narration, camera/caption/mood chips, HOST badge, per-scene re-roll with spinner), Video tab (mode picker, caption/music switches, render + preview-first-scene buttons, progress label, final MP4 player + download); Library cards show emerald MP4 badge.
- E2E (scripts/test-story-e2e.mjs, 415s): Professor Vex-hosted 4-scene mystery; scene script 11s (host flagged in scenes 1+3); storyboard 4/4 identity-locked images 190s; per-scene voiceover 139s; thumbnail; Ken Burns render 144s -> final.mp4 h264 1920x1080 + AAC 48k stereo, 25.3MB; Range 206 verified; export ZIP 28.7MB with all artifacts + scene-timed SRT.
- Bug fixed: animated segment ffmpeg "Output with label 'v' does not exist" (filter_complex only defined [a]) -> prepend [0:v]null[v].
- Animated preview E2E (scripts/test-animated-preview.mjs): CogVideoX i2v clip 1920x1080 5.1s generated+downloaded, loop-composed into 40.9s preview.mp4 with captions+music, 41s total.
- UI browser verification (agent-browser): story format selector + render modes + scene-count hint; detail dialog tabs all verified (Storyboard cards with HOST badges + re-rollers, Video tab player readyState=4 duration=143.6s + Download MP4, Package tab intact); single-scene re-roll from UI (spinner ~45s -> done, stale final.mp4 correctly invalidated then re-rendered); library MP4 badge; mobile 375px no overflow; dashboard/cast regression clean; zero page errors.
- VLM visual verification: Professor Vex identity locked across storyboard (same glasses/beard/maroon cardigan confirmed), all rendered frames have burned captions + clean composition.

Stage Summary:
- TubeForge now produces complete MP4 videos, not just packages: topic -> scene script -> identity-locked storyboard -> per-scene narration -> composed 1080p30 video with burned captions, ambient bed, faststart streaming. Two render modes: Ken Burns (~1.5 min) and full CogVideoX animation (~35s-4min per scene) + 1-scene preview renders. Auto-Pilot runs the full Ken Burns chain end-to-end.
- Key artifacts: src/lib/tubeforge/{story,render,serialize}.ts, api/videos/[id]/{storyboard,storyboard/[n],render,mp4}, create-view story mode + 5-stage stepper, detail-dialog 3-tab refactor.
- Demo state: 11 videos in library incl. "The Vanishing Medieval Library" (Professor Vex, 4 scenes, rendered Ken Burns MP4 143.6s + animated preview).
- Next: Phase 3 robustness — persistent job queue (in-memory jobs die on restart), global AI rate budget, VLM quality gating; Phase 4 — retention comments, radar->outline, ASR caption sync.

---
Task ID: 9
Agent: main (Z.ai)
Task: TubeForge Phase 3 — Robustness: persistent job queue with crash recovery, global AI rate budget, VLM quality gate, ASR narration proofreading.

Work Log:
- Verified Phases 1-2 (Tasks 7-8) fully present; proceeded with confirmed roadmap Phase 3.
- Prisma: new Job model (kind/entityId/status running|done|failed|interrupted/progress/label/error/startedAt/endedAt, 3 indexes) + Video.verifyReport; db push + client regen + daemonized dev-server restart with .next wipe.
- jobs.ts rewritten DB-backed: globalThis singletons survive HMR; every startJob persists a row and updates it on done/failed; setJobProgress persists render progress; ensureRecovered() runs a cheap indexed scan on every startJob/jobHistory — "running" rows with startedAt < process boot are marked interrupted, the owning video gets a visible "Server restarted while this X was running — run the stage again" error (artifact-landed guard prevents false errors), character errors mirror into lastJobError; jobHistory() resolves entity titles for the UI panel. All 9 startJob call sites awaited.
- NEW budget.ts: aiCall(service, label, fn, retryOpts) wraps every upstream AI call with per-service FIFO pacing (Settings-driven per-min rates, 25s cache), concurrency caps (llm 3/tts 2/image 1/video 1), and 45s shared 429 penalty windows (withRetry onRetry hook feeds them); hard 10-min fail-open so the budget can never deadlock. Migrated ALL 14 AI call sites (script/research/bible/scene LLMs, TTS chunks, thumbnails/portraits/poses/scenes images, CogVideoX i2v) off withRetry onto aiCall; withRetry moved to budget.ts; characters.ts bible LLM gained retry it never had.
- NEW quality.ts: runQualityGate(kind: thumbnail|scene) — GLM-4.5V inspects generated art (strict JSON score/issues/summary), below-threshold images re-roll once keeping the better attempt (.bak/restore), always fails open; wired into the thumbnail route job and generateSceneImage (covers full storyboards + single-scene re-rolls); logs "quality" stage activities.
- NEW verify.ts + /api/videos/[id]/verify (POST 202 job + GET status/report): ASR narration proofreading. Upstream ASR caps files at 30s AND only accepts WAV/WebM (discovered live: 400 duration limit + MP3 format rejection) → transcribe() probes duration with ffprobe and splits >28s audio into ≤25s 16kHz mono WAV chunks via ffmpeg segment muxer, ASRs each (1.5s pacing), joins transcripts; wordMatch = multiset word coverage + stopword-filtered missing-words list; per-scene scoring for story videos; report persisted to Video.verifyReport; verdicts excellent ≥95/good ≥85/needs-review. Fixed TDZ bug (similarity name collision).
- Stage routes now re-throw after recording errors (voiceover/thumbnail/storyboard×2/render/verify) so Job rows show honest "failed" status and GET polling surfaces lastJobError.
- /api/jobs history route (limit param, entity titles, interruption recovery on load); settings DEFAULTS += qualityGate/qualityThreshold/aiBudgetEnabled/ai{Llm,Tts,Image,Video}PerMin; types.ts += JobDTO/VerifyReportDTO; poll.ts += verify flag + pollVerify.
- UI: Settings gains "Pipeline Robustness" card (gate mode select, threshold slider, budget toggle, 4 rate inputs) + "Background Jobs" panel (15 recent jobs, status chips running-pulse/done/failed/interrupted, durations, refresh); detail dialog gains "Narration check" panel in Package tab (Run/Re-check button, verdict badge, word-match %, per-scene chips, missing words, transcript preview, pollVerify).
- E2E scripts/test-phase3.mjs (143s, ALL PASS): crash-sim (2 stale rows inserted 24h old → both marked interrupted, entity titles resolved, video.error surfaced); 2 concurrent thumbnails serialized by budget in 124s; quality gate LIVE results (re-rolls: 2→9, 2→8; kept-better-original case 3/10; caught garbled text 'Aleyandia' + a YouTube-logo overlay); ASR narration check on 4-scene video: 95% word match, per-scene 94/100/92/91%, verdict good, report persisted; settings round-trip.
- Browser verified (agent-browser + GLM vision): zero page errors; Settings robustness card complete (gate "Thumbnails only", threshold 6/10, budget on, 4 rates) + jobs panel populated (Done chips, durations); detail dialog Package tab shows narration report (Good badge, 95%, scene chips, transcript) + Re-check button; dashboard regression clean (quality gate entries visible in activity feed); mobile 375px scrollWidth 375 (no overflow); eslint clean.

Stage Summary:
- TubeForge's pipeline is now self-healing and self-policing: jobs survive restarts (interrupted stages are detected and explained instead of vanishing), every AI call passes a global rate budget (pacing + concurrency + shared 429 cool-downs, settings-tunable), generated art is inspected by a vision model and auto re-rolled when defective (proved live: 2/10 → 9/10), and narration is ASR-proofread with per-scene similarity reports before rendering/upload.
- Key artifacts: src/lib/tubeforge/{budget,quality,verify}.ts, rewritten jobs.ts, api/{jobs,videos/[id]/verify}, settings-view robustness+jobs UI, detail-dialog narration check, scripts/test-phase3.mjs.
- Demo state: story video "The Vanishing Medieval Library" carries a 95% narration match report; 2 fresh quality-gated thumbnails; job history populated with real lifecycle data.
- Next: Phase 4 — retention comments, topic-radar→story-outline pipeline, ASR-timed caption sync, YouTube Data API OAuth upload.

---
Task ID: 10
Agent: main (Z.ai)
Task: TubeForge Phase 4 — Growth Engine: engagement kit (retention comments), Topic Radar greenlight pipeline, ASR-timed smart captions, YouTube OAuth upload.

Work Log:
- Confirmed Phases 1-3 (Tasks 7-9) complete via worklog + filesystem; proceeded with the roadmap's Phase 4 as the user's "next".
- Prisma: Video += commentsKit (JSON kit) + youtubeUrl; db push + generate.
- jobs.ts: JobKind += "comments" | "upload" (STAGE_LABEL engagement kit / YouTube upload), crash-recovery artifact-landed guards for both, jobSnapshot += comments/upload flags; types.ts += CommentsKitDTO/CommentReplyDTO/YouTubeStatusDTO + VideoDTO.hasComments/youtubeUrl; serialize.ts emits them; poll.ts += pollComments (GET /comments) + pollUpload (youtubeUrl predicate) + GeneratingFlags fields.
- NEW comments.ts — engagement kit generator: GLM writes pinned comment (hook + one answerable question + subscribe nudge), 4 reply templates (praise / skeptic / what-next / negative take), heart targets, golden-hour playbook; persisted to Video.commentsKit + activity row. Route /api/videos/[id]/comments (POST 202 job + GET kit/generating/error, verify-route pattern).
- Greenlight pipeline: ai.ts += ResearchBrief + researchBriefBlock() (angle/keywords/why woven into prompts), generateScriptPackage + generateSceneScriptPackage accept brief; NEW /api/research/[id]/greenlight POST — loads idea from session payload, creates video (topic=idea.title, length=idea.suggestedLength, format default "story"), generates script with the research brief, unions radar keywords into tags (12 cap), FK validation, activities; research-view idea cards get "Greenlight as scene story" (POST → setFocusVideoId → library opens detail) + "Classic script" (old prefill flow).
- NEW captions.ts — ASR-timed captions: ffmpeg silencedetect(-35dB/0.30s) maps speech runs per scene WAV; narration split into <=9-word caption chunks; ASR transcript (verify.ts transcribe, now exported) positions chunk boundaries on the SPOKEN word stream (greedy forward matcher, 10-token lookahead); word positions interpolated onto speech-run timeline (proportional per run); global times = segmentStart + LEAD + wavTime mirroring the compositor's adelay; graceful fallbacks ASR-fail → silence-aligned narration, no-runs → even; min 0.4s cue, 50ms refresh gap, monotonic abutting cues. render.ts: RenderOptions.smartCaptions; buildSmartSrt wired into the burn pass (fallback buildSrtFromSegments on throw), subtitles.srt export uses the smart track; render route += smartCaptions (default true), renderVideo call updated.
- NEW youtube.ts — OAuth 2.0 + Data API v3, no new deps: consent URL (offline access + consent prompt + CSRF state in Setting), code exchange storing refresh token, token refresh with 50-min cache + invalid_grant auto-revoke, channels.list mine=true, resumable upload (metadata init → PUT bytes → thumbnails.set best-effort), human-readable error mapping (quota/forbidden/invalidCredentials hints), privacy setting (default unlisted). Routes: GET /api/youtube/status (incl. callbackUrl + clientId echo), PUT /api/youtube/config, POST /api/youtube/connect (consent URL), GET /api/youtube/callback (state check, exchange, channel identity, branded redirect page), POST /api/youtube/disconnect, POST+GET /api/videos/[id]/upload (202 job → final.mp4 resumable upload → youtubeUrl + status published; GET upload state).
- UI: detail dialog — engagement kit panel in Package tab (pin badge + copy, 4 reply rows with hover-copy + copy-all, heart targets, playbook), "ASR-synced cues" switch in Video tab (auto-disabled when captions off, passed to render POST), footer "Upload to YouTube" (only when connected + hasVideo) / "Live on YouTube" link buttons, header Live badge; settings-view — YouTube Connection card (client id/secret inputs, exact redirect URI with copy, Connect opens consent in new tab, privacy select, connected state with channel title/avatar + Disconnect); jobs panel KIND_META += comments/upload.
- Export ZIP: engagement-kit.txt (pinned/replies/heart targets/playbook), upload-metadata.txt += UPLOADED TO YOUTUBE line + kit step in how-to-upload.
- INFRA FIX: restart-dev.py was spawn-only — a stale server (pre-schema-push process on port 3000) served the first E2E attempt with an outdated Prisma client, crashing kit persistence with "Unknown argument commentsKit" and colliding a mystery render job. Rewrote restart-dev.py: pkill next dev/next-server + rm -rf .next + port-free wait + daemonize + health probe.
- E2E scripts/test-phase4.mjs — ALL PASS (33 asserts, 233s): kit structure (264-char pin, 4 replies, 4 heart targets, 404-char playbook, persisted); greenlight idea → 6-scene story in 13s with 6/6 radar keywords in tags; smart captions render clean — 4 → 41 cues asr-aligned, 100% narration coverage, monotonic timeline, last cue 139.7s vs 143.6s video; YouTube guardrails ×13 (unconfigured 400s, config round-trip, CSRF state rejection, consent URL, disconnect, privacy); ZIP contains engagement-kit.txt.
- Browser verified (agent-browser): research idea cards show Greenlight + Classic buttons; settings YouTube card renders (inputs, redirect URI, disabled-until-configured Connect, privacy select); story dialog Package tab shows populated kit (copy buttons, replies, playbook) + Video tab ASR-synced cues switch on; footer hides Upload while disconnected; mobile 375px scrollWidth 375; zero page/console errors; eslint clean; stale incident activities cleaned from demo DB.

Stage Summary:
- TubeForge now closes the loop from research to audience: a radar idea becomes a scripted scene story in one click, captions change exactly when the narration moves (ASR-aligned, 41 cues vs 4), every video ships a paste-ready launch-day engagement kit, and connected channels get a real resumable YouTube upload (title + description + tags + thumbnail, privacy-selectable) that flips the video to Published with its live URL.
- Key artifacts: src/lib/tubeforge/{comments,captions,youtube}.ts, api/{videos/[id]/{comments,upload}, research/[id]/greenlight, youtube/*}, captions wired in render.ts, engagement-kit in export route, detail-dialog kit panel + cue toggle + upload buttons, settings YouTube card, scripts/test-phase4.mjs, hardened scripts/restart-dev.py.
- Demo state: story video "The Vanishing Medieval Library" carries a full engagement kit + a 41-cue ASR-synced subtitles.srt; YouTube card in clean onboarding state (fake test credentials cleared).
- Next (Phase 5 candidates): analytics feedback loop (YouTube Data API stats back into Topic Radar scoring), multi-channel OAuth account switching, auto-generated Shorts (9:16 re-crop + punch-in edits), team/batch greenlight queue.

---
Task ID: 11
Agent: main (Z.ai)
Task: TubeForge Phase 5 — Performance Loop & Auto-Shorts: YouTube stats sync (VideoStat snapshots), Analytics view, deterministic performance boost feeding Topic Radar, and 9:16 vertical Short rendering.

Work Log:
- Confirmed Phases 1-4 (Tasks 7-10) complete via worklog + filesystem; proceeded with the roadmap's Phase 5 candidates (analytics feedback loop + auto-Shorts chosen as the two highest-impact items).
- Prisma: added VideoStat model (views/likes/comments/favorites per snapshot, indexed [videoId, snapshotAt]); Video gains publishedAt, hasShort, shortScene, shortDuration; db push.
- types.ts: AnalyticsRowDTO / AnalyticsOverviewDTO / YouTubeSyncDTO / RescoreDTO; ResearchIdea gains perfBoost + boostReason; VideoDTO gains publishedAt, hasShort/shortUrl/shortDuration/shortScene, stats.
- youtube.ts: youtubeIdFromUrl (youtu.be/watch?v=/shorts forms) + fetchVideoStats (one batched videos.list?part=statistics,snippet call for up to 50 ids, quota-hint errors).
- analytics.ts (new): syncYouTubeStats (snapshots + real publish dates + activity + ytStatsSyncedAt marker), getAnalyticsOverview (totals, per-video deltas vs previous snapshot, engagement rates, per-day channel series, winners/underperformers, dominant keywords), performanceBriefBlock (PERFORMANCE INTELLIGENCE prompt for the radar strategist), applyPerformanceBoost (deterministic keyword-overlap scoring: ≥55% +15, ≥35% +10, ≥18% +5; loser-resemblance ding -4; caps 1..100), latestStatsFor/latestStatsMap (no N+1s).
- shorts.ts (new): pickBestScene heuristic (narration density + hook-y captions + host presence), sceneTimeline mirroring render.ts segment math, captionChunks + buildShortSrt (Shorts-style karaoke captions), renderShort (cut from final.mp4, cover-fit 9:16 crop, 2160x3840 intermediate for smooth zoompan punch-in to 1.10, big vertical-safe caption burn, in/out fades, ≤45s cap, faststart, vertical short-thumb.png), readShortFile/readShortThumb.
- jobs.ts: "short" job kind + STAGE_LABEL + snapshot + crash-recovery artifact check (video.hasShort).
- Routes: GET /api/analytics; POST /api/analytics/rescore (re-boost + persist latest radar session, 404/400 guardrails); POST /api/youtube/sync (400 unconnected, single batched call runs sync); POST/GET /api/videos/[id]/short (202 job, sceneIndex pinning, state payload); mp4 route serves ?variant=short; videos list/detail routes merge latest stats; research POST applies the boost at generation + GLM prompt carries the performance brief.
- UI: Analytics view (sync bar with channel + Re-boost radar, 4 stat cards, per-video performance table with deltas/engagement/YouTube links, views-over-time bars, feedback-loop card with winners + keywords, empty state with Settings CTA), sidebar + mobile nav entry (TrendingUp), detail dialog Auto-Short panel (scene picker incl. auto-pick, Cut/Re-cut with polling, vertical 9:16 preview + download, header Short badge), research IdeaCard perfBoost badges (+15 performance etc.) with boostReason tooltips.
- E2E scripts/test-phase5.mjs (84s, ALL PASS, 50 asserts): guardrails (sync unconnected 400, short unknown 404, classic-format 400, rescore without stats 400, variant=short 404); seeded 3 published videos × 2 snapshots → totals 1590 views/122 likes/19 comments, viewDelta 790, series 800→1590, winner first, engagement 8.92%, feedback active with winner title + keywords (morning/habits/rewire/brain); stats merged into list + detail DTOs; rescore on crafted ideas (winner clone +15 capped at 100, partial +5, unrelated untouched, loser clone -4 → 46, persisted); fresh GLM radar scan with brief (8 ideas, 7 boosted with reasons); auto-Short on rendered story video (202 → 1080x1920 h264 40.8s with aac audio + vertical cover, streams via mp4?variant=short, DTO fields, pinned-scene re-cut honors sceneIndex=2).
- Fixed two aggregation bugs found by the E2E: series double-counted (snapshots are lifetime totals — removed cumulative re-sum) and dominant-keyword threshold was impossible with a single winner (max(1, ceil(n/2))).
- Browser-verified: Analytics nav + view (performance table, chart, feedback card), radar boost badges (+15/+10/+5 visible on 7 ideas), detail dialog Auto-Short panel with 9:16 preview player + Download Short. Screenshots: scripts/p5-analytics.png, scripts/p5-short-panel.png.

Stage Summary:
- The growth engine now closes its loop: upload → sync real stats → winners feed both the GLM strategist prompt and a deterministic, explainable score boost on radar ideas (with visible +N badges); underperformer clones get dinged.
- Every rendered story video can be recycled into a Shorts-ready 9:16 vertical (punch-in, karaoke captions, fades, ≤45s) from the detail dialog with auto or pinned scene selection.
- Key artifacts: src/lib/tubeforge/{analytics,shorts}.ts, youtube.ts stats section, api/{analytics,analytics/rescore,youtube/sync,videos/[id]/short}, serialize/poll/jobs updates, views/analytics-view.tsx, detail-dialog Shorts panel, research badges, scripts/test-phase5.mjs.
- Seeded demo state: 3 videos published with fake youtu.be urls + 2 stat rounds each so the Analytics view demos populated; fresh radar scan carries 7 boosted ideas. Remaining Phase 5 candidates for a future phase: multi-channel OAuth account switching, team/batch greenlight queue, Shorts auto-upload.

---
Task ID: 12
Agent: main (Z.ai)
Task: TubeForge — "IT STILL DOESN'T GENERATE VIDEOS" triage + fix: make animated MP4 generation the default path, un-block classic videos, harden TTS.

Work Log:
- User reported videos still not generating ("LIKE ANimated video not just a thumbnail") with screenshots: voiceover failing 429 / HTTP 502. Live probes showed LLM (574ms) + TTS (2-4s) healthy NOW — the 429/502 toasts were upstream rate-limit storms from earlier.
- Root cause found in the product flow, not the services: (1) Create view defaulted to format "script" (classic) — classic videos have NO render path at all (script + voiceover + thumbnail only); (2) Auto-Pilot explicitly skipped the animated render (toast: "launch it from the Library"); (3) TTS retries gave up after ~6 min of 429s.
- NEW src/lib/tubeforge/convert.ts — classic→scene upgrade: splitScriptIntoScenes (GLM copies narration VERBATIM into N scenes + art direction; mechanical sentence-split fallback with word-coverage check ≥60%), cutVoiceoverIntoScenes (ffprobe duration → silencedetect -35dB/0.30s speech runs → cumulative word-fraction cut points snapped to nearest silence gap ±2.5s → ffmpeg per-scene pcm cuts; monotonic + ≥2s guards), convertClassicToScenes orchestrator (flips format to story, resets storyboard/video flags, preserves voiceover, clears stale render artifacts). Zero TTS calls — the voice the user already has is kept.
- NEW api/videos/[id]/convert (POST 202 job + GET status) with 400 guardrails (already story / no script).
- jobs.ts: JobKind += "convert", STAGE_LABEL, jobSnapshot.convert flag, crash-recovery guard (artifact-landed = format === "story").
- poll.ts: GeneratingFlags.convert + pollConvert (format === "story" predicate, 6-min timeout).
- video-detail-dialog.tsx: classic videos now show a "Want the animated video?" upgrade card at the top of the Package tab (Make it a scene video → POST → pollConvert → reloadScenes → refreshVideo; after conversion the 3-tab layout with Storyboard + Video tabs appears automatically since defaultValue="video").
- create-view.tsx: DEFAULT FORMAT NOW "story"; Auto-Pilot runs the animated render end-to-end (removed the skip toast; 60-min poll, live progress via stepper); hint texts updated.
- ai.ts + story.ts: TTS patience raised attempts 5→6, base 6000→8000ms (≈16 min of backoff per chunk) to outlast rate-limit storms.
- settings-view: KIND_META += convert.
- E2E scripts/test-phase6-fix.mjs on "The 5 Morning Habits That Rewire Your Brain" (classic, 260w, voiced): convert 202 → 6 scenes, 100% narration coverage (265/265 words verbatim), all 6 scene WAVs cut with 0.0% duration drift (151.6s ≈ 151.6s), re-convert 400 → storyboard 202 → ANIMATED render (CogVideoX i2v, sceneLimit=1) 202 → finished 202s → preview.mp4 h264 1920x1080 13.2s + aac 6.5MB. ALL PASS (continuation script scripts/test-phase6-render.mjs; note: Bash-tool background jobs get reaped — run E2E foreground or via setsid).
- Browser verified: Create view defaults to "Scene-based story" (primary highlight); classic video dialog shows the upgrade card; converted video shows 3-tab layout with 6 painted scene cards (The Experiment / Cold Exposure / 20-20-20 Rule / Brain Dumping…) + Video tab render controls + PREVIEW (SCENE 1) player; settings jobs panel renders; zero page errors; 375px scrollWidth 375. Screenshot: scripts/fix-storyboard-tab.png.
- Fixed transient self-inflicted compile error (settings-view Clapperboard import race during edits).

Stage Summary:
- Every video can now become an animated MP4: new videos default to scene format and Auto-Pilot renders full AI animation end-to-end; existing classic videos get a one-click upgrade that splits the script verbatim and reuses the existing voiceover (no TTS re-spend, 0.0% drift); TTS survives ~16-min rate-limit storms.
- Key artifacts: src/lib/tubeforge/convert.ts, api/videos/[id]/convert, dialog upgrade card, create-view story-default + animated Auto-Pilot, patient TTS retries.
- Demo state: "The 5 Morning Habits That Rewire Your Brain" converted (6 scenes, storyboard painted) with an animated 13.2s scene-1 preview rendered via CogVideoX.
- Next: full animated render of the remaining 5 scenes on request (~4 min/scene), or Phase 6 candidates (Shorts auto-upload, multi-channel switching, batch greenlight queue).

---
Task ID: 13
Agent: main (Z.ai)
Task: TubeForge — local-PC package refresh + voice freedom ("i don't like the voices... let me use voice from internet"): Bring-Your-Own-Voice (upload / URL ingest), voice panel UI, fresh tubeforge-local.zip.

Work Log:
- Restored context post-compaction: worklog Tasks 6-12 (animated render already default per Task 12; Task 6 ZIP stale), ai.ts/story.ts/convert.ts/render routes/jobs.ts/serialize.ts + both voice-pickers.
- Prisma: Video += voiceSource ("tts"|"custom", default tts) + voiceLabel; db push + generate; dev server restarted via hardened restart-dev.py to pick up the new Prisma client (stale client silently dropped the new fields).
- NEW src/lib/tubeforge/voice.ts — BYOV ingest: downloadAudio (http/https, 2-min timeout, 100 MB cap via content-length AND bytes, content-type + extension audio sniff, readable errors) → ffprobe validation (real audio stream, 1s..30min) → ffmpeg normalize to the exact TTS studio format (24 kHz mono PCM-16 voiceover.wav, atomic-ish with staged temp + prev-restore) → story videos auto-run convert.ts cutVoiceoverIntoScenes so the brought voice is cut across scenes with the same silence-snapping cutter (0 TTS calls, voice kept verbatim).
- Voiceover route rewritten to 3 modes: bodyless/JSON {mode:"tts"} = existing TTS paths (flips voiceSource back, invalidates stale story artifacts incl. short); multipart "file" = upload (100 MB guard); JSON {mode:"url"} = internet ingest. Custom mode needs NO script. setJobProgress labels stream into the jobs panel; activities record source + duration + scene cut count.
- DTOs: types.ts VideoDTO += voiceSource/voiceLabel; serialize.ts maps them.
- UI (video-detail-dialog): Package tab Voiceover section rebuilt — source badge (fuchsia "Custom voice — <label>" vs "TTS · <voice>"), collapsible "Change the voice" panel with 3 modes (AI voices: full 7-voice Select + regenerate via PATCH voice + POST mode tts; Upload: file picker, 15 format accept list; From URL: input + Enter submit + direct-link hint), story-format hint about auto scene cutting; footer button relabels to "Switch to AI voice" for custom-voiced videos; header description shows "Custom voice — <label>". Create view: hint under Narrator voice pointing at the Package-tab voice panel.
- E2E scripts/test-byov.mjs (35 asserts, ALL PASS after fixing 3 test-semantics issues): TTS sample from the video's own script (46.5s); guardrails (invalid URL 400, bodyless POST = TTS path flipping voiceSource back to tts, example.com text/html rejected with readable error); upload mode (custom + label + duration ≈ sample ±0s + scene WAVs re-cut); URL mode (real internet mp3 — samplelib 15s file decodes to 19.2s, VBR header lie, converted WAV is truth); kenburns render on the custom-cut audio → final.mp4 26.4s h264+aac, detail DTO reflects it.
- Browser verified (agent-browser): library → Morning Habits dialog Package tab shows "Custom voice — sample-15s.mp3" badge + "VOICEOVER · 19S"; Change-the-voice panel renders all 3 modes (AI combobox with 7 voices + Regenerate, Upload chooser with disabled-until-file apply, From URL input + Fetch button + hint); footer "Switch to AI voice"; Create view hint present; zero page/console errors; scrollWidth 375 at 375px. Screenshots scripts/byov-dialog-panel.png, scripts/byov-create-hint.png.
- Demo state restored: bodyless POST re-ran TTS (kazi, 168.2s) riding out a live 429 storm (budget cool-down + attempt 2/6 → recovered), render artifacts cleared → Morning Habits back to pre-test state.
- Packaging: NEW scripts/package-local.mjs (repeatable: ROOT_FILES + src/public/scripts/prisma walks, scripts code-only filter, prisma .db filter, db/uploads .gitkeep placeholders, staged zip); recreated missing .env.example (DATABASE_URL file:../db/custom.db); LOCAL-SETUP.md rewritten (current feature list incl. animated render + BYOV how-to, ffmpeg now REQUIRED, updated troubleshooting); download/tubeforge-local.zip rebuilt — 228 files, 410 KB, leak-checked (no .env/.z-ai-config/db/uploads/worklog inside).

Stage Summary:
- TubeForge now speaks with ANY voice: upload a recording or paste a direct link to any mp3/wav/m4a on the internet and it becomes the video's narration — normalized to studio WAV, auto-cut across scenes, rendered into the final MP4. Built-in 7 voices remain one click away (footer flip-back).
- Key artifacts: src/lib/tubeforge/voice.ts, voiceover route 3-mode rewrite, dialog voice panel + create hint, schema voiceSource/voiceLabel, scripts/test-byov.mjs, scripts/package-local.mjs, LOCAL-SETUP.md, download/tubeforge-local.zip (228 files).
- Local run: unzip → npm install → cp .env.example .env → npx prisma generate+db push → cp .z-ai-config.example .z-ai-config (fill creds) → npm run dev. ffmpeg required for render/BYOV/ASR.
- Next candidates: per-scene voice files (upload one audio per scene), voice cloning provider integration, Shorts auto-upload, multi-channel OAuth switching.

---
Task ID: 7
Agent: main
Task: Answer "how do i get all this" — the .z-ai-config placeholder fields (baseUrl/apiKey/chatId/token/userId) in LOCAL-SETUP.md

Work Log:
- Traced the JSON to .z-ai-config.example referenced by LOCAL-SETUP.md §4
- Read node_modules/z-ai-web-dev-sdk/dist/index.js: only baseUrl+apiKey are required (loadConfig gate); chatId/userId/token are optional X-* headers; routes are {baseUrl}/chat/completions, /audio/tts, /audio/asr, /images/generations, /video/generation, /async-result?id=, /functions/invoke
- Confirmed sandbox uses platform-managed /etc/.z-ai-config (read-only, session-scoped, baseUrl https://internal-api.z.ai/v1) — not portable to user's PC
- Rewrote .z-ai-config.example to the minimal 2-field shape
- Added scripts/verify-config.mjs (config shape check + live chat test; --all adds tts/image/video task tests)
- Rewrote LOCAL-SETUP.md §4 (field table, where to get key, sandbox-credentials caveat, verify step) + troubleshooting row for 401/403
- Tested verify-config.mjs live: chat replied pong, exit 0
- Rebuilt download/tubeforge-local.zip (includes updated template, guide, verify script)

Stage Summary:
- User needs exactly 2 values from their own Z.ai API account: baseUrl + apiKey; other 3 fields optional/removable
- tubeforge-local.zip refreshed at download/tubeforge-local.zip
- If user's public key can't serve /audio/tts or /video/generation routes, next step is provider adapters (alternative TTS/video APIs)

---
Task ID: free-model-settings-ui
Agent: main
Task: Default to free GLM flash models + make API key/baseURL/model editable from the Settings UI

Work Log:
- (Note: environment partially reset between turns — pack/, download/, worklog rolled back; source code + dev server survived)
- types.ts: added CHAT_MODELS registry, DEFAULT_CHAT_MODEL=glm-4.5-flash (free), DEFAULT_ZAI_BASE_URL
- NEW src/lib/tubeforge/zai-config.ts: Setting-table keys (zai.baseUrl/apiKey/chatModel/visionModel), syncZaiConfigFile() materializes .z-ai-config from DB (SDK create() takes no params, only reads the file), getChatModel/getVisionModel, createZaiForTest
- ai.ts: getZAI() syncs config file before first create; added resetZAIClient()
- Wired model into all 7 chat call sites (ai.ts x2, story, convert, comments, characters = text; quality.ts = conditional vision model with cast to preserve gateway-default behavior)
- NEW /api/settings/ai: GET (masked key, never full), PUT (save + sync file + reset client), POST (test connection with overrides; finally-block re-syncs so tests never poison the live client)
- settings-view.tsx: new "AI Provider (Z.ai)" card — base URL, masked API key, chat model select (free default), optional vision model, Save & apply + Test connection buttons, link to get a free key
- Verified: tsc clean for all new code (pre-existing errors elsewhere only), GET/PUT/POST endpoints 200, dev server compiles clean
- Rebuilt portable package via NEW scripts/package-local.sh (persistent one-command rebuild): download/tubeforge-local.zip (383KB, 227 files) with SETUP.md documenting the Settings UI flow

Stage Summary:
- Script writing now defaults to FREE glm-4.5-flash — $0 on a fresh Z.ai key
- Users change API key/endpoint/model from Settings → AI Provider without touching files; changes apply to the very next AI call
- Deliverable: download/tubeforge-local.zip refreshed; packaging recipe persisted at scripts/package-local.sh

---
Task ID: multi-provider-adapters
Agent: main
Task: "switch to any ai of my choice if capable of doing the task" — capability-based multi-provider system (Z.ai + OpenAI-compatible + Anthropic + Gemini)

Work Log:
- Read all 13 AI call sites (ai.ts ×4, story ×3, convert, comments, characters ×3, quality, render, verify) + settings route/UI + voice pickers.
- NEW src/lib/tubeforge/providers/: registry.ts (provider metadata per capability, model suggestions, key URLs, OpenAI voice catalog), settings.ts (ai.chat/tts/image/video JSON rows in Setting table + read-time migration from legacy zai.chatModel/visionModel + zai creds never stored per-capability), http.ts (timeout/readable-error fetch), chat.ts (zai SDK unchanged shape | openai /chat/completions WITHOUT the zai-only `thinking` field | anthropic /v1/messages x-api-key+max_tokens+system | gemini :generateContent x-goog-api-key+systemInstruction+responseMimeType json), vision.ts (all 4 providers; quality gate fails open as before), tts.ts (zai 7 voices | openai /audio/speech response_format wav, voice sanitization + classic-6 rule for tts-1), asr.ts (zai file_base64 | openai whisper multipart), image.ts (zai CogView create+edit | openai generations with size mapping 1344x768→1792x1024 dall-e-3 / 1536x1024 gpt-image-1, b64_json handling, multipart /images/edits for gpt-image-1 only; imageEditSupported() so dall-e-3/pose-sheet callers fall back or error clearly).
- Rewired all call sites through chatComplete/visionComplete/ttsSynthesize/imageGenerate/imageEdit/asrTranscribe; aiCall budget retry unchanged (wraps adapters identically). characters.ts bible prompt now lists the ACTIVE provider's voice ids. render.ts uses video capability model (default cogvideox-3) + actionable error when video provider ≠ zai.
- zai-config.ts slimmed to global-creds + syncZaiConfigFile + createZaiForTest (SDK edit body `images` cast: .d.ts wrongly says `image`, runtime posts body verbatim — proven live before).
- API: /api/settings/ai v2 (GET: zai creds + 4 capability configs masked + provider registry; PUT scope zai|capability + copyCredsFrom:"chat" account sharing; POST test per capability incl. hidden vision/imageEdit kinds + confirmCost guard for image tests) + NEW /api/settings/voices (catalog for active tts provider).
- UI: settings-view AI Provider card rebuilt → "AI Providers" (shared Z.ai credentials block + 4 capability rows: provider select, per-provider fields, model suggestions chips, vision model, per-row Test with paid-test confirm, copy-account button); useVoices() hook in shared.tsx wired into create-view, video-detail-dialog (with voice re-sanitize effect), cast-view ×2, settings default voice.
- Tests: NEW scripts/test-providers.mjs — local stub HTTP server captures exact wire format through the real app endpoint: 55/55 PASS (openai no-thinking + roles, anthropic headers/system/max_tokens, gemini headers/JSON mode, all 3 vision formats, tts /audio/speech body, image size mapping per model, multipart edits, dall-e-3 edit→graceful-unsupported, cost guard, anthropic /v1 no-double-prefix). Run against BOTH dev (3000) and fresh-boot packaged app (3011): 55/55 both.
- Live zai chat check hit a persistent internal-gateway 429 storm; proved environmental via OLD sdk-direct scripts/verify-config.mjs failing with the IDENTICAL 429 (behavioral equivalence — same request, same response).
- Browser verified: provider switch to OpenAI-compatible reveals endpoint/key/model+suggestions/vision fields, model auto-prefill; zero console/page errors; scrollWidth 375 at 375px (screenshots scripts/providers-ui-final.png, providers-ui-mobile.png).
- Cleanup: test videos + test keys scrubbed from db (zai provider rows strip creds by design); PUT/GET roundtrip + copyCredsFrom verified live; all capabilities restored to zai defaults.
- Docs: LOCAL-SETUP.md §4 rewritten (provider matrix, key sources, UI-wins-over-file note, checklist step 2) + scripts/SETUP-local.md (provider table, mix-and-match flow).
- Repackaged via scripts/package-local.sh → download/tubeforge-local.zip (406 KB, 239 files; providers/, voices route, test-providers.mjs included; db verified clean inside zip; packaged app boot-tested on :3011 — settings/voices/library all 200).

Stage Summary:
- TubeForge is now provider-agnostic per task: scripts on any of Z.ai/OpenAI-compatible/Anthropic/Gemini, voice on Z.ai/OpenAI, art on Z.ai/OpenAI (edits: CogView or gpt-image-1), video Z.ai-only with Ken Burns as the no-AI fallback. Free end-to-end possible: GLM-4.5-Flash scripts + Gemini free tier / BYOV custom voices / Ken Burns renders.
- Z.ai path byte-identical to before (same SDK calls); every non-zai adapter wire format verified against a capture stub (55 checks).
- Deliverable: download/tubeforge-local.zip — unzip, npm install, npm run dev, Settings → AI Providers.

---
Task ID: generate-script-retry-button
Agent: main
Task: User request — "add a 'generate script' button in case it fails to generate" (video detail dialog, like the Failed 'the battle of hud' video in the screenshot)

Work Log:
- Read POST /api/videos (failed create → status "failed", error saved, no script) + video-detail-dialog structure + jobs/poll patterns
- jobs.ts: added "script" job kind (union, STAGE_LABEL, boot-recovery artifact check `Boolean(video.script)`, jobSnapshot flag)
- NEW src/app/api/videos/[id]/script/route.ts — POST (re)generates the script package as a 202 background job following the voiceover pattern: story format → generateSceneScriptPackage + reset scene-bound media (scene-NN.{wav,png,mp4}, voiceover.wav, final/preview/short.mp4, subtitles.srt, short-thumb.png) + hasStoryboard/hasVideo/hasShort=false; classic → generateScriptPackage, artifacts kept non-destructively; status via deriveStatus; failed FIRST attempt → status failed (matches create flow), failed re-roll → error only, old script + status preserved; 409 dedupe while running; clears stale error + failed→draft on start
- poll.ts: `script` added to GeneratingFlags + pollScript() watching the job flag (works for first-gen AND re-rolls)
- video-detail-dialog.tsx: regenScript handler (POST → pollScript → toast + reloadScenes for story); in-flight job adoption on dialog open; Script section rebuilt — header "Generate script"/"Re-generate script" button, error box when error && !script, rich empty state ("No script yet… One click writes a fresh scene script from your topic" + CTA); conditional footer "Generate script" button when !video.script; Storyboard tab empty state now has "Generate scene script" button (was a dead-end message pointing at Create view); convert-card error display split to error && script (no duplication with the new script-section box)
- Tests: NEW scripts/test-script-regen.mjs — simulates the exact user scenario through the live app: broken provider → failed create (500, status failed, no script) → retry via new endpoint with still-broken provider (job records failure, stays failed) → provider fixed → retry (202 + 409 dedupe + script lands, status scripted, 4 scenes, error cleared) → re-roll (fresh take) → cleanup + settings restore. 25/25 PASS (live zai gateway was 429-storming — environmental, proven identical via raw-SDK verify-config — so the success path ran through a local OpenAI-compatible stub, exercising the same provider-agnostic job/DB wiring)
- Browser (agent-browser): created a real failed video ("the battle of hud"), opened its dialog — Package tab shows error box + "No script yet" empty state + Generate script button in 3 places (section header, empty-state CTA, footer); clicked it → spinner → script landed (title/status/script/voice-button all updated); Storyboard tab shows 4 scenes + Generate storyboard; Re-generate script → fresh v2 take; zero console/page errors. Screenshots: scripts/regen-{1..6}-*.png
- tsc: zero errors in all changed files (pre-existing errors elsewhere untouched)
- Cleanup: test video deleted, stub stopped, chat provider restored to zai/glm-4.5-flash (verified via GET)
- Repackaged via scripts/package-local.sh → download/tubeforge-local.zip (415 KB, 243 files — new route + updated jobs/poll/dialog + test script included)

Stage Summary:
- Script generation failures are now recoverable in one click from the video detail dialog (no re-entering the topic in Create), and existing scripts can be re-rolled with a fresh AI take
- Story re-rolls reset scene-bound media honestly (voiceover/storyboard/renders invalidated by new scene boundaries); classic re-rolls keep old artifacts until the user re-runs them
- The button appears in 3 places for scriptless videos: script-section header, empty-state CTA, footer; in-flight jobs are adopted when the dialog re-opens
- Deliverable: download/tubeforge-local.zip refreshed
