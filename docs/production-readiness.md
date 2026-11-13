# TubeForge — Production-Readiness Roadmap (governing, adopted 2026-11-13)

**Formal decision (adopted at S98, HEAD `d023a01`):** major feature development
is FROZEN. Until every gate below is closed, the only allowed changes are
security fixes, reliability improvements, bug fixes, and maintenance. No new
video engine starts before the exit criteria pass.

The 13-engine roadmap is complete. TubeForge's next competitive advantage is
operational reliability, not another AI engine. Each stage below lands as a
numbered worklog stage with the established discipline: unit pins, full local
gates, and a CI-green push before the stage is marked done.

## Why (the evidence)

The S60 production incident proved that a Postgres-only regression can ship
with zero automated coverage when every CI surface runs SQLite — the S61 lane
closed that specific hole, but the pattern generalizes. The queue's recovery
logic still assumes same-host claimants (insufficient for distributed
workers), storage quota checks are read-check-write rather than atomic
reservations, the rate limiter is an in-memory Map with a spoofable
`X-Forwarded-For` trust boundary, production CSP still allows
`unsafe-inline`/`unsafe-eval`, and the Dockerfile's fidelity to a real
deployment is unevidenced. These are the classes of failure that cost users,
not features that attract them.

## The eight priorities (validated against HEAD `d023a01`, S98)

