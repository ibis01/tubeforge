# TubeForge

TubeForge is an AI video production studio for YouTube creators. One idea goes
in; a finished video comes out: it researches the topic, writes the script,
plans the shots with an AI Director, paints the scene art, records the
voiceover (stock, cloned, or self-hosted voices), lays the music and sound,
lets you edit the timeline, renders the MP4, runs a 16-check QC battery (15
standard + the content-policy visual scan under a restricted policy), and
publishes to a connected YouTube channel — all inside a multi-user web
application with metered AI spending and Stripe billing underneath.

**Status:** S-series stage S120 + the W-track at W5 (2026-11-14); CI is 8/8
green on `main` with the 572-test unit battery. The production loop is
feature-complete, and the production-readiness arc (S99–S108) closed every
reliability gate with CI evidence — clean-clone bootstrap, queue leases +
fencing, atomic storage admission, shared rate limiting + trusted-proxy IP law,
nonce CSP, the Docker production-topology smoke (in-container whiteboard render
included), measured restore drills, and zero avoidable warnings. **P2 opened on
the operator's call (2026-11-13)**, and its first feature track — scene-level
editing & repair — is COMPLETE (S111 reconciliation → S112 revision foundation
→ S113 dependency map + provenance → S114 scene previews → S115 repair + cost
authorization → S116 scene QC + approval → S117 approved-only assembly → S118
UX + hardening; runbook: docs/runbooks/scene-editing.md). S119 restored the
explicit-whiteboard click's lane contract, and S120 opened the complete
2D-animation programme
([`docs/design/s120-2d-animation-roadmap.md`](docs/design/s120-2d-animation-roadmap.md)):
the VideoScribe-like W-track has landed W1 (the perceptual baseline benchmark),
W2 (the semantic beat compiler — strokes land on the sentences that introduce
them), W3 (the stroke-authored asset validator; 26 validated assets), W4 slice 1
(word anchors ride the spoken clock), Stage S (the shared animation substrate
the coming engines consume), and W5 (the content-driven camera director); W4
slices 2–3 (glyph-outline text mode, ASR captions wiring), W6 (continuous
canvas) and W7 (the finishing layer) remain. The entry queue remains staging provisioning → launch drills →
release candidate (see
[`docs/production-readiness.md`](docs/production-readiness.md)). On top of the
studio, the **Whiteboard Engine** (the native, $0-per-render creative mode —
E0–E9 landed) and the **Creator Intelligence Engine** (hook scoring, packaging
lint, transcript-based Shorts selection, retention ingestion — CI-1..CI-4
landed) are in the tree.

## What's inside

- **The studio** — research → script → storyboard → scene art → voice → mix →
  timeline editing (drag-and-drop, trims, undo) → render (aspect ratio, frame
  rate, grade, caption style, camera motion, per-boundary transitions) → QC →
  export → YouTube publish, with a World library for recurring characters,
  locations, and props.
- **The Whiteboard Engine** — a second, fully native render mode: an SVG
  hand-drawing engine (drawing, hand, camera phases) whose storyboard comes
  from a native keyword planner, or an LLM planner that degrades per-scene to
  the native one through the same budget choke point, and whose pixels cost
  $0 — local Chromium + ffmpeg, no generation API. Its choreography is
  semantic since W2 (strokes land on the sentences that introduce them, ride
  the spoken clock when word anchors exist) and content-framed since W5 (the
  camera director keys each beat; the calibrated drift stays as the motion
  floor). It renders to the standard
  `final.mp4`, through the unchanged QC battery and ship gate. See
  [`WHITEBOARD_ENGINE_DESIGN.md`](WHITEBOARD_ENGINE_DESIGN.md).
- **Creator Intelligence** — hook/script scoring, title+thumbnail pairing
  lint, transcript-based Shorts moment selection (upgrading the deterministic
  picker behind the same seam), and retention ingestion mapped to scenes —
  every module native, typed, proposes-never-auto-edits, and every score
  labeled a heuristic. See
  [`docs/audits/creator-intelligence-record.md`](docs/audits/creator-intelligence-record.md).
- **Multi-user SaaS foundation** — per-user accounts with encrypted provider
  credentials, cross-tenant isolation (pinned by Playwright and per-stage route
  probes), 90-day API tokens, email verification, password recovery, GDPR
  export/delete.
- **The money** — Stripe checkout + customer portal, signature-verified
  webhooks (fail-closed), a transactional microCredit ledger with
  crash-durable reservations, versioned pricing, and a hard spend ceiling.
- **The evidence discipline** — every stage ships with mechanical evidence
  re-runnable from `scripts/` (unit probes, route-e2e scripts and, for the
  animation track, the W1 frame-hash harness and the QC batteries) so its
  claims can be re-verified mechanically. The S-series index in
  [`TASKS.md`](TASKS.md) covers S1→S65; the living receipt trail through
  S120 and the W-track is [`worklog.md`](worklog.md).

## Quickstart (local, SQLite)

