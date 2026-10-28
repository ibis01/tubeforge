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

---
Task ID: voice-preview-audition
Agent: main (Z.ai)
Task: User request — "for voice one should be able to try and hear how it sounds while selecting it": per-voice preview/audition buttons in every voice picker

Work Log:
- Surveyed all 5 voice pickers (create-view Narrator voice, settings-view Default narrator, cast-view create+edit character Voice, video-detail-dialog AI-voices mode) — all Radix Select → shared component extracted to avoid 5x duplication
- NEW src/lib/tubeforge/voice-preview.ts — VOICE_PREVIEW_TEXT (one neutral sample line), getVoicePreview(): memory Map (32 entries LRU) + disk cache under uploads/_voicepreviews keyed by provider|baseUrl|keyFingerprint|model|voice (everything that can change the sound — caught via test flake that an endpoint/key switch would have served a stale sample), synthesized through aiCall("tts") so previews get the same pacing/concurrency/shared-429-penalty treatment as pipeline TTS
- NEW src/app/api/settings/voices/preview/route.ts — POST {voice} → WAV stream (Content-Type audio/wav); 400 unknown voice / no key for non-zai provider; 502 readable upstream errors
- shared.tsx: NEW useVoicePreview() (useSyncExternalStore over a module-level pub/sub store + ONE singleton HTMLAudioElement + blob-URL + inflight-dedup caches — starting a new preview stops the previous across ALL pickers; stale-load guard so clicking voice B while A fetches plays only B) + NEW VoiceSelectWithPreview (raw Radix SelectPrimitive.Item — NOT shadcn SelectItem, which wraps ALL children in ItemText that Radix clones into the trigger; label-only ItemText asChild span keeps the trigger clean, play/stop button sits outside with pointerdown/pointerup/touchend/click stopPropagation so auditioning never selects/closes, per-item CheckIcon indicator preserved)
- Rewired all 5 pickers to VoiceSelectWithPreview (+ "Tap the ▶ next to a voice to hear how it sounds" hints in create/settings/dialog)
- Tests: NEW scripts/test-voice-preview.mjs — 36/36 PASS against the live app via ephemeral OpenAI-compatible stub: unknown-voice 400 readable, catalog flip classic-6, first click hits /audio/speech with exact wire body (model tts-1 default, voice, input=preview line, speed 1, response_format wav, Bearer key), repeat click = identical bytes with ZERO upstream re-hit (cache), new voice → new hit, model switch → new cache key + new hit, stub 500 → 502 readable (rode out ~11s of retry backoff then recovered), capability restored + catalog flip-back verified
- Live zai path 429-storming all round (raw-SDK verify-config identical error — environmental, proven per established pattern); success path proven through the provider-agnostic stub like prior rounds
- Browser (agent-browser) across Create/Settings/video-detail-dialog: dropdown shows ▶ per voice; clicking ▶ plays (Stop state), menu STAYS OPEN, voice NOT selected; switching ▶ to another voice stops the previous (shared singleton); Stop button toggles off; clicking the option row itself selects + closes; trigger shows the CLEAN label (SelectItemText fix); disk-cache second-session instant hits; mobile 375px scrollWidth 375 + Settings picker preview works; zero console/page errors. Screenshots: scripts/voice-preview-dropdown.png, voice-preview-settings-mobile.png, voice-preview-dialog.png
- Fixed a transient swallowed click during verification (Fast-Refresh rebuild window) — re-verified deterministic across a fresh reload: pointerdown/up/click instrumentation confirmed events reach the button with target=polygon and toggle correctly
- Cleanup: tts capability restored to zai (7 studio voices verified), stub killed, uploads/_voicepreviews test cache removed, browser closed
- Repackaged via scripts/package-local.sh → download/tubeforge-local.zip (435 KB; voice-preview.ts, preview route, updated shared.tsx/views, test-voice-preview.mjs included; verified inside zip)

Stage Summary:
- Every voice picker in TubeForge is now a try-before-you-commit booth: tap ▶ next to any voice to hear a short sample while the menu stays open, audition several voices, then pick — works for Z.ai's 7 studio voices AND any OpenAI-compatible TTS provider (provider-correct catalog), with server-side caching so repeat auditions never re-spend TTS calls
- Previews respect the AI rate budget (shared 429 cool-downs), survive dev-server restarts on disk, and invalidate honestly when the user switches provider/endpoint/key/model
- Deliverable: download/tubeforge-local.zip refreshed — same local flow as before (unzip → npm install → npm run dev)

---
Task ID: quality-overhaul-10of10
Agent: main
Task: "Make it 10/10, the thumbnail should always match the scripts and more scene for short, medium and long" — the 2/10 retention review six points (≤3s visual change, strong hooks, music ducking, SFX library, rehooks, anti-slop) + thumbnail-script matching + richer scene counts.

