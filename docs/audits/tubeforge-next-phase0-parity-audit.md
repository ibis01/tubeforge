# TubeForge Next — Phase 0: Comparative Engineering Audit

**Status:** COMPLETE — capability parity matrix + migration map delivered
**Date:** 2026-11-18
**Evidence base:** `ibis01/tubeforge` @ `b06f222` (HEAD) vs `ibis01/ibismuh-studio` @ `b2fd3f3` (HEAD), both cloned and cross-fetched locally; every claim below is command-backed (appendix A).
**Program:** TubeForge Next — capability expansion and product-experience modernization. Strategy: **selective capability migration, not repository replacement.**

---

## 1. Decisive structural finding (changes the whole audit shape)

The two repositories are not divergent siblings. They share the **same three root commits** (`286c737`, `af7e12d`, `8b339de`) and the fork point between them is **exactly TubeForge's current HEAD**:

```
fork point:  b06f222  docs(s185): the deployment-readiness milestone staged …
TubeForge:   b06f222  (0 commits since fork)
Studio:      b2fd3f3  (26 commits since fork, Nov 17 → Nov 18, 2026)
```

**Ibismuh Studio is TubeForge `b06f222` plus exactly 26 commits.** The entire delta is:

| Measure | Count | Meaning |
|---|---|---|
| Deleted files | **0** | No capability was removed. Nothing to restore. |
| Renamed files | 251 | The rebrand stages (identity layer only) |
| Modified files | 320 | Rebrand sweeps + feature passes |
| Added files | 32 | New UI surfaces, design specs, audits, walk scripts, format art |

Consequences:

1. Studio already contains **every** TubeForge engine (whiteboard, 2D graphics, 3D, character, audio, QC, publishing, SaaS) — they are the same engines.
2. The audit question is no longer "which repo is better at X" but **"what did those 26 commits add, and how much of it should land on TubeForge."** The delta is enumerable, bounded, and already gated by Studio CI receipts.
3. Nothing in TubeForge needs to be rebuilt, replaced, or re-derived. Migration is a **backport of a known 26-commit delta**, with the rebrand layer stripped.

## 2. The 26 commits, classified

| Layer | Commits | Verdict for TubeForge |
|---|---|---|
| **Rebrand (identity)** — stages A–E + docs + smoke-seam fix | `aa0f165` `f38a859` `7e67e84` `8422631` `d9eb9be` `827af17` `612341e` `eb4bc28` `59b8ad1` | **EXCLUDE.** Product identity stays TubeForge (decision §6). Archive: stages A–E are a documented, replayable rebrand procedure with compat-env/cookie dual-read — a one-decision operator action if branding ever changes. |
| **Features** — the product substance | `db2241e` (B1+B2 design foundation + Home/Projects, 45 files, +839/−257) · `76df60e` (B3 full-page production workspace, 25 files, +1015/−323) · `af15635` (B4 creative workspace enhancement, 12 files, +2307/−82) | **MIGRATE** (map §5, items M3–M5). |
| **Security** — external review remediation | `afea263` (review docs) · `adc2281` (fixes: P0×2, P1×3, P2×2 — malformed-signature 500, secret-policy mismatch, unenforced email verification, transparent bcrypt rehash-on-login; 11 files, +358/−64) | **MIGRATE FIRST-CLASS** (M1). Fixes TubeForge's own auth seams. |
| **Bug fix — QC** | `f334a4b` — ffmpeg 8 renamed the `blackdetect`/`freezedetect`/`silencedetect` log prefixes; TubeForge's `qc.ts` regexes blind-pass → **dead-air false-passed every render on ffmpeg 8** (8.1.3-static CI evidence). 1 file, +8/−3. | **MIGRATE IMMEDIATELY** (M0). Highest value per line in the whole delta. |
| **Bug fix — storage** | `b2fd3f3` — S3 signer: LIST gap + greenlight 403 survival (+ new `scripts/test-s3-signer.mts` regression test; 6 files, +307/−33) | **MIGRATE** (M2). |
| **CI/ops resilience** — ffmpeg apt-mirror outage nets, step budget, ECR mirror + 2 receipt docs | `473db65` `87599d3` `4ca159b` `9db6327` `aaa3593` `49955af` | **MIGRATE** (M2). Workflow-only, zero product risk. |
| **Tests / validation / worklogs** | `5f4d30a` (13/13 three-project production test; catches a latent music-path bug) · `1e546a2` (gitleaks finding killed at root) · `e6e35e0` `8fedbc8` | **MIGRATE** with their layers; test scripts ride M2/M5; worklogs/audits migrate as reference docs. |

