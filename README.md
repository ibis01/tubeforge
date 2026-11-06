# TubeForge

TubeForge is an AI video production studio for YouTube creators. One idea goes
in; a finished video comes out: it researches the topic, writes the script,
plans the shots with an AI Director, paints the scene art, records the
voiceover (stock, cloned, or self-hosted voices), lays the music and sound,
lets you edit the timeline, renders the MP4, runs a 12-check QC battery, and
publishes to a connected YouTube channel — all inside a multi-user web
application with metered AI spending and Stripe billing underneath.

**Status:** studio stage S46 (2026-11-06) — the production loop is
feature-complete and the foundation proofs are in: cross-tenant
isolation, a durable DB-backed queue, DB-backed login lockout (S46) and
shared multi-instance spend admission (S47). The remaining distance to a
paid launch is operational, tracked in the S47 “Production Integrity and
Acceptance” ledger in [`TASKS.md`](TASKS.md).

## What's inside

- **The studio** — research → script → storyboard → scene art → voice → mix →
  timeline editing (drag-and-drop, trims, undo) → render (aspect ratio, frame
  rate, grade, caption style, camera motion, per-boundary transitions) → QC →
  export → YouTube publish, with a World library for recurring characters,
  locations, and props.
- **Multi-user SaaS foundation** — per-user accounts with encrypted provider
  credentials, cross-tenant isolation (pinned by Playwright and per-stage route
  probes), 90-day API tokens, email verification, password recovery, GDPR
  export/delete.
- **The money** — Stripe checkout + customer portal, signature-verified
  webhooks (fail-closed), a transactional microCredit ledger with
  crash-durable reservations, versioned pricing, and a hard spend ceiling.
- **The evidence discipline** — every stage S1→S46 shipped with a unit probe
  and/or route-e2e script under `scripts/` so its claims can be re-verified
  mechanically. See the S-series index in [`TASKS.md`](TASKS.md).

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

CI (`.github/workflows/ci.yml`): every push and PR runs a gitleaks secret
scan, typecheck, lint, and the unit suite; pushes to main and PRs also run the
full Playwright e2e job.

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
| [`ROADMAP.md`](ROADMAP.md) / [`MASTER_PLAN.md`](MASTER_PLAN.md) | the original development programme (Stages 1–7, all closed at the code level) |
| [`TASKS.md`](TASKS.md) | task ledgers per stage **+ the S-series index (S1→S46) and the S47 integrity ledger** |
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

Not yet chosen — a tracked launch decision (S33+ backlog, P0). Until a
`LICENSE` file lands, all rights are reserved.