Work Log:
- types.ts: SCENE_COUNTS short 4→8 / medium 6→12 / long 8→16 (tighter narration per scene); Scene + SceneDTO gain `rehook: boolean` and `sfx: string`; SFX_KINDS registry ("whoosh|boom|riser|sting|pop"); RENDER_MODES kenburns copy updated (multi-shot, SFX, ducked bed, ≈2–5 min).
- story.ts: scene-script prompt rebuilt — banned slop openers ("Since the dawn of time…", "X was one of history's most…"), hook must open mid-action/shocking number within 5 words, ~1 rehook per 4 scenes flagged, per-scene sfx cue with semantic guidance, every scene ends on a pull-forward line; normalizeScene() shared coercer; scene 1 force-rehooked + rehook-without-sfx upgraded to "sting"; parseScenes keeps legacy rows renderable (scene 1 rehook default).
- ai.ts: classic generateScriptPackage prompt gets the same anti-slop + pattern-interrupt-every-~75-words rules; NEW deriveThumbnailConcept() (flash LLM distills the script's most striking visual moment, falls back to hook sentences); generateThumbnail() accepts `concept` and paints "this exact moment from the video's story" instead of a generic topic card; fixed pre-existing tsc errors (pickVariantStyles typing).
- convert.ts: classic→scene split carries rehook/sfx (verbatim narration rule untouched); mechanical fallback marks scene 1 rehook+sting.
- NEW sfx.ts: royalty-free SFX library synthesized from raw oscillators/noise via ffmpeg (whoosh=flanged pink-noise swell, boom=pitch-drop 110→38Hz+crack transient, riser=sine glissando+noise crescendo, sting=dissonant 660/699Hz hit, pop=880Hz blip), cached at uploads/_sfx/<kind>.wav (48k stereo PCM16), synthesized once per machine.
- render.ts: multi-shot Ken Burns engine — each scene cut into ≤2.7s shots (single ffmpeg invocation: split→trim→per-shot zoompan→concat→grade), shot plan = scene camera first (rehook scenes open with "punch": 1.16→1.06 in 0.45s), rotation never repeats, pans/tilts get start-zoom OPPOSITE the previous shot's end zoom (visible reframe at every cut, z=1.10 floor so pans have travel room); finishing grade (eq contrast/sat + vignette) on both render modes; SFX mixed into scene starts via adelay(40ms)+amix normalize=0 weights '1 0.55'; music bed now DUCKED via sidechaincompress (threshold .03, ratio 9, attack 25ms, release 450ms) with asplit sidechain + amix normalize=0 weights '1 0.85' + limiter.
- Thumbnail matching: thumbnail + variants routes derive a concept per video (story → scene 1 visual+mood verbatim; classic → deriveThumbnailConcept) and pass it to generateThumbnail + the VLM quality-gate context; variants share ONE concept so A/B compares style not subject; script/route.ts re-rolls (both formats) now invalidateThumbnail() — deletes thumbnail.png + variant-*.png, hasThumbnail=false — so a stale cover can never outlive its story.
- UI: storyboard cards show amber ⚡ REHOOK badge (bottom-right) + fuchsia "sfx: <kind>" chip; verified live in the browser.
- Tests: NEW scripts/test-shotchain.mjs (standalone ffmpeg proof: 11/11 — cuts land exactly at shot boundaries 3.07s/6.13s, zero black frames, SFX +50.5dB over no-sfx control, bed ducks −33.9dB under speech vs −16.2dB in gaps, exact segment duration); NEW scripts/test-quality-overhaul.mjs (app E2E via OpenAI-compatible stub: 38/38 — scene counts 8/12/16 for short/medium/long, scene-1 rehook + rehook-sfx auto-upgrade, thumbnail prompt contains the scene-1 story moment, preview render 14.4s with cuts every ≤2.43s and 0 black frames, whoosh audible at the opener, limiter holds, re-roll deletes the stale thumbnail + resets the flag); test-script-regen.mjs re-run 25/25 after giving its stub a 600ms pace (sub-ms stub finished the job before the 409-probe — test race, not a regression).
- Bug found by tests & fixed: opening a scene with its own pan camera at z=1.0 froze the pan (zero travel range) and made the first internal cut invisible → pan/tilt openers now start at z=1.10; amix default normalize was burying SFX by 1/(1+w) → normalize=0 everywhere weights are used.
- Housekeeping: fixed pre-existing tsc errors in touched routes (video.title narrowing into closures, THUMB_STYLES literal union); test videos + settings restored/cleaned (db verified: 16 demo videos, 0 test rows, zai defaults); _sfx cache persisted.
- Repackaged via scripts/package-local.sh → download/tubeforge-local.zip (includes sfx.ts, updated render/story/convert/ai, routes, tests; db inside verified clean of test rows).

Stage Summary:
- Every render now changes framing at least every ~2.7s (hard camera cuts at verified boundaries), opens on a punch-zoom hook with a whoosh, resets attention with sting-punctuated rehooks every ~4 scenes, keeps a broadcast-style ducked music bed, and never shows a black frame.
- Thumbnails are derived from the script itself — story videos paint their opening scene, classic videos paint the script's most striking moment — and a script re-roll invalidates the old cover automatically.
- Scene density doubled-to-doubled-again (8/12/16 for short/medium/long) with per-scene SFX cues chosen by the script writer.
- Deliverable: download/tubeforge-local.zip refreshed; verification persisted in scripts/test-shotchain.mjs (11/11) + scripts/test-quality-overhaul.mjs (38/38).

---
Task ID: regression-fix-final-worse
Agent: main
Task: "the video generated now is more worse" — forensics on upload/final.mp4 (video cmvqvgzau003er9v2xj7cdn8x, 121s short, rendered 16:23 after the quality-overhaul) + fixes.

Work Log:
- Forensics: 8-tile frame grid, scene-change detection, dense frame strips, frame-to-frame pixel diffs (scripts/measure-strobe.py), DB scene dump, thumbnail + subtitles.srt inspection, volumedetect on head/tail.
- Ruled OUT (numeric evidence, not eyeballs): zoompan strobing (alternation ratio 0.94-0.97 = smooth; earlier strip reading was an illusion; select scene>0.02 bursts are threshold sensitivity on slow zoom), trailing black frame (grid tile was empty-cell filler; 121.4s/8 = 15.2 tiles).
- Root causes confirmed: (1) caption chunker split decimals — "$6.5 million" → cue "$6." + "5 million each." on a numbers-dense script; (2) anti-slop prompt only banned OPENERS — body kept Einstein fake quote / latte / tree-proverb clichés; (3) formula notation in narration ("Compound interest = Principal × (1 + Rate)^Time") → unreadable TTS + broken captions; (4) visual prompts requested charts/formulas/aging-morphs → AI gibberish text in art (Σ=d=V0 galaxy, fake bar charts); (5) prompt asked for ONE sfx per scene → model filled 8/8 (synth cues every scene start); (6) rehookEvery = round(8/4)=2 produced "1 in every 2" → 4/8 scenes punch+sting.
- captions.ts: protectNumbers() swaps decimal points before sentence regex; same guard added to ai.ts splitForTts (TTS chunk boundaries) and convert.ts mechanicalSplit.
- story.ts: NEW shared exports — narrationToSpeech (% ^ × ÷ = → words), paintableVisual (chart/text-requesting visuals get a hard text-free clause), isRehookPosition (deterministic rehooks at 1,4,7,…), applyRetentionRules (forces the rehook map, strips sfx from non-rehooks, scene 1 = boom, speaks math, hardens visuals); system+user prompt rebuilt (cliché/fake-quote ban, spoken-language rule, paintable-moment visual rules, sfx reserved for rehooks, deterministic rehook scene list); scene artPrompt carries full no-text/no-numbers/no-charts negative.
- ai.ts: classic script prompt gets the same banned-cliché/spoken-language rules; deriveThumbnailConcept + generateThumbnail prompts demand ONE dominant emotional focal subject + no charts/graphs/numbers/UI negatives.
- convert.ts: both split paths route through applyRetentionRules; LLM split prompt aligned; rehook map + boom opener in mechanical fallback.
- render.ts: SFX mix weight 0.55→0.35 (synth accents ~9dB under voice); music bed re-tuned 0.10/0.07/0.05 → 0.045/0.032/0.022 with a 0.07Hz breathing LFO + lowpass 900Hz (measured mean −28dB vs −21dB before — pad, not hum); ducking chain unchanged.
- Tests: test-quality-overhaul.mjs updated + extended (stub now models an over-eager writer: scene-5 rehook gets demoted, stray sfx stripped, none-sfx rehook upgraded, formula/chart fixture) → 47/47 PASS live (scene counts 8/12/16, rehooks [1,4,7]/[1,4,7,10]/[1,4,7,10,13,16], notation spoken, visual hardening, thumbnail still paints the script moment + no-charts negative, cuts every ≤2.43s, 0 black frames, opener boom −10.2dB, limiter holds, re-roll invalidates thumbnail); NEW scripts/test-caption-decimals.ts (bun, real scene narrations → "$6.5 million each." stays whole).
- Repackaged via scripts/package-local.sh → download/tubeforge-local.zip.

Stage Summary:
- The "worse" video was hurt by caption number-butchering + slop prompts + over-dense SFX/rehooks, NOT by the camera engine (multi-shot cuts verified smooth).
- Retention pacing is now deterministic (rehooks 1,4,7,…; SFX reserved for those beats; opener boom), scripts/visuals/math are sanitized post-hoc so weak models can't leak slop past prompts, and the music bed is a quiet breathing pad.
- Old videos keep their old scripts — to benefit, re-roll the script (regenerates scenes + invalidates the stale thumbnail), then storyboard → voiceover → render again.

---
Task ID: quality-pass-2
Agent: main (Z.ai)
Task: User six-point bar — storyboard image↔scene perfect match, subtitle↔voiceover sync, no foolish transition sounds, per-niche background music, top-notch sound engineering, top-performer practices.

Work Log:
- Forensics on the re-rendered final.mp4 (113.7s): 0 black frames; found scene 5 (dark credit-card art) read as a 13.5s FROZEN shot. Standalone repro of multiShotFilter proved cuts existed but were visually INVISIBLE — the wide↔tight flip was only 1.04↔1.14 (~10% FOV), undetectable on dark/low-texture art; and wide pans at z≈1.02 have ~2% travel = frozen.
- render.ts camera overhaul: every cut is now a ~35-40% FOV jump (zoom-in 1→1.4, zoom-out 1.42→1.02, push-in 1.02→1.4, punch 1.32→1.14); pans/tilts hold z 1.22-1.36 so sweeps move ~10-14% of frame (frozen-pan fix); shotSequence flip logic rewritten per-variant (startZoomFor).
- render.ts per-niche music beds: MUSIC_PROFILES for all 8 niches (Motivation warm A-min swell, Fun Facts bright C, History epic low D, Finance cold minimal G, Psychology soft E, Space airy A fifth, Technology clean F, Mysteries dark F#-C tritone) — own partials/LFO rate/depth/lowpass/level each; finalize() builds the aevalsrc from musicProfileForNiche(niche); render route passes video.niche.
- render.ts mastering: loudnorm=I=-14:TP=-1.5:LRA=11 (YouTube target) between the ducked mix and the limiter — consistent broadcast level on every upload.
- sfx.ts "no foolish sounds" pass: sting 660/699Hz game-show ding → cinematic braam (92+97.4Hz dissonant low pair + 55→30Hz sub drop + brown-noise bow, lowpassed); riser now noise-dominant (bare sine glissando read as cheap theremin); boom crack → brown-noise thud; "pop" (880Hz blip) REMOVED from SFX_KINDS + recipes (legacy "pop" cues silently skip); stale _sfx cache cleared. Catalog is now LOW and DARK only.
- captions.ts sync hardening: chunk boundaries snap to real silence-run pauses within ±0.45s (pauses ARE phrase boundaries); cues lead voice by 80ms (early reads in-sync, late reads broken), floored at scene start; MAX_CHUNK_WORDS 9→7 (1-2 punchy lines).
- Storyboard↔scene match: quality.ts gate prompt adds STORY MISMATCH rule (clean-but-wrong-subject scores ≤3); story.ts gate context now carries scene visual + mood + narration moment; artPrompt adds "ONE dominant subject filling the frame"; this install's qualityGate setting flipped to "all" so every storyboard image is VLM-verified against its scene with one bounded re-roll.
- Top-performer research folded in: pattern interrupts every 3-4s (2.7s shots + perceptible amplitude), music ~ducked far under voice, -14 LUFS, captions 1-2 lines slightly early.
- Tests: test-shotchain 11/11, test-quality-overhaul 47/47 (opener peak now -2.7dB under loudnorm, limiter holds), test-caption-decimals OK, lint 0 errors.
- App re-render of cmvqvgzau003er9v2xj7cdn8x verified: scene 5 window now continuous 15-21 per-0.5s diffs (constant motion) + hard cut at 69.0s; 0 black frames; opener boom -1.1dB peak; bed -17.5dB mean in gaps; captions "$1,000"/"10 percent" whole + ≤7 words + 80ms early; thumbnail = scene-1 moment (Sarah + single gold coin over coin mountain, vault light shafts).

Stage Summary:
- The invisible-cut defect is fixed at the root: amplitude, not frequency, was the retention killer on dark art. Every camera cut is now unmistakable and pans never freeze.
- Sound design has no game-show noises left; each niche breathes its own bed; every render masters to YouTube loudness.
- Storyboard images are verified against their scenes by the VLM gate by default (fails open, one bounded re-roll).
- Deliverable: re-render + tests verified; repackage pending.

---
Task ID: security-reliability-music
Agent: main (Z.ai)
Task: Audit roadmap priorities — P0 security hardening + P1 reliability (cancellation, QC gate) + background-music system (licensed library, mood matching, mix controls) + branding + release hygiene.

Work Log:
- P0 AUTH: NEW src/lib/tubeforge/auth-token.ts (edge-safe HMAC-SHA256 signed tokens, session 7d / api 90d, b64url) + auth.ts (PBKDF2-120k password in Setting "auth.password", login rate-limit 5/10min/IP, cookie helpers) + src/middleware.ts (locks ALL /api/* except /api/auth/{status,setup,login,logout}; Bearer or tf_session cookie; CSRF Origin check on cookie-authed mutations; open only when TUBEFORGE_AUTH_SECRET unset — documented dev mode) + /api/auth/* routes (status/setup/login/logout/token — token mints Bearer for scripts) + AuthGate lock-screen component (first-run "create password" vs "sign in", branded, reveal toggle, error box) wrapping page.tsx + global window.fetch 401 watcher (session expiry re-locks via reload) + Sign out button in sidebar. Secret generated into .env. Live-verified: anonymous /api/stats 401 -> setup 200+cookie -> 200 with cookie -> wrong-pw 401 + rate limit -> logout -> login again.
- P0 SSRF: voice.ts downloadAudio rebuilt — http(s) only, BLOCKED_HOST_RE (localhost/.local/.internal/metadata), isPrivateAddress (v4 0/10/127/169.254/172.16/192.168/100.64 + v6 loopback/ULA/link-local/mapped), assertPublicHost via DNS all-address re-check (rebinding guard), MANUAL redirect loop (max 4 hops, each re-validated), size/type caps unchanged.
- P0 TSC STRICT: ignoreBuildErrors removed from next.config; tsconfig excludes examples/pack/skills/scripts/db/uploads; fixed all 5 real errors (ScheduleSlotGetPayload wrapper, readMedia variant cast, form?.get, voiceover mode union narrowing via customMode).
- P0 RELEASE HYGIENE: .gitignore + git untrack db/ uploads/ pack/ download/ tool-results/; NEW SECURITY.md (rotate-any-shared-key warning, protection matrix, checklist); package-local.sh NO LONGER ships live db/custom.db (fresh .env with generated per-package secret, bun.lock copied, setup script added, post-zip security scan compares against live secret + scans for db/uploads).
- MUSIC: Prisma MusicTrack (license record: type/sourceUrl/commercialUse/attributionRequired+text/licenseEvidence/downloadedAt/contentIdNotes, isOriginal, moods, isActive) + Video music fields (musicEnabled/TrackId/Volume/FadeIn/FadeOut + qcReport). NEW music.ts: 10 original beds synthesized from pure sine stacks (two-chord cos-window blend, 1/60-quantized breathing LFOs = seamless loop, detuned L/R stereo, loudnorm -16 LUFS anchor, FLAC) with idempotent seed + file-regen; ingestUploadedTrack (ffprobe audio validation, 60MB cap, transcode 48k stereo FLAC loudnorm, license metadata); NICHE_MOODS auto-selection (tag match -> prefer loop-free/longest); resolveMusicForVideo (video pin > settings manual > auto; slider x0.3 gain; clamped fades). Routes: /api/music (GET auto-seed+list, POST multipart upload w/ license validation | {action:seed}), /api/music/[id] (PATCH metadata/toggle, DELETE row+file), /api/music/[id]/audio (FLAC stream preview). render.ts finalize(): track input (-stream_loop -1) + atrim/volume/afade-in/afade-out chain into the existing sidechain duck + loudnorm -14 + limiter; drone fallback when no track. Videos POST/PATCH accept music overrides; settings route music.* defaults (enabled/mode auto|manual/trackId/volume/fades; music.trackId null clears).
- MUSIC UI: settings-music.tsx (MusicLibrarySection: defaults card with mode/volume/fade sliders saved to Setting keys, library rows with LicenseBadge colors by commercial/attribution state, preview singleton audio, active switch, delete, upload dialog with full license record fields incl. attribution-text requirement gate, Restore originals reseed) + music-controls.tsx (shared MusicPickerCard: enable switch, Auto/pinned track select + preview, volume + fade sliders showing Settings defaults; useMusicLibrary hook; TrackPreviewButton singleton) wired into create-view (create payload) and video-detail-dialog (debounced 600ms PATCH; replaced the old plain music switch; render POST music flag = enabled!==false).
- RELIABILITY: jobs.ts JobCancelledError + cancelled Set + requestJobCancel (all running kinds per video) + isJobCancelled + "cancelled" JobStatus + NEW /api/videos/[id]/cancel; render route checks cancel in onProgress (between scenes/steps), storyboard route passes shouldCancel+onSceneDone per-scene progress into generateStoryboard (cancelled scenes kept, hasStoryboard partial state); NEW qc.ts battery (playable h264+aac, duration-vs-narration drift, blackdetect 0.25s, volumedetect peak -0.5 max, silencedetect 1.5s dead-air, ebur128 integrated [-19,-9], SRT monotonic/in-range) -> qcReport JSON on the video + activity message; render route runs QC after full renders (progress label "Running quality checks"); serializeVideo parses qcReport safely + music fields; types.ts VideoDTO + QcReportDTO.
- RELIABILITY UI: detail dialog QC panel (Passed/flagged badge + all checks with values/details) + Cancel render button while busy; NEW attention-panel.tsx on Dashboard — "Generating now" (live 8s poll, per-job cancel) + "Needs attention" (failed/interrupted with per-kind one-click Resume hitting the stage endpoints) — the Mission Control audit asks.
- BRANDING: NEW red-orange flame-play mark (src/app/icon.svg favicon + logo.tsx shared TubeForgeLogo/Wordmark) — sidebar + mobile nav + lock screen splash; layout.tsx z-cdn icon reference removed.
- FIXES DURING VERIFY: my render-route rewrite dropped sceneLimit from renderVideo (suite caught it — full render ran instead of preview; restored); attention cards + AI provider grids overflowed at 375px (grid min-width:auto vs nowrap min-content — fixed with [&>*]:min-w-0; scrollWidth 375=375); crashed-suite leftovers (capabilities pointing at dead stub 127.0.0.1:3975) restored to zai defaults incl. glm-4.5-flash.
- TESTS: suites made auth-aware (TF_API_TOKEN bearer in jfetch/api helpers); NEW scripts/verify.mjs (lint+tsc+auth-gate-live+shotchain; --full adds app suites) + backup.sh (sqlite VACUUM INTO hot copy + integrity check + uploads manifest/--media + .env mode 600) + package.json typecheck/verify/verify:full/backup. RESULTS: verify fast suite green (ESLint 0, tsc 0, gate 401, shotchain 11/11); quality-overhaul 47/47; BYOV 36/36 (SSRF-guarded internet mp3 import + full custom-voice render); live E2E re-render of cmvqvgzau auto-picked "Sunrise Drive" (Motivation) -> QC 7/7 PASS (-14.5 LUFS, -0.6 peak, 0 black, no dead air, 39 cues); browser E2E via agent-browser: first-run setup -> unlock -> dashboard attention/Resume -> Settings library previews (play/stop singleton) -> Create picker -> dialog QC panel 7 rows -> mobile 375 clean -> sign-out/in cycle -> zero console/page errors.
- CLEANUP: test password cleared (user gets first-run setup on next visit), orphan test videos deleted, providers on zai defaults, zip repackaged 538KB/284 files with 0 db files inside, git commit af3da27.

Stage Summary:
- The audit's P0 is done: every API is locked behind signed sessions (middleware, zero per-route edits), first-run lock screen, rate-limited login, Bearer tokens for scripts, SSRF-guarded downloads, strict TS build, and the shipped zip contains no live database/secrets (SECURITY.md warns to rotate any key from previously shared archives).
- Music is a real product system now: 10 zero-Content-ID original beds + user-uploaded licensed tracks (full license records), niche mood-matching, per-video pin/volume/fades in Create + dialog, library management with previews in Settings, pure-FFmpeg mixing (loop/trim/fades/duck/-14 LUFS) with the synthesized drone as fallback.
- Pipeline reliability: any video's jobs can be cancelled (render + storyboard checkpoint mid-loop, partial work kept), every full render ends with a 7-point QC report surfaced in the dialog, and Mission Control shows live jobs + failed jobs with one-click Resume.
- Verify with one command: `bun run verify` (fast) / `bun run verify:full` (adds app suites); backups via `bun run backup`.

---
Task ID: kenburns-smart-motion
Agent: main (Z.ai)
Task: Make Ken Burns movement a core TubeForge feature — scene-aware "Smart Motion" engine per the product spec: intentional (not uniform) movement, subtle default amplitude (1.00→1.12×), movement plans per scene type, focal-point preservation, Create-page controls, safe borders, 16:9 + 9:16.

Work Log:
- MOTION ENGINE (NEW src/lib/tubeforge/motion.ts, pure/unit-tested): classifyScene (7 kinds — emotional/establishing/detail/suspense/action/text/standard from scene words + tone/niche, text-legibility wins); focalForScene (LLM "focal" token > composition keywords > center, faces anchor high); planSceneMovements — per-scene camera plans honoring the spec table (emotional→slow zoom-in, landscape→zoom-out, map/document→pan across details, suspense→0.6× gradual zoom, action→1.9s deliberate cuts, text→≤3% drift, standard→LLM camera intent) with cross-scene direction queue (vary flips pan/tilt/zoom between scenes), punch opener preserved on rehook beats (senior to the movement table), wide↔tight re-framing bands (start zoom chosen to maximize cut delta ≈11-20% FOV) so cuts read as cuts while within-shot amplitude stays subtle, creep continuation across long-scene cuts (ZOOM_CEIL 1.24); sceneFilterGraph — 2× supersample (3840×2160 / 2160×3840) → per-shot zoompan (smooth cosine easing via 0.5-0.5*cos(PI*on/last) or linear) → concat → grade; focal-locked x/y = clip(f*iw−iw/(2*zoom),0,iw−iw/zoom) (zoom≥1 ⇒ focal mathematically cannot leave frame) and pan sweeps clamped to an 8% focal pad (panEndpoints exported for tests); mode overrides smart|zoom|pan|off, off/0% → static (no zoompan).
- SCHEMA: Video.motionMode/motionIntensity(0..30)/motionCurve/motionVary (all nullable = defaults), db pushed, client regenerated. POST/PATCH /api/videos accept+clamp the four fields; serializeVideo emits them; render route passes sanitizeMotion(video)+motionContext{tone,niche}; short route passes them to renderShort.
- RENDER: render.ts old kenBurnsFilter/shotSequence/multiShotFilter deleted; buildSegment renders sceneFilterGraph(plan) — Smart Motion on by default for kenburns mode (MOTION_DEFAULTS smart/12/smooth/vary). STORYBOARD: Scene.focal? + SceneDTO.focal + parseScenes/normalizeScene/serializeScenes carry it; script prompt now asks the LLM for a "focal" token (center/left/right/upper/lower/corners) per scene.
- SHORTS (9:16): blind center-crop replaced with focal-centered cover crop (cropX/cropY from focalForScene against probed master dims) + smooth cosine-eased punch-in (amplitude = video motion intensity clamped ≤16%, linear option, 0% = still); vertical plan shape swaps lateral pans→tilts.
- UI (NEW motion-controls.tsx, mirrors music-controls): MotionControlsCard — movement mode grid (Smart Motion/Zoom only/Pan only/Off), zoom-intensity slider 0-30% with None/Subtle/Strong zones (default 12%), movement curve (Smooth cinematic/Linear), vary-direction switch, live "Current configuration" summary line (planSummaryLine), animated-mode note; wired into create-view (story format, payload) and video-detail-dialog (debounced 600ms PATCH like music).
- TESTS: NEW scripts/test-motion.ts (bun imports the REAL motion.ts — zero drift): 55 checks incl. the spec movement table, focal tokens/keyword fallback, plan invariants (z≥1, ≤1.36 ceiling, duration-sized pools, vary behavior, mode filters, 9:16 tilt preference), an end-to-end focal-in-frame PROOF (every pan sweep sampled at 21 points across 60 focal/direction/travel combos, worst margin 5.7%), graph hygiene (no NaN/undefined, correct output sizes) and REAL ffmpeg renders (emotional 5s, action 6.5s with scene-detector-verified cuts at 2/2 boundaries at the old suite's calibrated 0.05 threshold, static 3s with 0 cuts, blackdetect 0 everywhere). NEW scripts/test-motion-api.ts (15 checks: bearer auth gate, PATCH round-trip, clamping, null reset, storyboard DTO focal). verify.mjs fast path now runs the motion suite; --full runs the motion API suite. test-shotchain.mjs header updated to point at the live-graph suite (its copied filter code predates the overhaul).
- FIXES DURING VERIFY: rehook+sfx no longer forces "action" classification (suspense rehooks keep suspense); detail-scene pan-lead respects zoom-only mode; cross-scene vary queue unified (NEXT-direction state, standard openings follow it when vary is on); blackdetect test flag bug (pix_th 0.98 counted near-white as black) fixed to defaults; dev server needed restart-dev.py (fresh Prisma client) before API tests passed; quality-overhaul 4a/4b recalibrated to the scene-aware pacing contract (old ≤3s rule replaced by spec's full-scene holds; preview = detail 2 shots + text 1 hold → 2 cuts, maxGap ≤8.5s).
- BROWSER E2E (agent-browser): first-run setup → Create card renders with live summary ("Scene-aware zoom and pan · 12% zoom intensity (subtle) · smooth easing · direction variation enabled"); Pan-only + 0% ("Static images — no movement") + restore verified; dialog card debounced PATCH persisted motionMode off→smart to DB; zero console/page errors; original auth hash backed up + restored, test artifacts cleaned.
- RESULTS: lint 0 errors, tsc clean, auth gate 401, shotchain 11/11, Smart Motion 55/55, quality-overhaul 47/47, motion API 15/15, providers 55/55.

Stage Summary:
- Ken Burns is now a core, spec-complete feature: every scene gets an intentional camera plan (not a uniform zoom), focal points from the storyboard LLM (new "focal" field) are locked in frame through every zoom and pan (proven by test, worst margin 5.7%), default 12% amplitude with smooth easing and direction variation matches the mock, and movement modes/intensity/curve/variation are user-controllable in Create and the video dialog with a live config summary.
- The engine is one reusable module (motion.ts) consumed by both the 16:9 master renderer and the 9:16 Short cutter — no duplicated ffmpeg logic, and the test suite imports the real source so it can never drift again.
- Smart Motion is enabled by default for Ken Burns renders; Off/None still renders static frames; quality gates (QC battery, black-frame scan) unchanged and green.

---
Task ID: auth-optin-lock
Agent: main (Z.ai)
Task: User blocked by forced password popup — make the lock screen OPT-IN (studio open by default; owner enables protection when they choose, from Settings).

Work Log:
- MODEL FLIP: protection is no longer forced by TUBEFORGE_AUTH_SECRET presence. Setting "auth.enabled" is the source of truth, mirrored to db/auth.lock flag file; src/middleware.ts now nodejs runtime and hot-checks the flag per request (existsSync is microsecond-scale — no cache, so toggling bites the very next call; a 1.5s TTL cache version failed the live suite and was removed). Secret still required to SIGN sessions; removing flag file or secret re-opens the studio instantly.
- API: new POST /api/auth/lock ({enabled:true,password} first-enable creates the password, re-enable demands the existing one so a LAN stranger cannot claim a configured studio; {enabled:false,clearPassword?} reopens + optionally forgets the hash; the enabling browser always gets a fresh session cookie — can't lock yourself out of the tab you enabled from). /api/auth/status now reports gateEnabled from the opt-in state.
- UI: AuthGate renders children directly when gateEnabled=false (no popup, no splash beyond the brief checking state) and broadcasts tf-gate events; app-sidebar listens and hides "Sign out" while the studio is open. NEW security-card.tsx ("Studio access" in Settings, after Auto-Pilot): switch, inline create/confirm password form, toast feedback, `bun run auth:reset` recovery hint.
- RECOVERY: scripts/auth-reset.ts (bun:sqlite; resolves DB from DATABASE_URL; --purge also deletes the password hash) + package.json "auth:reset". First draft had TS-in-.mjs and a Setting.updatedAt NOT NULL miss — both fixed.
- TESTS: NEW scripts/test-auth-optin.ts (11 live checks: open by default, first-enable, instant 401 on anon, wrong-pw 401, session accepted, re-enable-without-pw 400, disable+clearPassword restores clean state; respects an owner-configured lock without touching it) wired into verify.mjs; test-motion-api.ts now lock-aware (temporarily enables the lock for its 401 check, restores state after, +1 check).
- DOCS: SECURITY.md rewritten for the opt-in model (protection matrix + checklist + recovery).
- STATE: ran auth-reset --purge — user's server is lock-off, no password stored (they choose their own when enabling).
- VERIFY: lint 0 errors, tsc clean, auth-optin 11/11, shotchain 11/11, Smart Motion 55/55, quality-overhaul 47/47, motion-api 16/16, providers 55/55. Browser E2E: fresh visit → straight to Dashboard (no popup, zero console/page errors); Settings toggle on → toast + Sign out reappears; second browser session → lock screen; owner reload stays open (session); toggle off → popup gone for everyone. Commit 1509256.

Stage Summary:
- The password page is now the owner's choice, not a roadblock: the studio is open by default, and Settings → Studio access turns protection on/off instantly with a guided password flow.
- Enforcement, sessions, rate limiting, CSRF and Bearer tokens are unchanged while the lock is ON — only the default posture changed (locked-out → opt-in).
- Recovery exists at three levels: the enabling tab keeps its session, `bun run auth:reset` reopens the studio, and `--purge` forgets a lost password.

---
Task ID: local-run-package
Agent: main (Z.ai)
Task: User wants TubeForge running on their local PC — refresh and verify the portable package.

Work Log:
- NEW scripts/auth-reset.mjs: Node/cross-platform recovery command (no bun needed on the user's PC) — flips auth.enabled via `prisma db execute`, removes db/auth.lock, supports --purge. Tested against the live sandbox DB.
- package-local.sh updated: ships only runtime helpers (backup.sh + auth-reset.mjs) instead of all sandbox test suites; portable package.json gains "auth:reset": "node scripts/auth-reset.mjs"; ships empty db/ (.gitkeep) so prisma's relative file:../db/custom.db resolves; header comments now describe the opt-in lock.
- SETUP-local.md rewritten: fresh/empty studio (no live DB shipped — it held keys/tokens), setup is now 5 steps incl. `npm run setup` (prisma db push), new "Protecting your studio" section (Settings → Studio access opt-in lock + auth:reset recovery), scripts/ tree updated, Windows note for the cp-based build/start, backup note.
- SECURITY.md: recovery line now covers both bun (sandbox) and npm (local package) variants.
- PACKAGE VERIFIED END-TO-END: rebuilt download/tubeforge-local.zip (491KB, 261 files), secret scan clean (no live db/uploads/live secret), then unzipped to /tmp and simulated the user's machine: npm install OK → npx prisma db push creates db/custom.db inside the package → next dev on :3100 → /api/auth/status {configured:false, gateEnabled:false} (no popup), / 200, /api/videos 200 with empty library. Caught + dismissed a false negative: the sandbox shell exports DATABASE_URL which overrode the package .env (env -u reproduces the user's clean environment where the relative path resolves correctly).
- Test server killed, /tmp artifacts removed. Deliverable: /home/z/my-project/download/tubeforge-local.zip.

Stage Summary:
- The user can now run TubeForge locally: download tubeforge-local.zip → unzip → npm install → npm run setup → npm run dev → paste their own Z.ai key in Settings. Open studio by default, opt-in lock, npm run auth:reset recovery — all shipped and boot-verified from a cold extraction.

---
Task ID: provider-neutral-rebrand
Agent: main (Z.ai)
Task: User wants the Settings "Z.ai credentials" card to feel provider-neutral, not tied to one AI brand.

Work Log:
- settings-view.tsx: card title "Z.ai credentials" → "Shared AI credentials"; subtitle now "One account for the built-in gateway — used by every task you leave on its default provider"; placeholder "Paste your Z.ai key" → "Paste your API key"; link "Get a free Z.ai API key" → "Get a free API key" (href unchanged); error prefix + code comments neutralized. Internal Setting keys (zai.baseUrl/zai.apiKey) intentionally unchanged — zero migration, saved keys keep working.
- types.ts: CHAT_MODELS refreshed to the 2026-10 platform lineup — added glm-5.3-flash ("Current flash generation — native multimodal, budget tier") and glm-5.3 (flagship), glm-4.5-flash hint now honestly says "Legacy — delisted from docs but still served, $0".
- providers/chat.ts: thinking param is now model-aware — /^glm-(4\.7|5\.3)/ models get { type: "enabled" } (they FORCE thinking; disabled errors with code 1210 per docs.z.ai/guides/capabilities/thinking), all other models keep the fast { type: "disabled" }. Fixes the user's local glm-5.3-flash 1210 failure without changing sandbox 4.5-flash behavior.
- VERIFY: bunx tsc --noEmit → exit 0.
- PACKAGING: rebuilt download/tubeforge-local.zip (491KB, 261 files, integrity OK) with all changes baked in; copied over public/tubeforge-local.zip. Staged the 3 changed files individually at public/tubeforge/{settings-view.tsx,types.ts,chat.ts} so the user can curl-patch their local install without re-downloading the zip.

Stage Summary:
- Settings now reads brand-neutral ("Shared AI credentials", "Paste your API key") while keeping the provider names in per-task dropdowns (those are accurate identities, not branding).
- Model dropdown matches today's platform; glm-5.3-flash is selectable directly and the 1210 thinking error is auto-avoided by chat.ts.
- User apply path: 3 short curl commands from the preview site (settings-view.tsx → src/components/tubeforge/views/, types.ts → src/lib/tubeforge/, chat.ts → src/lib/tubeforge/providers/), then restart dev server. chat.ts overwrite supersedes the earlier manual nano step (idempotent, strictly better).

---
Task ID: github-push-prep
Agent: main (Z.ai)
Task: Prepare TubeForge for its first GitHub push ("let push to git hub")

Work Log:
- Audited sandbox repo: 634 tracked files incl. 429 workspace/debug artifacts (forensics/ frames, upload/ pastes, scripts/ screenshots, public zip+patches) and a REAL .env (TUBEFORGE_AUTH_SECRET); git history also contains committed .env/db — sandbox history must never be pushed
- Hardened .gitignore: removed bare `test`/`prompt` footgun patterns; /db/ and /uploads/ changed to keep .gitkeep placeholders; appended hygiene block (!.env.example, *.sqlite*, /upload/, /forensics/, /scripts/, public/tubeforge-local.zip, public/tubeforge/, *.tar, .vscode/, .idea/, Thumbs.db)
- Untracked .env + workspace dirs from index; added placeholder-only .env.example; committed → tracked set now 205 files, working tree clean
- Wrote scripts/tf-git-setup.sh for the user's local ~/tubeforge: fixes .gitignore footguns, creates .env.example, git init on main, re-run-safe untracking of known secrets, HARD secret gate (.env*/z-ai-config/db/sqlite/tar, --diff-filter=ACMR) + 5MB size gate, single commit, push via gh CLI (private) or printed manual PAT steps
- Wrote scripts/test-git-setup.sh: scratch tree mirrors the shipped zip (old .gitignore via git show HEAD~1, fake .env/db/renders/artifacts); 4 scenarios: happy path, idempotent re-run, gate refusal, recovery from previously-tracked .env. Fixed 1 bug found by tests (gate false-triggered on deletions). Final: 22/22 PASS
- Delivered: download/tf-git-setup.sh + public/tf-git-setup.sh (curl-able)

Stage Summary:
- Push source is the user's LOCAL ~/tubeforge (newer 14-provider code, clean fresh history) — not the sandbox (history has secrets)
- Script gates guarantee .env, db/custom.db, uploads/, archives never reach GitHub; .env.example + .gitkeep placeholders do
- Next: user runs tf-git-setup.sh (gh authed → auto private repo + push; else manual remote+PAT); optional README/LICENSE follow-up; reminder to rm -rf ~/tf-pkg (557MB tar with credentials)

---
Task ID: github-push-done
Agent: main (Z.ai)
Task: User executed tf-git-setup.sh on local ~/tubeforge — first GitHub push

Work Log:
- User curl'd https://preview-chat-92cf2337-6ca5-4169-a0bc-3579414f698b.space-z.ai/tf-git-setup.sh (md5 verified against sandbox copy before handing over the URL)
- Script ran clean: .gitignore hardened, git init on main, commit af7e12d (221 files tracked), gh CLI authed
- gh created PRIVATE repo ibis01/tubeforge, pushed 292 objects / 618 KiB, main tracking origin/main
- No gate triggers → .env, db/custom.db, uploads/ confirmed absent from the push

Stage Summary:
- TubeForge source now lives at https://github.com/ibis01/tubeforge (private)
- Future updates: cd ~/tubeforge && git add -A && git commit -m "..." && git push
- Pending user actions: delete ~/tf-pkg (557MB tar with credentials); optional README/LICENSE; optional first end-to-end video test

---
Task ID: go-public-url-fix
Agent: main (Z.ai)
Task: User sent screenshot — browser shows DNS_PROBE_POSSIBLE for "random-words.trycloudflare.com". Diagnose and get the real quick-tunnel URL working.

Work Log:
- Diagnosed: "random-words.trycloudflare.com" is the placeholder example from my earlier chat message, NOT a real assigned URL (matches user's known habit of pasting placeholders literally). DNS_PROBE_POSSIBLE is expected — that domain doesn't exist.
- Real URL source: tf-go-public.sh greps cloudflared's log and prints it in the "YOUR PUBLIC URL" box (verified script logic in public/tf-go-public.sh lines 44-62). Tunnel is alive only while that terminal stays open.
- Advised user: (1) go back to the running tf-go-public.sh terminal, copy the boxed URL; (2) if terminal was closed, re-run `bash ~/tf-go-public.sh` — old URL dies, new one prints; (3) liveness check `pgrep -af cloudflared`; (4) app origin must be running too (`cd ~/tubeforge && npm run dev` in a second terminal if port 3000 died).
- Re-issued security push: local studio lock screen is still OFF (user chose "y" earlier) — must enable Settings → Studio access + password BEFORE sharing the real URL, since API key/credits (db/custom.db) are exposed otherwise.
- Offered follow-up: permanent address via ngrok free static domain (URL stops changing every run); also pending README/LICENSE + rm -rf ~/tf-pkg cleanup reminders.

Stage Summary:
- No code changes needed — tunnel tooling was working; user typed the example URL instead of the script-assigned one. Awaiting user confirmation that the real https://<words>.trycloudflare.com URL loads their dashboard.

---
Task ID: go-public-eaddrinuse
Agent: main (Z.ai)
Task: User hit EADDRINUSE when running `npm run dev` on local ~/tubeforge.

Work Log:
- Diagnosed: EADDRINUSE on port 3000 = their dev server was already running from earlier — not a failure. Advised: verify with `curl -s localhost:3000/api/auth/status`, then check tunnel with `pgrep -af cloudflared`; restart tunnel via `bash ~/tf-go-public.sh` only if pgrep prints nothing.
- Gave clean-restart sequence for when a fresh app start is genuinely wanted: `fuser -k 3000/tcp` then `cd ~/tubeforge && npm run dev`, with note that the tunnel 502s while the app is down.
- Repeated lock-screen reminder (still OFF on user's local studio).

Stage Summary:
- Guidance only. State: user's local app is (almost certainly) already up on :3000; tunnel status unknown until user runs pgrep / the script again.

---
Task ID: storyboard-resumable
Agent: main (Z.ai)
Task: User hit a 429 mid-way through a 16-scene storyboard (scenes 1-4 painted, rest blocked). Diagnose + make storyboard resumable so re-clicking doesn't waste credits on already-painted scenes.

Work Log:
- Diagnosed: 429 = z.ai upstream rate limit on the image endpoint. Existing retry (4 attempts, 5s base × 4 on 429 → up to ~75s of waits) plus the 45s shared cool-down in budget.ts is correct — but the 16-scene storyboard loops through ALL scenes every run, so a 429 at scene 5 meant re-clicking would re-paint scenes 1-4 too (wasteful, plus more 429s).
- Code patch src/lib/tubeforge/story.ts::generateStoryboard — added `force?: boolean` (default false) and a resume check at loop top: if `!force` AND scene-XX.png exists on disk AND size ≥ 1000 bytes, call onSceneDone, sleep 2s, continue. Per-scene re-roll endpoint (POST {scene:N}) is unaffected (it calls generateSceneImage directly, not generateStoryboard). No API or DB schema change.
- Typecheck: project `bunx tsc --noEmit` clean (the staged public/tubeforge/*.ts snapshots show context-only errors because they live outside the src tree — those are intentional curl artifacts).
- Staged at public/tubeforge/story.ts (md5 a737f9ff439ca2a3fb6d112c5b80efc9, verified identical to src), preview-host URL serves 200 with the same md5.
- Restarted sandbox dev server via scripts/restart-dev.py to wake the preview proxy after a transient 403 (preview host needs the dev server up).

Stage Summary:
- User apply path: `curl -fsSL https://preview-chat-92cf2337-6ca5-4169-a0bc-3579414f698b.space-z.ai/tubeforge/story.ts -o ~/tubeforge/src/lib/tubeforge/story.ts` then restart the local dev server (fuser -k 3000/tcp && npm run dev). After the patch, clicking "Generate Storyboard" again only paints scenes whose image file is missing — scenes 1-4 are skipped, scene 5+ resumes. Per-scene "重新生成" buttons still force a single scene to repaint as before.
- Reminders still pending: enable Settings → Studio access lock before sharing the public URL; optional ngrok free static domain for a permanent address; README/LICENSE; rm -rf ~/tf-pkg cleanup.

---
Task ID: storyboard-429-malformed-response
Agent: main (Z.ai)
Task: User's storyboard crashed with "Cannot read properties of undefined (reading 'map')" mid-run (screenshot: 16-scene video "Productivity Lies Exposed", scenes 1-4 painted, storyboard stage marked Failed). Diagnose + fix.

Work Log:
- Forensics: the exact error string "Cannot read properties of undefined (reading 'map')" is thrown inside `node_modules/z-ai-web-dev-sdk/dist/index.js` at line 269 (createImage) and line 316 (createImageEdit) — both do `result.data.map(...)` with no guard. When z.ai returns HTTP 200 with a body that has NO `data` field (capacity / soft-rate-limit envelope), the SDK crashes with that TypeError. The error bubbles up through `aiCall` → `generateSceneImage` → `generateStoryboard`, lands in the storyboard route's catch block (line 181), and gets saved to `video.error`. The dialog then displays it via the `{video.error && !renderLabel && ...}` banner at line 2157 — exactly what the screenshot shows.
- Why retry didn't save it: `budget.ts` `withRetry` only escalates backoff when the error message matches `/429|too many requests/i`. A bare TypeError doesn't match, so the retry layer treats it as a terminal error and gives up after 4 attempts without waiting for the upstream to recover.
- Fix `src/lib/tubeforge/providers/image.ts`: added `callZaiImage<T>(label, fn)` wrapper that catches the malformed-response TypeError (`/reading 'map'/i`) and rethrows as `429 too many requests — <label> returned a malformed response (no data field), treating as rate limit`. Now the budget.ts retry layer sees "429", triggers the 45-second shared cool-down (`noteRateLimit`), and uses the x4 backoff multiplier — so the storyboard loop will wait out the upstream storm instead of failing the video.
- Wrapped both SDK call sites: `zai.images.generations.create` and `zai.images.generations.edit`. The OpenAI-compatible path was already safe (uses `data?.` optional chaining).
- Typecheck: src tree clean (the public/tubeforge/*.ts snapshot errors are expected — those files are curl-distribution copies outside src).
- Staged at public/tubeforge/image.ts (md5 84a6baf09bfe1ad697f9e81e4487324a), preview host serving same md5.

Stage Summary:
- User apply path (one command, then restart): `curl -fsSL https://preview-chat-92cf2337-6ca5-4169-a0bc-3579414f698b.space-z.ai/tubeforge/image.ts -o ~/tubeforge/src/lib/tubeforge/providers/image.ts` then `fuser -k 3000/tcp && cd ~/tubeforge && npm run dev`. After the patch, malformed z.ai responses are treated as 429s — the storyboard will pause and retry instead of marking the video "Failed".
- Combined with the earlier story.ts resumable patch, even if the storm is bad enough that the storyboard eventually fails after the full retry window, re-clicking will only paint scenes that didn't finish. Two patches, same one-line curl flow.
- Recommended pairing: lower Settings → AI Budget → "Image per minute" to 5-6 for the heaviest storyboards. Pending: lock-screen enable, public URL confirmation, README/LICENSE, rm -rf ~/tf-pkg cleanup.

---
Task ID: pollinations-image-provider
Agent: main (Z.ai)
Task: User said "let use another alternative ai" after another storyboard 429 — wire Pollinations.ai as a free no-key image provider so they can switch off z.ai CogView when it rate-limits them.

Work Log:
- Network probe: curl'd Pollinations directly. Confirmed: returns JPEG bytes (not PNG as URL implies), downscales 1344x768 → 1015x580, free tier is 1 image / 45s / IP (returned 402 with "Free limit reached"), 503 SERVICE_UNAVAILABLE when at capacity. Both error responses carry JSON bodies with "Retry after Ns" hints.
- Code changes (4 files):
  1. src/lib/tubeforge/providers/registry.ts — added "pollinations" to ProviderId union; added a Pollinations entry to IMAGE_PROVIDERS with models [flux, turbo, flux-realism], note honestly explaining the 45s/IP limit.
  2. src/lib/tubeforge/providers/image.ts — added pollinationsImage() that builds the URL `${baseUrl}/prompt/{enc(prompt)}?width=W&height=H&model={model}&nologo=true&seed={rand}` and fetches via providerFetch; converts JPEG → PNG via sharp (Next.js ships sharp, dynamic import keeps cold-start clean). Catches 503/429/402 from Pollinations and rethrows as a "429 too many requests — Pollinations rate-limited (HTTP N)" message so budget.ts triggers the 45s shared cool-down (which exactly matches Pollinations' free-tier window). imageGenerate routes to pollinationsImage when provider==="pollinations"; imageEdit returns null (caller falls back to prompt-seeded fresh generation with cast fragment, which lands back here); imageEditSupported returns false.
  3. src/components/tubeforge/views/settings-view.tsx — hide the "API key" Input when provider==="pollinations" (no key needed); test button caption switches from "generates one small image (real cost)" to "generates one image — free, no key" when provider is pollinations.
  4. src/app/api/settings/ai/route.ts — skip the cost-confirmation gate for the test endpoint when provider==="pollinations" (otherwise the user can't test the free provider without clicking "Confirm — runs a paid test" which is misleading).
- End-to-end test (scripts/test-pollinations.mjs): real network call through the live adapter — imageGenerate({size:"1344x768"}) returned 766,631 bytes PNG (sharp converted from JPEG), 7.2s latency. imageEditSupported returned false ✓. imageEdit returned null ✓. Caught 402/503 mid-test and rethrew as 429-flavored errors (budget layer will handle). One test-script-side bug at the very end (named vs default fs import) — production code unaffected.
- Typecheck: src tree clean (the staged public/tubeforge/*.ts snapshots show expected context errors because they live outside src — those are intentional curl artifacts).
- Staged for curl-patch at public/tubeforge/{registry.ts, image.ts, settings-view.tsx, ai-route.ts}. All four md5s verified identical between src/ and preview-host responses.

Stage Summary:
- User apply path (4 curls + restart):
  curl -fsSL https://preview-chat-92cf2337-6ca5-4169-a0bc-3579414f698b.space-z.ai/tubeforge/registry.ts       -o ~/tubeforge/src/lib/tubeforge/providers/registry.ts
  curl -fsSL https://preview-chat-92cf2337-6ca5-4169-a0bc-3579414f698b.space-z.ai/tubeforge/image.ts          -o ~/tubeforge/src/lib/tubeforge/providers/image.ts
  curl -fsSL https://preview-chat-92cf2337-6ca5-4169-a0bc-3579414f698b.space-z.ai/tubeforge/settings-view.tsx -o ~/tubeforge/src/components/tubeforge/views/settings-view.tsx
  curl -fsSL https://preview-chat-92cf2337-6ca5-4169-a0bc-3579414f698b.space-z.ai/tubeforge/ai-route.ts        -o ~/tubeforge/src/app/api/settings/ai/route.ts
  fuser -k 3000/tcp && cd ~/tubeforge && npm run dev
- Then: Settings → AI Providers → Artwork → provider dropdown → pick "Pollinations.ai (free, no key)" → leave API key blank (field is hidden) → Save. Storyboard scenes will now generate via Pollinations. The 45s/IP limit means a 16-scene storyboard takes ~12 minutes; Pollinations 402/503 errors auto-trigger the 45s budget cool-down so the pipeline paces itself without failing.
- Honest tradeoff the user needs to know: free Pollinations is slower than z.ai CogView (z.ai can do 8/min = 16 scenes in 2 min when not rate-limited; Pollinations is hard-capped at ~1.3/min). For users who want speed, options: (a) keep z.ai but drop AI Budget → Image per minute to 5-6 + rely on the new resumable+429 patches from the previous turns; (b) buy a Pollinations pollen key at enter.pollinations.ai for unlimited; (c) use the OpenAI-compatible image provider with a paid DALL·E / gpt-image key.