**One delta fix is a no-op on TubeForge:** B4's `TUBEFORGE_RATE_*` harness fix (`af15635`) repairs a mismatch *created by rebrand stage-B* (server keys renamed, harness left behind). TubeForge never renamed its keys — harness and limiter are already aligned there. It is not applicable to the backport.

## 3. Capability parity matrix (the 14 workstreams)

Classification vocabulary per programme charter: **Already implemented / Implemented but incomplete / Implemented but poorly integrated / Missing / Not verified.** Since Studio is a strict superset, every gap below is a *Studio-side addition* or *TubeForge-side defect* — never a missing engine.

| # | Workstream | Verdict | Evidence & disposition |
|---|---|---|---|
| 1 | **Application experience** | Implemented but poorly integrated → **unify (M3–M5)** | TubeForge app shell is the pre-B1 layout (dialog-based detail, five exclusive tabs, no always-mounted Inspector/Timeline). Studio's B1–B4 provide the design foundation (navy/blue/cyan token system in `globals.css`), creator-control Home/Projects, full-page production workspace, and the resizable three-surface editor (`react-resizable-panels` — **already in TubeForge's package.json, unused**). Shell-only files; engines untouched. |
| 2 | **AI Director** (research/scripting/planning) | **Already implemented — preserve** | Zero delta commits touch the director/research/script pipeline. |
| 3 | **Storyboard** | **Already implemented — preserve** | Zero delta. |
| 4 | **Scene editor** | Already implemented → **refresh (M4)** | B3 refines `scene-editor.tsx` and `motion-controls.tsx` in the new workspace; lib touches are 1-line each (`production-profiles.ts`, `title-font.ts`). |
| 5 | **2D animation** | Implemented but not exposed → **migrate (M5, B4-2)** | B4 adds the Motion panel authoring UI (enter/exit/emphasis, the 15-curve S162 ease dropdown, S129 tween channels/keys, S130 camera keys with `CAMERA_BOUNDS` pins) **through the existing validated PUT buffer** — explicitly "no renderer change; frameAt evaluates on save." Deterministic engine untouched. |
| 6 | **Whiteboard** | **Already implemented — preserve; W1–W7 roadmap unchanged** | Feature commits contain **zero whiteboard code touches** (one fixture-name mention only). The W-roadmap (perceptual baseline → beat compiler → brush assets → handwriting → camera director → continuous canvas → finishers) proceeds independently. |
| 7 | **3D animation** | Implemented but not reachable → **migrate (M5, B4-3)** | B4-3: Scene3D card (objects/lights/camera/look/finishers editor + clip preview) and an **additive PUT route** honoring the one parse law (unparseable → 400, never silent overwrite; rerender rides the deterministic job). Touches `api/videos/[id]/scene3d/route.ts` — additive seam. |
| 8 | **Character system** | **Already implemented — preserve** | B1+B2 modifies `cast-view.tsx` cosmetically (theme/navigation). No model/asset changes. |
| 9 | **Timeline** | Implemented but poorly integrated → **migrate (M5, B4-1)** | B4-1: ≥1024px resizable three-surface layout — always-mounted Inspector rail + always-mounted Timeline strip, one `TimelineStudio` instance, Radix tab semantics kept so S86 jumps and e2e selectors ride untouched; classic formats and <1024px stacked tabs unchanged; scrollWidth 390 held. |
| 10 | **Audio** | Implemented but not wired → **migrate (M5, B4-4)** | B4-4 wires the S131 sfx-event seam into graphics render: sfx mix at projected global times (adelay + one amix, VO-anchored duration); **no cues ⇒ byte-identical assembly args** (additive-seam law, pinned). 86 insertions, 0 deletions in `graphics/render.ts`. |
| 11 | **Intelligence** | **Already implemented — preserve** | Analytics/creator-intelligence views get theme-only touches. |
| 12 | **Quality control** | **Defect found → backport (M0)** | `qc.ts` detector regexes false-pass dead-air/freeze/silence on ffmpeg 8 (log-prefix drift). M0 is a 1-file backport. |
| 13 | **Publishing** | **Already implemented — preserve** (+ storage fix M2) | Channels/calendar get theme touches only. The S3 signer fix (`b2fd3f3`) is storage-layer, migrated as M2. |
| 14 | **SaaS platform** | **Already implemented → harden (M1)** | Security pass `adc2281`: auth lock/login/setup/diag routes, `auth-token.ts`, `tenant.ts`; nightly.yml + SECURITY.md ride along. Cross-tenant boundary held (per review); the three findings are all in TubeForge's own seams. |

