# TubeForge — Master Plan

> **Where this document stands (2026-11-14).** This is the ORIGINAL November
> 2026 programme, preserved as the historical record of how the build was
> scoped — it does NOT track current reality. The living status is
> [`worklog.md`](worklog.md) (every stage's final gate, in order) plus the
> S-series index in [`TASKS.md`](TASKS.md). The short version of where the
> code actually is: Stages 1–7 of this plan are closed at the code level;
> the production-readiness arc (S99–S108) closed every reliability gate with
> CI evidence (clean-clone bootstrap, queue leases + fencing, atomic storage
> admission, shared rate limiting, nonce CSP, the Docker production smoke,
> measured restore drills); scene-level editing & repair (S111–S118) is
> complete; and the 2D-animation programme
> ([`docs/design/s120-2d-animation-roadmap.md`](docs/design/s120-2d-animation-roadmap.md))
> is in progress — W1–W7 are LANDED (the spoken-window schedule, the
> glyph-outline text mode, the captions-lane voice anchors, the Stage-S
> animation substrate, the camera director, the continuous canvas, and the
> finishing layer: the hand family/travel/poses + the optional whiteboard
> SFX), closing the whiteboard finishing track; the blind re-scores and the
> G1 motion-graphics engine are the roadmap's next gates. CI runs eight gates
> on every push to `main` and is green (597-test unit battery).

**Original status (2026-11-01):** Stage 1 audit complete. Stage 1
implementation in progress.

---

## 1. The destination

TubeForge should ultimately be six connected systems that feel like one coherent product, not six unrelated tools:

1. **Intelligence Studio** — research, ideas, scripts and storytelling.
2. **AI Director** — creative direction, shot planning and scene consistency.
3. **Production Studio** — images, video, voices, music and sound effects.
4. **Editing Studio** — timeline, scene editing, captions and transitions.
5. **Rendering Engine** — professional exports, quality assurance and recovery.
6. **Creator Intelligence** — publishing, analytics and continuous improvement.

The final objective: a user should be able to enter one idea into TubeForge and receive a professionally directed, edited, narrated, quality-checked and publish-ready video with minimal manual work.

---

## 2. Current state (post-audit)

The audit (`FOUNDATION_AUDIT.md`) confirmed TubeForge is a working single-user AI video production studio. The pipeline is real and well-instrumented per stage: jobbed routes, persistent `Job` rows with restart-recovery, a retry/budget layer for AI calls, a 12-check QC battery, and render-time shot/motion planners. The application can already take an idea through script, storyboard, voiceover, render, QC and export.

The audit identified four blocking seams that must be addressed before TubeForge can be a multi-user SaaS product:

1. **Single-tenant schema.** Every Prisma model lacks `userId`/`tenantId`. The `Setting` table is a singleton per key — one owner password, one YouTube OAuth grant, one set of provider keys per install. Every one of the 110 endpoints assumes one user.
2. **Synchronous-in-request heavy work.** Single-video script generation (`POST /api/videos`), research, greenlight and character bible all block the HTTP request through multi-minute LLM calls. The worker body that would fix this (`script-job.ts`) exists but is dead code.
3. **Local filesystem as the artifact store.** ~30 endpoints write to `process.cwd()/uploads/<videoId>/…`. The `db/auth.lock` flag file and the Linux-only `/proc/<pid>/stat` zombie watchdog will not survive a serverless deployment.
4. **YouTube publishing is dead scaffolding.** `uploadToYouTube` is implemented but never called. `Video.youtubeUrl` is never written. The plan's "Export/Publish" stage does not exist in code.

Beyond these, the "AI Director" stage from the target pipeline is only present as heuristic render-time planners — there is no LLM-driven shot-list / camera / lens / coverage pass. Stage 5 of the roadmap will need to build this from scratch.

---

## 3. The complete development roadmap

A 28-week development programme (planning estimate for a small focused 2–3 person team; solo developers should expect ~40–52 weeks; the audit suggests the realistic bottom of that range is ~38 weeks because of the multi-tenant migration depth). See `ROADMAP.md` for full per-stage detail.

Seven development stages, from existing codebase to commercial launch:

| # | Stage | Weeks | Audit-informed adjustment |
| --- | --- | --- | --- |
| 1 | Baseline & security | 1–2 | 2 wks ✓ — most of Stage 1 is the audit itself; remaining work is cleanup, build stabilization, missing-script restoration |
| 2 | Multi-user SaaS architecture | 3–6 | 5 wks (was 4) — `Setting` table singleton surgery is deeper than the plan estimated |
| 3 | Production infrastructure | 7–11 | 5 wks (was 4) — add provider abstraction layer for AI provider churn resilience |
| 4 | Premium user experience | 12–15 | Split: 4a core 5 surfaces (3 wks) + 4b remaining 5 surfaces (3 wks, parallel with 5) |
| 5 | AI Director & film quality | 16–21 | 7 wks (was 5) — character continuity is the hardest part; build from scratch |
| 6 | Editing, rendering & publishing | 22–27 | 6 wks (was 5) — wire the dead `uploadToYouTube` scaffolding + build the missing Scene Assembly stage |
| 7 | Testing, launch & optimization | 28–32 | 5 wks (was 4) — add automated cross-tenant isolation tests to CI |

**Order matters.** Security and reliability must be established before investing in the premium experience.

---

## 4. Features that must exist before launch

The minimum premium product requirements:

| Feature | Launch requirement | Audit status |
| --- | --- | --- |
| User accounts | Registration, login, recovery | ✗ — single owner password today (D-29) |
| Project management | Save, duplicate, archive, delete | Partial — single-tenant, no per-user scoping |
| AI scriptwriting | Research and script generation | ✓ pipeline works, ✗ synchronous in-request (D-01) |
| AI Director | Automated storyboard and shot planning | ✗ — heuristic only; no LLM director pass |
| Character studio | Consistent character references | Partial — `Character` + `identityAnchor` + portrait/poses exist; no cross-scene continuity check |
| Voice studio | Multiple voices and pronunciation controls | ✓ — 4 TTS providers + voice cloning |
| Scene generation | Generate and regenerate individual scenes | ✓ — jobbed |
| Editing studio | Timeline and scene-level editing | ✗ — no separate scene assembly stage; rolled into render |
| Rendering | Reliable high-quality exports | ✓ — FFmpeg + QC battery (12 checks) |
| Captions | Editable and synchronized subtitles | ✓ — smart SRT |
| Audio | Voice, music and SFX mixing | ✓ — audiomix.ts + sfx.ts + music.ts |
| Thumbnail studio | Generate and compare alternatives | ✓ — 3-variant generation |
| YouTube | Account connection and publishing | ✗ — OAuth works but `uploadToYouTube` is dead code (D-06, D-07) |
| Analytics | Performance and content insights | Partial — `VideoStat` sync exists; no learning loop |
| Billing | Subscriptions and usage credits | ✗ — not implemented |
| Administration | Customer, usage and system management | ✗ — not implemented |

---

## 5. Pricing and subscriptions (planned)

Start with three plans, then adjust them using actual generation costs.

- **Starter** — individuals exploring AI video production. Limited monthly credits, standard generation, 1080p exports, basic templates.
- **Creator** (recommended) — regular YouTube creators. Higher monthly credits, advanced AI Director, character consistency, premium voices, advanced editing, priority rendering.
- **Studio** — production teams and agencies. Multiple team members, shared projects, higher generation limits, advanced export options, team management, priority support.

Do not set final prices until we know the real cost per generated minute, including AI providers, storage, rendering and bandwidth.

---

## 6. The target architecture

TubeForge Premium Interface (Dashboard · Studio · Projects · Analytics · Admin)
↓
Application & API Layer (Authentication · Permissions · Projects · Billing · Provider integrations)
↓
PostgreSQL (Users, projects, jobs, usage) + Redis / Queue (Jobs, retries, progress)
↓
Independent production workers: AI Director · Voice Worker · Scene Worker · Render Worker · Quality Control · Publishing
↓
Object Storage + CDN (Images · Audio · Video · Thumbnails · Exports)

This separation is essential because generating a video should not depend on keeping a user's browser open or a web server alive. The audit confirmed the current architecture violates this rule: jobs are in-process, files are local, and a server restart kills in-flight work.

See `ARCHITECTURE.md` for the current-vs-target gap analysis.

---

## 7. The production pipeline (target)

```
User enters an idea
  → Research and scriptwriting
  → Script approval
  → AI Director (shot-list, camera, lens, coverage plan)
  → Storyboard and character bible
  → Scene asset generation
  → Voice and sound production
  → Scene assembly and editing (preview before commit)
  → Rendering
  → Automated quality checks
  → Passes QC?
       No  → Fix or regenerate affected assets (only the failed scene)
       Yes → User review
  → Export or publish
  → Analytics and learning
  → Improve future productions
```

**One architectural rule is essential:** each stage must save its outputs independently. If scene 14 fails, TubeForge should not regenerate scenes 1–13.

The audit confirmed the current code does save outputs independently at the per-scene level (scene PNGs, scene WAVs are per-scene files). It does NOT save outputs independently at the stage level: scene assembly + transition stitching + music + captions + loudnorm are all rolled into the monolithic `renderVideo` orchestrator. Stage 6 introduces a separate scene-assembly stage where the user can reorder scenes, trim timing, or substitute assets before the final render commits.

---

## 8. How we will measure success

Targets for launch:

| Metric | Target |
| --- | --- |
| Successful core production jobs | At least 98% |
| Cross-tenant data leakage | 0 |
| Recoverable job interruption | 100% recovery of eligible jobs |
| Production build | 100% reproducible |
| Critical security issues | 0 open |
| First successful project | Within 15 minutes |
| Scene regeneration | Without losing approved scenes |
| Export quality checks | 100% of exports checked |
| Billing reconciliation | Exact credit accounting |
| Mobile responsiveness | All core workflows usable |

We will measure these against real beta usage, not just assume they have been achieved. The audit baseline: today's `__tfAuthLimit` and `__tfRateBuckets` reset on restart (D-20, D-21), which means the "Cross-tenant data leakage = 0" and "Critical security issues = 0" gates will require Redis-backed session/rate state before launch.

---

## 9. Project management and delivery rules

These documents live in this repository and are kept in sync with the code:

| Document | Purpose |
| --- | --- |
| `MASTER_PLAN.md` | This file — overall product direction |
| `ARCHITECTURE.md` | System architecture (current vs. target) |
| `ROADMAP.md` | Development milestones |
| `TASKS.md` | Individual development tasks (Stage 1 backlog) |
| `SECURITY.md` | Security requirements (existing) + audit findings (new section) |
| `FOUNDATION_AUDIT.md` | The Stage 1 audit (this sprint's deliverable) |
| `RISK_REGISTER.md` | Technical debt and risk register |
| `TESTING.md` | Testing strategy (to be added in Stage 1 task work) |
| `CHANGELOG.md` | Release history (to be added) |
| `DEPLOYMENT.md` | Deployment instructions (to be added in Stage 3) |

Every development task must have:

- A clear objective.
- Files or modules affected.
- Dependencies.
- Acceptance criteria.
- Automated tests.
- A rollback strategy for risky changes.

No stage is marked complete merely because the code has been written.

---

## 10. The ultimate release gate

A new user can:

1. Register,
2. Create a project,
3. Generate a complete cinematic video,
4. Edit individual scenes,
5. Export it,
6. Manage their subscription securely.

That is when TubeForge Premium is ready for launch.

The next step is to execute the Stage 1 task backlog in `TASKS.md`.