Prerequisites: **Node.js 20+**, **ffmpeg + ffprobe** on PATH, and a **Z.ai API
key** (the free GLM-4.5 Flash tier covers script writing). About 2 GB of disk.

```bash
npm ci              # postinstall auto-detects SQLite, generates the Prisma
                    # client, creates db/custom.db, provisions dev secrets,
                    # and writes next-env.d.ts (gitignored) so typecheck
                    # works on a fresh clone
npm run dev         # → http://localhost:3000
```

Open **Settings → AI Providers**, paste your Z.ai key, and hit **Test** — one
key powers every Z.ai task, and providers are mixable per task (Z.ai, any
OpenAI-compatible endpoint, Anthropic, Gemini). Create your first video from
the **Create** page; Auto-Pilot walks the whole pipeline.

For the full walkthrough — Postgres mode, LAN access, the account model,
voice-server setup — see [`SETUP.md`](SETUP.md).

## Tests

| Command | What it proves |
| --- | --- |
| `npm run check` | typecheck + lint + the unit/regression suite + the billing integration suite (against the local SQLite DB) |
| `npm run test:e2e` | 5 Playwright suites (boots its own dev server): smoke, cross-tenant isolation, mobile sweep, premium UX, full production pipeline |
| `npm run test:queue` | the queue contract + worker-restart recovery: interrupted jobs resume, unknown kinds never pollute video rows |
| `npm run backup` | SQLite backup + restore roundtrip against the live DB |

CI (`.github/workflows/ci.yml`): every push and PR runs eight jobs — secret
scan (gitleaks), typecheck·lint·unit (with the queue, billing, storage,
rate-limiter, restore-drill, and alert batteries), production build,
money-path coverage, PostgreSQL integration (migrations + wedge recovery),
clean-clone bootstrap (P0.1), the Docker production-topology smoke (P0.6),
and the full Playwright e2e suite. The ffmpeg-install step carries the
boot-time dpkg-lock wait + retry pattern (landed after five documented
runner stalls — see the worklog's CI-flake receipts).

## Repository tour

| Path | What lives there |
| --- | --- |
| `src/app/api/` | the HTTP surface — 100+ route handlers (videos, jobs, billing, auth, YouTube, voices, world, analytics) |
| `src/lib/tubeforge/` | the pipeline modules — render, motion, captions, billing, queue, providers, storage, QC, director, timeline |
| `src/components/tubeforge/` | the studio UI — editing studio, scene editor, views, command palette |
| `prisma/` | the Postgres schema + migration chain, and the SQLite mirror used for local dev |
| `scripts/` | ops scripts (backup, worker, seeds) + the per-stage evidence probes (`sN-unit-probe.mts` / `sN-route-e2e.mjs`) |
| `e2e/` | the Playwright suites |
| `voice-server/` | the self-hosted Chatterbox Turbo voice-cloning server (optional; the app also speaks 4 hosted TTS providers) |
| `docs/` | audits, specs, and runbooks |

## Documentation

| Document | Purpose |
| --- | --- |
| [`SETUP.md`](SETUP.md) | run it on your own machine — accounts, providers, both database modes |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | system architecture, current vs. target |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | the one deployment topology (Fly + Neon + R2), staging spec, release checklist |
| [`SECURITY.md`](SECURITY.md) | security requirements + audit findings |
| [`ROADMAP.md`](ROADMAP.md) / [`MASTER_PLAN.md`](MASTER_PLAN.md) | the original development programme (Stages 1–7, all closed at the code level) + the Post-Stage-7 2.0 tracks (Whiteboard, Creator Intelligence, the shared quality systems) |
| [`WHITEBOARD_ENGINE_DESIGN.md`](WHITEBOARD_ENGINE_DESIGN.md) | the Whiteboard Engine's laws, budgets, and the E0–E12 milestone matrix |
| [`TASKS.md`](TASKS.md) | task ledgers per stage **+ the S-series drift-closure index (S1→S65) and the S47 integrity ledger** — the living trail through S120 and the W-track is `worklog.md` |
| [`RISK_REGISTER.md`](RISK_REGISTER.md) | technical debt and risk register |
| `worklog.md` | the audit-trail worklog — every stage's final gate, in order |

## Deployment

One topology, decided (see [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full spec):
**Fly.io** runs the web and worker process groups from one image;
**Neon Postgres** is the database (`prisma migrate deploy`); an **S3-compatible
store (Cloudflare R2)** holds media — the presigned-URL delivery path is
already built and tested. A staging environment (Fly + Neon branch + Stripe
test mode) is the target for the launch drills: backup restore, load testing,
the YouTube test-channel smoke, and the Stripe lifecycle rehearsal.


## License

TubeForge is proprietary software.

Copyright (c) 2026 Ismail Ibrahim.
All rights reserved.

No permission is granted to reproduce, distribute,
modify, or commercially exploit this software without
written authorization from the copyright holder.

For licensing enquiries, contact the copyright holder.
