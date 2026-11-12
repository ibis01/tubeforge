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
| P0.6  | Docker production smoke                    | The full production topology renders successfully end-to-end (see the target topology below)                                                                  | **S105** — `docker-smoke.sh` walks postgres+MinIO+web+worker: HTTP register→create, ffmpeg render, MinIO round-trip, cross-process job, worker-restart recovery (CI job on main pushes) |
| P1.1  | Monitoring + restore drills                | Measured recovery time and actionable alerts                                                                                                                  | **S103** — measured restore drill (CI, RTO printed) + `alert:probe` (8 actionable checks) + runbook §4.1 |
| P1.2  | Module decomposition                       | Reduced complexity and zero avoidable warnings                                                                                                                 | **S106** — 20 warnings fixed at the site (eslint 0/0); storage.ts (768 lines) split into facade + `storage-s3.ts` + `storage-quota.ts` with re-exports |
| P2    | Feature expansion                          | Remains frozen until the gates above close                                                                                                                     | **GATES CLOSED (S106)** — the freeze lifts on the operator's explicit call; until then P0 discipline stays in force |

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
| P0.6  | S105   | CI run 43305937761 (success — the full acceptance walk) | worklog.md §S105 + the fix chain in git log |
| P1.1  | S103   | push-gate run recorded in worklog.md | worklog.md §S103 |
| P1.2  | S106   | push-gate run recorded in worklog.md | worklog.md §S106 |