| #   | Priority                                            | Status at adoption                                                                                                                                 |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Deterministic Prisma generation + clean-clone CI    | PARTIAL — postinstall selects SQLite/Postgres schemas by URL protocol; the S61 CI lane covers clean PostgreSQL migration + recovery; no strict clean-clone verification gate existed |
| 2   | Queue leases/fencing + storage reservations         | OPEN — atomic DB claims exist, but no renewable leases or fencing tokens; storage quota checks are not atomic reservations (concurrent uploads can exceed quota) |
| 3   | Shared rate limiting + trusted proxy IPs            | OPEN — limiter is an in-memory Map (per-instance, reset on restart); client IP trusts the first `X-Forwarded-For` value |
| 4   | CSP + SVG ingestion hardening                       | PARTIAL — SVG ingestion sanitizes before storage and rasterizes before trust; CSP still permits `unsafe-inline` and `unsafe-eval` |
| 5   | Docker production smoke                             | PARTIAL — Dockerfile generates Prisma for Postgres and ships FFmpeg + Chromium; no full-topology smoke evidence |
| 6   | Monitoring + recovery                               | PARTIAL — structured logging and backup scripts exist; restore drill pending; alerts not operationally evidenced |
| 7   | Module decomposition + warning reduction            | OPEN — 0 lint errors but 20 existing warnings; TypeScript 7 blocked by typescript-eslint (PR #10 stays open) |
| 8   | Feature freeze                                      | ADOPTED at S98 — the decision above is the record |

## Execution order

| Stage | Deliverable                                | Exit condition                                                                                                                                              | Status |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| P0.1  | Prisma + clean-clone CI                    | A fresh clone installs, bootstraps, and generates both dialect clients deterministically — without hidden local state                                        | **S99** — `scripts/test-clean-clone.mts` + CI `clean-clone` job + unit pins |
| P0.2  | Queue leases + fencing                     | Renewable lease expiration, monotonic fencing tokens, conditional completion with the current token, expired-claim recovery; concurrent-worker and stale-worker tests pass | **S100** — renewable leases + monotonic `leaseToken`, fenced terminal writes, reap-with-token-bump (`test:queue` phase C) |
| P0.3  | Storage reservations                       | Durable reservations with atomic accounting, expiry, and release-on-failure; concurrent uploads cannot exceed quota                                          | **S101** — serialized admission + durable `StorageReservation` holds + expiry sweep + release-on-failure (`test:storage`) |
| P0.4  | Shared rate limiting + proxy trust         | Multi-instance limits hold (key-value backend); trusted-proxy chain design; spoofing tests pass                                                              | **S102** — `proxy-trust.ts` right-to-left trusted walk + DB-backed `RateLimitCounter` enforced at requireUser (`test:rate`) |
| P0.5  | CSP + SVG security                         | Security regression suite passes; production CSP drops `unsafe-inline`/`unsafe-eval`                                                                          | **S104** — nonce-based CSP (scripts + styles), middleware extended to pages, e2e CSP regression |
| P0.6  | Docker production smoke                    | The full production topology renders successfully end-to-end (see the target topology below)                                                                  | **S105** — `docker-smoke.sh` walks postgres + the S3 store + web + worker: HTTP register→create, ffmpeg render, S3 round-trip, cross-process job, worker-restart recovery (CI job on main pushes); **S108** — the walk now also renders a REAL whiteboard project IN-CONTAINER through the worker's chromium (DEPLOYMENT §5.1's recorded tail: launch args, frames, encode, artifact, ffprobe'd duration) |
| P1.1  | Monitoring + restore drills                | Measured recovery time and actionable alerts                                                                                                                  | **S103** — measured restore drill (CI, RTO printed) + `alert:probe` (8 actionable checks) + runbook §4.1 |
| P1.2  | Module decomposition                       | Reduced complexity and zero avoidable warnings                                                                                                                 | **S106** — 20 warnings fixed at the site (eslint 0/0); storage.ts (768 lines) split into facade + `storage-s3.ts` + `storage-quota.ts` with re-exports |
| P2    | Feature expansion                          | Remains frozen until the gates above close                                                                                                                     | **OPENED (S109, 2026-11-13)** — the operator's explicit call, against the fully-gated baseline; the entry queue is recorded below |

## P2 entry queue (adopted 2026-11-13, from the operator's review at HEAD `8e76c6b`)

The freeze is lifted. The review's verdict sets the order — "the next best
step is not another feature" — so P2 opens with operations, not engines:

1. **Security-doc drift closed** — S109 (this record): SECURITY.md reconciled to
   the live source (the stale 2025-10-28 posture, the wrong backup.sh-absent note,
   the pre-account checklist), README re-dated (S109, the real eight-job CI lane),
   ROADMAP's arc note records the lift.
2. **Staging provisioned** per DEPLOYMENT §3 — `tubeforge-staging` on Fly (same
   image), a Neon branch, a separate R2 bucket, Stripe TEST-mode keys + webhook,
   console email, fresh secrets. Requires operator accounts; the provisioning kit
   and drill scripts land as the next stages so provisioning is one command once
   the accounts exist. **Kit landed (S110)**: `fly.staging.toml` +
   `scripts/staging-provision.sh` (one command, `--dry-run` verified) +
   `scripts/staging-drill.mts` (the HTTP harness: health/billing/pipeline
   suites, proven live — 2 PASS · 1 SKIP · 0 FAIL against a dev server) +
   `scripts/staging-drills.sh` + `docs/runbooks/staging.md` (incl. the RC gate,
   §7). Remaining: the operator's accounts (runbook §1) → provision → drills.
3. **Launch drills ON staging** — the Stripe checkout → webhook → portal
   lifecycle, the YouTube test-channel publish smoke, backup restore, the k6 load
   run (`scripts/load-test.js`), and worker recovery under load.
4. **Release-candidate tag** — tag `vX.Y.Z-rc1` at the post-drill HEAD; cut the
   GitHub Release from the worklog entry.

Standing cleanups that ride alongside: the rate limiter's fail-open posture is
monitored aggressively (the alert probe; a `RateLimitCounter write failed`
announcement is an incident, not a log line); `frame-ancestors` moves to an
allowlist the moment the preview architecture is proven compatible; the largest
UI/rendering files are split BEFORE new engines arrive (the S106 decomposition
pattern); PR #10 (TypeScript 7) stays parked on typescript-eslint's peer ceiling.

**First P2 feature track (adopted 2026-11-13): scene-level editing & repair.**
The operator delivered the architecture ("a Scene-Level Production Control
Layer on top of existing production infrastructure"); Stage 0 — the read-only
repository reconciliation — landed as **S111**
(docs/design/scene-level-editing-reconciliation.md): capability map against
live code, the five requirements vs reality, three architectural surprises
(positional scene identity, the two-document content split, the eleven
mutators), two found defects (the dead storyboard/upload route; unaudited
scene edits), and the file-by-file Stage 1–7 plan with the proposal's exit
criteria restated as tests. **The operator's go came with the build
order (2026-11-13, "start, don't stop"), and the four §10 decision
points resolved to their recommended defaults**: revision rows are kept
forever (only superseded ARTIFACTS are GC candidates), render consumes
the latest APPROVED revision per scene, spend ceilings are opt-in per
video, and whole-script regens/converts are EPOCHS. **Stage 1 landed as
S112** — the SceneRevision table (immutable, append-only, unique on
(videoId, sceneId, version)), stable Scene.id minting (carry for
interactive mutators, fresh-against-history for epochs), the union-slice
content snapshot (row scene + timeline doc scene), optimistic
concurrency twice over (expectedSceneVersion → 409+current, and the
unique index as the hard floor), first-touch backfill (the pre-edit
state records as v1, so even the first edit has a rollback target),
rollback-as-new-revision (never a delete; history is never erased),
approved heads never superseded, and ALL ELEVEN scenes-column mutators
retrofitted through one commit path (a source pin enforces it). New
API surface: GET /scenes/[n]/revisions + POST /scenes/[n]/rollback.
Exit criteria pinned by a new DB-backed battery (12 tests, in `check`).
**Stage 2 landed as S113** — the declarative dependency map
(scene-deps.ts: field → this scene's stale artifacts / video-level
renders / merged-voice / boundary, with PATCH + rollback both enforcing
it — the scattered if-branches became one pinned table), the
SceneArtifact provenance registry (the full composed prompt — which S111
found was discarded — the input hash, provider/model, the head revision,
and accumulated cost through the UsageRecord bridge columns
videoId/sceneIndex/artifactId; pending→ready lifecycle, idempotent on
same inputs, supersede-on-new-input), registration at the four
generation sites (scene image incl. instruction edits, per-scene TTS,
i2v clips, whiteboard scene encodes), and **the §8.3 over-invalidation
cost bug FIXED and measured**: a one-scene art change now kills exactly
that scene's clip + the video-level renders — the other scenes' cached
clips survive and the render reuses them (ensureSceneClip), so a
one-scene fix no longer re-pays the whole video's paid clip generation.
Battery now 18 tests. **Stage 3 landed as S114** — the scene preview
lane: POST /render {sceneIndex} (mutually exclusive with the sceneLimit
prefix grammar) renders ONE scene through the same segment machinery as
scene-preview-NN.mp4 — the story-lane twin of the whiteboard lane's
per-scene preview — and touches NOTHING else (no other scene's
artifacts, no final/preview, no row flags, no project QC, no srt: "a
scene preview is not a certified final video" is the lane's own law).
The preview registers as a type-preview artifact carrying the revision
it was built from; artifactStaleness (current/stale/unknown vs the
scene's head) labels it, surfaced by GET /scenes/[n]/artifacts (with the
mp4 route's scene-preview variant streaming the file, authed +
org-scoped). Battery now 20 (the preview pin is a REAL ffmpeg render:
three scenes' fixtures, preview scene 2, assert scene-preview-02.mp4
landed and every other key untouched). **Stage 4 landed as S115** —
repair + cost authorization + job idempotency: the propose→approve→reject
ladder (POST /scenes/[n]/repair: estimate from the admission's own cost
table, the affected-asset list from Stage 2's map shown BEFORE approval,
no code path generating before the approvedBy stamp — requirement D's
"no silent paid calls" as the ladder's shape), the SceneRepair table
(the durable form of the critic/VCE proposals), Job.idempotencyKey
(unique; done/pending/running rows resolve retries to the standing row
— the retry-after-done double-bill path is dead; failed rows re-queue
honestly, conditionally per the S100 fencing law), Video.spendCeilingMicro
(opt-in per project, enforced in the same admission window as the credit
hold via cost-guard.ts: video-scoped spend + estimate ≤ ceiling, else
402 with the numbers), and the render route joining both gates. Battery
23/23 incl. the double-bill pin and the ladder. **Stage 5 landed as S116**
— the scene QC + boundary validation + the approval gate: the
scene-scoped recheck (POST /scenes/[n]/recheck — run arm enqueues a
bounded "scene-recheck" job; approve arm is synchronous) re-runs the
whole-file battery's probes on ONE scene's standing preview (the qc.ts
builders exported and reused, never forked), slices the captions check
to the scene's doc window when an SRT stands (the battery's own
emit-only-when-present precedent), and runs the S49 restricted-visual
scan at scene scope under a restricted policy. THE BOUNDARY LENS: a new
render grammar POST /render {boundaryAfter: N} renders scenes N+N+1
with their seam (scene-boundary-NN.mp4, the doc's durations through the
ONE exported duration fold resolveSceneDuration — render loop and seam
expectation consume the same math, pinned), and the recheck's
alignSeam holds the detected cuts to it (a CUT seam must appear within
tolerance, a BLEND seam has no must-appear obligation — the T-55.2 law
— and strays in the seam's neighborhood fail; interior detections
belong to the full battery). The verdict is stored ON the head revision
(SceneRevision.recheck, an annotation — content byte-identical, pinned)
and records the revisionVersion it judged; the approval gate
(approvalBlocker, pure + pinned) requires a PASSING verdict for the
HEAD'S OWN version: no verdict / a verdict for an older revision / a
failed verdict all refuse (409), approval is a status flip only and
idempotent, and an approved head survives newer drafts (the S112 law).
Never-silently-clean holds at scene scope: unmeasured seams (no pair
rendered — each carries the exact command that would render it) keep
the report red. Battery now 26/26 (a real-ffmpeg recheck pin: 13 probes
measured on a real preview, the annotation-immutability pin, a real
boundary-pair render with the seam verdict measured through the shared
fold, and the full approval-gate ladder). **Stage 6 landed as S117** —
final assembly from approved revisions + the render manifest: the full
render consumes, per scene, the latest APPROVED revision (draft edits
never leak into a final; nothing approved → the v1 baseline — the
pre-draft state; no history → the row), with the union slice restored at
the current position (the doc-half swap rides the assembly's timeline;
previews and boundary pairs deliberately bypass the assembly — they are
looks at the working draft). Video.renderManifest records the exact
revision set the final was assembled from (per scene: sceneId, source,
revisionVersion); renderStaleness compares it LIVE against the current
assembly sources — any newer draft, any new approval (an approval changes
the source even without an edit), any scene-list change ⇒ stale with
reasons; history + no manifest ⇒ unknown (a pre-S117 final cannot prove
its assembly — re-render). BOTH ship gates extend their existing 409
seam: publish and export refuse a stale or unprovable final, with NO
override — unlike a QC finding a human may accept, staleness is a fact
about WHICH bytes ship. The render status surface exposes the manifest +
the live verdict. Battery now 28/28 (the assembly pin: a drafted scene
falls back to the v1 backfill, the approved revision wins, the restored
content sits at the current position; the manifest pin: a REAL runRenderJob
render assembles the baseline — the draft never leaks — records the
manifest, fresh → approval stales it → cleared manifest reads unknown;
plus 3 unit pins on the pure laws and the wiring). **Stage 7 landed as
S118 — the track is COMPLETE**: the §8.1 dead route closed (POST
/storyboard/upload answers the components' multipart contract through
replaceSceneImage, with S113's scene-scoped invalidation, provenance
registration, the §8.2 audit row, and the S79 preference-gated targeted
re-check — an upload IS a repaint); the §8.2 audit law closed (PATCH
/scenes and PUT /assemble leave Activity rows naming their revisions);
the VCE emitter rewire (both engine write sites persist their proposals
as SceneRepair rows — origin "vce", estimate + affected assets attached,
dedup-guarded so re-running the engine never spams the inbox, lazily
imported to break the module cycle); the operator surface (the Scene
Trust Panel in the Scene Studio: revisions with restore, the recheck
verdict + approval with the blocker reasons shown, the repair inbox with
estimates, the seam render buttons; the board's per-video cost + ceiling
column — the "no per-video attribution" note retired); the e2e contract
spec (e2e/scene-editing.spec.ts — auth gates, format guards, the
sceneless refusals) and the operator runbook
(docs/runbooks/scene-editing.md, with the twelve-scenario → pin mapping).
Battery now 29/29 (the VCE persistence ladder: estimates attached, born
proposed, dedup guard, changed-instruction-is-new) + 2 unit source pins.
The track rode the existing queue, storage, budget, and QC systems end
to end: no second timeline engine, no separate job queue, no parallel
budget system, no separate publishing pipeline — exactly the
reconciliation's §11 law.

## P0.1 spec — what the gate asserts

`scripts/test-clean-clone.mts` (local: `npm run verify:clone`; CI: the
`clean-clone` job in `.github/workflows/ci.yml`):

1. Fresh `git clone --depth 1` of the committed HEAD into a clean temp dir.
2. **Forbidden-state law** — `node_modules`, `.env`, `.next`, `coverage`,
   `next-env.d.ts`, `test-results`, `playwright-report`, `.vercel` are NOT
   tracked; `db/` carries only `.gitkeep`.
3. **Boot proof** — `npm ci` with NO injected `DATABASE_URL`; postinstall must
   select SQLite by URL protocol, create `.env`
   (`DATABASE_URL=file:../db/custom.db`), provision
   `TUBEFORGE_AUTH_SECRET` + `TUBEFORGE_ENCRYPTION_KEY`, create
   `next-env.d.ts`, generate the client, `db push` the SQLite database, and
   run the stage-2 migration.
4. **Boot probe** — the generated client queries the pushed Stage-2 schema
   (`organization.count()` succeeds against `db/custom.db`).
5. **Determinism law** — regenerating the SQLite client yields a
   byte-identical sha256 manifest of `node_modules/.prisma/client`; the
   POSTGRES client generates cleanly in the same clone and regenerates
   byte-identically; the two dialect manifests DIFFER (a silent provider swap
   cannot pass).
6. **Hygiene law** — install + generation mutate no tracked file
   (`git status --porcelain` stays empty inside the clone).

Unit pins (suite): the committed SQLite mirror is byte-identical to what
`scripts/sync-sqlite-schema.mjs` derives from `schema.prisma`; the migration
chain is Postgres-owned (`migration_lock.toml`) and every migration carries
SQL; `.gitignore` buries every runtime artifact; the postinstall dialect
selection and the verifier's own contract are pinned.

## P0.6 target topology (the acceptance test, for the record)

```
TubeForge Web (Next.js · authentication · API)
        │
PostgreSQL (Prisma migrations + data)     queue worker (jobs + recovery)
        │                                          │
        └──────────── object storage (MinIO / S3-compatible)
                          with FFmpeg + Chromium doing the real rendering
```

Acceptance: register → create project → generate assets → enqueue job →
render MP4 → store artifact → retrieve artifact → restart worker → verify
recovery.

## Evidence ledger

| Stage | Commit | CI evidence                          | Receipt        |
| ----- | ------ | ------------------------------------ | -------------- |
| P0.1  | S99    | push-gate run recorded in worklog.md | worklog.md §S99 |
| P0.2  | S100   | CI run 43282465637 (success)         | worklog.md §S100 |
| P0.3  | S101   | push-gate run recorded in worklog.md | worklog.md §S101 |
| P0.4  | S102   | push-gate run recorded in worklog.md | worklog.md §S102 |
| P0.5  | S104   | push-gate run recorded in worklog.md | worklog.md §S104 |
| P0.6  | S105    | the full production topology walks the acceptance sequence in CI (run 43305937761, HEAD `27ef67b`) — the gate caught THREE real findings: the compose wedged on a clean Postgres (the S60 fingerprint, fixed by booting migrate-stage2's self-heal), MinIO's Docker Hub org is PURGED (topology re-based on an S3-compatible store, Hub-free image sourcing via ECR Public), and the standalone bundle missed the Prisma query engine (outputFileTracingIncludes) | worklog.md §S105 |
| P1.1  | S103   | the restore drill is MEASURED (RTO printed per run) and the alert probe prints actionable ALERT lines (8 checks) | worklog.md §S103 |
| P1.2  | S106   | 20 lint warnings → 0 (fixed at site, none suppressed); storage.ts decomposed into storage-s3.ts + storage-quota.ts + facade; S101 source pins caught a reversion of the admission law mid-refactor | worklog.md §S106 |
| P0.6 (extension) | S108 | the topology smoke closes DEPLOYMENT §5.1's last unverified tail — a real whiteboard render IN-CONTAINER rides the walk on every main push; FIRST run green (CI run 43339795242 at `0afbabb`, all 8 jobs): worker chromium launch → 96 frames → encode in ~11s, final.mp4 155,656 bytes through the s3 driver, ffprobe exactly 4s, the video row updated | worklog.md §S108 |
| P2 opening | S109 | the operator's explicit call (2026-11-13) against the fully-gated baseline at HEAD `8e76c6b` — the fresh review re-validated every gate on a clean checkout (npm ci, typecheck, lint, unit, billing, storage, rate, backup drill ~57 ms RTO, alert probe HEALTH 0, the CI-covered Docker smoke) and upgraded the assessment to "technically strong, approaching paid-beta readiness"; the entry queue above is the review's own ordering | worklog.md §S109 |
| P2 queue item 2 | S110 | the staging kit: DEPLOYMENT §3 made executable — the provisioner (one command, fresh secrets every run, --dry-run verified), the HTTP drill harness (health/billing/pipeline suites, self-skipping when prerequisites are missing; proven live against a dev server: 2 PASS · 1 SKIP · 0 FAIL, the pipeline suite walking scenes → native scaffold → render job → final.mp4 4.29 MB through the authed route), the orchestrator (harness + k6 + the printed operator-step sequences), the runbook with the RC gate (§7). Provisioning itself awaits the operator's accounts | worklog.md §S110 |
| Feature track Stage 0 | S111 | the read-only repository reconciliation of the operator's scene-level editing architecture (docs/design/scene-level-editing-reconciliation.md): capability map, the five requirements vs reality, three architectural surprises, two live defects found, the file-by-file Stage 1–7 plan | worklog.md §S111 |
| Feature track Stage 7 (COMPLETE) | S118 | the track closes: the §8.1 dead upload route (multipart → replaceSceneImage → scene-scoped invalidation + provenance + audit + the S79 targeted re-check), the §8.2 audit rows on PATCH /scenes + PUT /assemble, the VCE→SceneRepair persistence (dedup-guarded, cycle-broken), the Scene Trust Panel (revisions/recheck/approval/repairs/seams in the Scene Studio), the board's per-video cost + ceiling column, the e2e contract spec, and the operator runbook with the twelve-scenario → pin mapping | worklog.md §S118 |
| Feature track Stage 6 | S117 | final assembly from approved revisions + the render manifest: the full render consumes the latest APPROVED revision per scene (drafts never leak; nothing approved → the v1 baseline; no history → the row; the union slice restored at the current position), Video.renderManifest records the assembled revision set, renderStaleness compares it live (newer draft / new approval / scene-list change ⇒ stale with reasons; history + no manifest ⇒ unknown), and both ship gates (publish + export) refuse a stale or unprovable final with no override — staleness is a fact, not a judgment | worklog.md §S117 |
| Feature track Stage 5 | S116 | scene QC + boundary validation + the approval gate: the scene-scoped recheck (the whole-file battery's probes reused through exported builders — playable/black/frozen/aspect/loudness family/dead-air/static/flicker/stutter/duration via the shared fold/scene-sliced captions/S49 at scene scope), the boundary-pair render lane ({boundaryAfter} → scene-boundary-NN.mp4 through the doc's durations + seam transition) with alignSeam (cut must appear, blend need not, neighborhood strays fail), the verdict stored on the head revision (annotation; content byte-identical), and approval gated on a passing verdict for the head's own version (pure approvalBlocker; idempotent; approved survives drafts) | worklog.md §S116 |
| Feature track Stage 4 | S115 | repair + cost authorization + idempotency: the propose→approve→reject ladder (estimate + affected assets stored before any spend; approving twice cannot spend twice), SceneRepair (the durable critic/VCE proposal form), Job.idempotencyKey (unique; done rows never re-enqueued — the double-bill killer, pinned; failed rows re-queue conditionally per the fencing law), the opt-in per-project spend ceiling enforced beside the credit hold (cost-guard.ts, 402 with the numbers), the render route gated + keyed | worklog.md §S115 |
| Feature track Stage 3 | S114 | the scene preview lane: render {sceneIndex} → scene-preview-NN.mp4 through the same segment machinery (mutually exclusive with sceneLimit; the render job branches to its own orchestrator — no finalize, no QC, no flags), preview artifacts registered with built-from revision + the stale law (current/stale/unknown), GET /scenes/[n]/artifacts + the mp4 route's scene-preview variant; the preview pin is a real end-to-end ffmpeg render asserting nothing else moves | worklog.md §S114 |
| Feature track Stage 2 | S113 | the dependency map + artifact provenance: scene-deps.ts (the declarative table, unit-pinned; PATCH /scenes + rollbackScene both sweep through it — the private regex copies are gone), SceneArtifact (prompt persisted, input hash, revision linkage, cost accumulated through the UsageRecord bridge), registration at the image/TTS/i2v/whiteboard sites, and the §8.3 over-invalidation fix measured by pin (one-scene art change: scenes 1+3's clips survive, scene 2's + the renders die); verified by the 18-test battery + 5 new unit pins + the full chain + build | worklog.md §S113 |
| Feature track Stage 1 | S112 | the revision foundation: SceneRevision (append-only, unique (videoId, sceneId, version)), stable Scene.id, the union-slice snapshot, expectedSceneVersion optimistic concurrency (409 + current head), first-touch backfill, rollback-as-new-revision, approved-never-superseded, all eleven mutators converged through commitSceneChanges (source-pinned), GET /scenes/[n]/revisions + POST /scenes/[n]/rollback; verified by the new 12-test DB battery + 8 unit pins + the full check chain + production build. Two real bugs the new battery caught and fixed at the site: parseScenes dropped the minted id on read; the diff counted minted ids as content changes | worklog.md §S112 |
