# S56 — Production Reliability Record (T-56.7, closed 2026-11-08 UTC)

Stage: **S56 — release engineering: the CI that builds, bills, and measures**
(owner-approved 2026-11-08; the S33+ backlog's Priority 1, closed in-repo).

## The CI evidence (full-SHA REST verification — the §6 lesson held)

Every S56 commit on main, its run, and its outcome:

| Commit | Run | Outcome |
| --- | --- | --- |
| `a4efe16` (T-56.1+T-56.2 — build job + billing in CI) | 42447728691 | ✅ 5/5 jobs green |
| `563fbc6` (T-56.3 — dependabot.yml) | — | pushed together with `98412e9`; its tree is CI-covered by that run (multi-commit push = one run, at the head) |
| `98412e9` (T-56.4 — coverage baseline) | 42448124123 | ✅ green (the Dependabot "Update" run name is cosmetic — the CI workflow ran; the coverage job's first failure taught the c8 flag, see below) |
| `a0aea54` (T-56.5 — nightly battery) | 42461224577 | ⚠️ 4/5 — coverage job red (the c8 temp-dir flag) |
| `9490a84` (T-56.6 — warning tranche) | 42462475150 | ⚠️ 4/5 — same c8 flag (fix was in flight) |
| `ddf0f4d` (T-56.4 correction) | queued→superseded | the fix's proof rode `4cb46fe`'s run (same tree + the flag fix) |
| `4cb46fe` (minimatch alert fix) | 42462954735 | ✅ 5/5 jobs green — **the coverage job's first green CI run** |
| `a90017b` (battery diagnostics) | — | diagnostics-only; nightly re-dispatched for the evidence |
| `3405bd6` (nightly DB fix) | — | the nightly run below is its proof |
| `5c5e9d1` (nightly curation) | nightly 42465915313 | ✅ battery 17/17 + e2e green |

## The nightly battery — proven on CI, end to end

- **Run 42462735659** (first, `ddf0f4d`): 6/19 — the split-brain database.
  With the postinstall `.env`'s RELATIVE `file:../db/custom.db`, the
  standalone server (chdir'd to `.next/standalone`, reading the `.env` the
  build copies there) and the probe processes (repo-root cwd, their own
  Prisma client) resolved the path against DIFFERENT bases: the server
  wrote one SQLite file while the probes read another. Registers succeeded;
  every org-resolution read failed. Reproduced in-sandbox under CI parity
  before the fix.
- **Run 42463660807** (`a90017b`): same failure, now with the probes' own
  check lines surfaced (the diagnostics upgrade did its job).
- **Run 42464543806** (`3405bd6`, the fix — job-level ABSOLUTE
  `DATABASE_URL: file:${{ github.workspace }}/db/custom.db` + per-run
  secrets via `GITHUB_ENV`): **17/19**. The two reds (s8, s11) failed ONLY
  their real-synthesis checks — the default TTS provider is zai (the
  platform-bundled SDK), present in the sandbox, absent on a bare runner.
  Curated to the on-demand list with the reason recorded; both verified
  green in-sandbox via the gateway this stage.
- **The closing run (`5c5e9d1`): 42465915313 — GREEN.** Battery 17/17
  ("leg=all: 17/17 probes passed"), e2e success alongside. The nightly
  battery is proven end to end on CI.

## The coverage job — its failure was the process working

The first CI coverage runs (a0aea54, 9490a84) failed on `ENOENT
coverage/tmp`: the harness passed `--tmp-directory`, which is not a c8 flag
(the real one is `--temp-directory`); the local run had silently
under-collected (53.63% published) while CI failed outright. Fixed
(`ddf0f4d`), re-measured honestly — **56.30%** (4541/8065) — floor 50
unchanged, and the baseline doc carries the correction story. First green
coverage job: run 42462954735 (`4cb46fe`).

## Dependabot — both halves live

- Security alerts + security updates: ON since S33; **0 open at close**
  (one alert — minimatch GHSA-g3hv-75wg-m249, medium, dev scope via my
  c8's transitive dep — closed at the source by an npm override to
  ^11.0.1, `4cb46fe`, coverage harness re-verified on the override).
- Weekly version bumps (T-56.3's `.github/dependabot.yml`): **live and
  already working** — 8 PRs filed within hours (npm minors grouped, majors
  individual, actions bumps), every one riding the full CI gate. One
  informative red: the typescript 5.9.3→7.0.2 major fails CI (the gate
  doing its job — merge decisions stay human).

## The spend-gate law — untouched, observable

- No `TUBEFORGE_SPEND_GATE=0` anywhere in S56 (the one grep hit is a
  comment in the battery runner's header describing s27/s32's on-demand
  requirements).
- No forced `TUBEFORGE_PRICING_VERIFIED` — the pricing block stays
  provisional, `SpendPricingUnverifiedError` behavior unchanged.
- The nightly battery renders with ffmpeg only (kenburns mode); the
  excluded s8/s11 are the only gateway-touching probes, and they are NOT
  in the nightly set. Gateway spend this stage: **zero** (the S55 eval-kit
  re-render and all S56 work rode local synthesis/stand-ins).

## The stage's reliability ledger

- **Unit: 245/245** (no new tests — S56 is release engineering; the
  harnesses are scripts + workflows, and the one probe hardening (s29
  poller aborts) is probe-side).
- **tsc 0 · eslint 0 errors / 602 warnings** (672→602; the trivial tranche
  zeroed AND promoted to errors — it cannot grow back without failing CI).
- **Billing 40/40 in CI** on every push (T-56.2); **coverage 56.30% with a
  50 floor in CI** (T-56.4); **the build job green** (T-56.1); **17-probe
  nightly + full e2e** (T-56.5).
- Known limitations, on record:
  - The route battery's reaper-vs-sandbox reality: the full "all" leg is
    CI's; the sandbox verifies piecewise (documented in the runner header).
  - s8/s11/s27/s28/s30/s32 stay on-demand (gateway TTS / daemon-state
    dances — reasons at `PHASE1_PROBES` and per-probe headers).
  - The e2e job still boots a dev server (the Playwright `webServer`);
    the battery's production-server pattern is the model if e2e ever
    needs the same.
  - Multi-commit pushes give the intermediate commits tree-coverage via
    the head run (one workflow run per push) — per-commit run evidence
    needs single-commit pushes, as S55 did.

## Carried forward (explicit)

1. The structured logger (P0-7's in-repo half) — the no-console class
   (381 warnings) is its tranche; Sentry accounts remain owner actions.
2. The next warning tranches: non-null-assertion (159), react-hooks (42),
   unused-expressions (11).
3. The render-under-coverage suite (closing the render/video-jobs gap in
   the money-path baseline) if the 50% floor ever proves too coarse.
4. Dependabot PR triage: 8 open PRs await human merge decisions (the
   typescript major is a known CI-red).
5. **Rotate the GitHub PAT** — the working token transited chat again
   (standing rule since S33).