**Summary:** nothing Missing, nothing Not verified. One TubeForge-side QC defect (M0), one storage defect (M2), one hardening pass (M1), and three UI/product passes (M3–M5). The rebrand layer is excluded by design.

## 4. De-rebrand adaptation law (the mechanical rule every backport follows)

The Studio feature commits were written on top of the rebrand, so every cherry-pick applies with this deterministic mapping:

| Studio artifact | TubeForge target |
|---|---|
| `src/lib/ibismuh/**` | `src/lib/tubeforge/**` |
| `src/components/ibismuh/**` | `src/components/tubeforge/**` |
| `IBISMUH_STUDIO_*` env keys | `TUBEFORGE_*` env keys (the originals) |
| `ibismuh_session` cookie | `tf_session` cookie |
| `compat-env.ts` dual-read mirror | **Not needed** — TubeForge's names were never renamed; imports of `compat-env` are re-pointed to direct env reads |
| `ibismuh-push.sh` push gate | existing TubeForge push gate |
| User-visible strings "Ibismuh Studio" | "TubeForge" |
| Package name / Dockerfile user / CI service names | unchanged (TubeForge originals) |

Each backport lands as a **new commit on TubeForge main** (cherry-pick + mechanical rename sweep + fixups), with Studio provenance preserved in the commit message (original SHA, author, and intent quoted).

## 5. Migration map — ordered, gated, risk-graded

| Order | Item | Source commit(s) | Scope | Risk | Gate |
|---|---|---|---|---|---|
| **M0** | QC ffmpeg-8 regex backport | `f334a4b` | 1 file (`qc.ts`), +8/−3 | **Trivial — do first** | battery + new detector unit pins for ffmpeg-7 AND ffmpeg-8 prefix shapes |
| **M1** | Security hardening | `adc2281` (+ `afea263` docs) | 11 files; de-rebrand 2 lib paths | Low — seams only | battery; lockout/login/setup e2e; manual malformed-signature 400 check |
| **M2** | CI resilience + storage signer + gitleaks + production test scripts | `473db65` `87599d3` `4ca159b` `9db6327` `b2fd3f3` `1e546a2` `5f4d30a` | workflows; `storage-s3.ts`/`storage.ts`/`serialize.ts` + `test-s3-signer.mts`; walk scripts | Low | storage tests green against localstack/real bucket per script contract |
| **M3** | Design foundation + Home/Projects (B1+B2) | `db2241e` | 45 files, mostly shell + `globals.css` tokens + icons/manifest + `public/formats/*.jpg` | Medium — touches every view | battery; `premium-ux` + `mobile-sweep` e2e; visual walk at 1440/390 |
| **M4** | Full-page production workspace (B3) | `76df60e` | 25 files; detail dialog → full-page surface | Medium (depends on M3) | battery; e2e incl. S86 jump selectors; walk receipts |
| **M5** | Creative workspace enhancement (B4) | `af15635` | 12 files; three-surface editor + Motion panel + Scene3D card + sfx mixing | Medium (depends on M3+M4) | battery (+ sfx seam pins); **byte-identical render check for no-sfx projects**; e2e 37/37 equivalent |

**Sequencing rules:** M0/M1/M2 are independent of each other and of the UI chain — they can land immediately. M3 → M4 → M5 must be strictly sequential (all three rewrite the same shell files; out-of-order application guarantees conflicts). One migration merged and fully green before the next begins; a failing gate rolls back that migration only.

**Reference material migrated with the code:** `docs/design/B1_DESIGN_SPECIFICATION.md`, `B3_PRODUCTION_WORKSPACE_SPEC.md`, `B4_CREATIVE_WORKSPACE_SPEC.md`, the B-audits, and the B0 baselines — re-anchored to TubeForge naming.

**Explicitly excluded:** the rebrand layer (§2), `compat-env.ts` (§4), rebrand-only test fixtures (compat suites), `IBISMUH_STUDIO_*` compose/env wiring. Expected battery delta on TubeForge: +sfx-seam pins and storage-signer suites; **not** the 5 rebrand compat suites — target ≈ 1003 → 1010 green.

## 6. Branding decision

**Recommendation: retain the TubeForge identity during the entire programme.** Rebrand remains a separate, deliberate, operator-gated decision. Three supporting facts from this audit:

1. The identity layer is **cleanly separable** — proven: 9 commits, staged A–E, each battery-gated, with env/cookie dual-read so the rename never strands data or sessions.
2. That staging makes a future rebrand a **replayable procedure** in either direction, not a rewrite.
3. Keeping identity unchanged keeps every migration diff minimal, reviewable, and reversible — which is what protects the engines, the data, and the release candidate.

## 7. Programme rules — compliance check

| Charter rule | Status after this audit |
|---|---|
| Preserve TubeForge git history | Maintained — all backports are new commits on main |
| Preserve rendering engines and pipelines | Verified — 0 deleted files; only engine touch is B4's additive sfx seam (+86/−0), gated byte-identical |
| Do not copy Studio over TubeForge | Enforced — cherry-pick + de-rebrand law (§4), layer-by-layer |
| Preserve migrations and customer data | Unaffected — zero prisma migration files in the delta |
| Maintain provider abstractions / API compatibility | Additive seams only (scene3d PUT, sfx mixing) |
| Keep security, billing, queue safeguards | Strengthened by M1 |
| Regression coverage per capability | Battery + e2e + storage suites migrate with their layers; M0 adds dual-prefix detector pins |
| Green CI ≠ production readiness | S185 deployment-readiness staging proceeds independently; M0/M1 *improve* it (QC false-pass fix, auth hardening) |

## 8. Next actions (Phase 1 entry)

1. Execute M0 → M1 → M2 (independent, can land in one session, each separately gated).
2. Then M3, the design foundation — the first user-visible TubeForge Next deliverable.
3. Whiteboard W1 (perceptual baseline) proceeds in parallel per the standing roadmap — no conflicts, zero shared files.

---

## Appendix A — evidence commands

```bash
# lineage
git rev-list --max-parents=0 HEAD            # both repos → same 3 roots
git fetch /path/to/ibismuh-studio HEAD
git merge-base HEAD FETCH_HEAD               # → b06f222 (TubeForge HEAD itself)
git rev-list --count b06f222..FETCH_HEAD     # → 26

# delta shape
git diff --stat b06f222 FETCH_HEAD | tail -1 # 603 files, +10500/−3920
git diff --diff-filter=D --name-only b06f222 FETCH_HEAD  # → empty
git diff --diff-filter=A --name-only b06f222 FETCH_HEAD  # → 32 files

# per-layer inspection
git show --stat db2241e ; git show --stat 76df60e ; git show --stat af15635
git show --stat adc2281 ; git show f334a4b ; git show --stat b2fd3f3
git show af15635 -- src/lib/ibismuh/graphics/render.ts   # +86/−0, additive
git show db2241e|76df60e|af15635 --name-only | grep -i whiteboard  # → 0 code touches
```

**Audit conducted against:** TubeForge `b06f222` ("docs(s185): the deployment-readiness milestone staged") · Studio `b2fd3f3` ("s3: sign the LIST gap + survive the greenlight 403").
