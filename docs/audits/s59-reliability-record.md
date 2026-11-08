# S59 reliability record — react-hooks correctness: set-state-in-effect + exhaustive-deps

**Date**: 2026-11-08 (UTC) · **Stage**: S59 (owner-directed "Next")
**Status**: **CLOSED (2026-11-08)** — pushed alone on the rotated PAT as
`39721de..62b3656`; CI run **42485325793** green on the head `62b3656`
(attempt 2 — attempt 1's single E2E failure is triaged as a CI dev-server
flake, with evidence, in the landing section at the end of this record).

## The landing constraint (read this first)

The S57+S58 landing PAT transited chat once (the standing rule's threshold;
rotation was the recorded instruction at both stages' closes). S59 therefore
executes and verifies locally; the push, the CI runs, and the stage close
ride a **rotated** PAT. A git bundle ships in the delivery (`39721de..HEAD`)
so a sixth reclaim loses nothing — the fifth (between the S58 close and this
stage) took `work/` again, and the recovery was the established recipe: the
platform's `/tmp` staging kept `download/`, `scripts/`, `db/`, `.env`;
fresh public clone at `39721de`; restore; `npm ci`; gates.

## The reconnaissance — the rule's real boundary, established empirically

The census's **42 sites** (33 set-state-in-effect + 9 exhaustive-deps) sat in
**21 files**. Before touching anything, the rule's acceptance boundary was
pinned with throwaway probe files (five shapes, linted, deleted — the method
disclosed):

1. Direct synchronous `setState` in an effect body → **flagged** (the rule's
   purpose: the derived-state anti-pattern).
2. A component-scope `useCallback` loader — **even one whose every setState
   sits behind its own `await`** — called directly from the effect →
   **flagged**: the rule does not model await positions inside called
   functions.
3. An `async` IIFE in the effect with an await-first body → **clean**.
4. A promise chain with inline `.then`/`.catch` callbacks → **clean**.
5. An effect-local helper called only after an await → **clean**.
6. An await-first IIFE wrapping the loader call (`void (async () => { await
   load(); })();`) → **clean** — the minimal, honest form for the await-first
   loaders: it makes the async boundary lexically visible; the loader's
   behavior is untouched.

Also learned en route: the rule reports **one site per effect** — the vdd
fetch battery's flagged `setVariants` was only the first of ~25 synchronous
setters in that effect; the rest surfaced one at a time as each was fixed.
The freeze-level pass at the end is what proves the class empty, not the
census count.

## The tranche — what actually changed (five honest moves)

1. **Await-first IIFE wraps** (12 sites: attention-panel, auth-gate,
   director-card, music-controls, plan-card, security-card ×2,
   timeline-studio ×2, channels-view, research-view, voice-view): the
   await-first loaders keep their bodies; the effect's call site wraps so
   the async boundary is visible. plan-card/timeline's loaders carry a
   synchronous busy-set whose mount-path execution is a same-value no-op
   (busy starts true) — the retry-button UX is unchanged.
2. **Render-time adjusts** (React's documented "adjust state when a prop
   changes" — guarded seed compare, convergent, one FEWER paint than the
   effect form): the prop→state mirrors (brand-kit's accent keyed on
   videoId+accent, scene-editor's nine-field seed keyed on index+imageUrl+
   open, cast-view's reference compare, timeline's scriptDraft keyed on
   index+narration) and the resets (command-palette's open+query,
   timeline's delete/voice/pace disarm keyed on their picks, vdd's entire
   ~25-setter re-seed block keyed on video id, create-view's analysis
   reset keyed on the five script inputs and its draft-banner retirement).
3. **Derived busy** (account-card): `usageLoading` becomes
   `loadedDays !== usageDays` — the loader's synchronous prefix stops
   setting state entirely; the day-toggle busy UX is identical (and shows
   one frame earlier, at the click, not after the effect).
4. **Restructures**: auth-gate's status refresh split into `probeStatus`
   (fetch) + `applyStatus` (mapping) so the mount effect awaits first
   while the submit path keeps `refresh()`; attention-panel's effect owns
   an inlined `tick` with an `alive` cancellation flag (the shared `load`
   stays for the resume/cancel event paths); create-view's draft restore
   **folded onto the settings chain** — an effect-local `applyDraft` runs
   in the `.finally` after the server defaults land (the draft still
   wins), with the prefill check read from the store at apply time to
   match the old latest-render semantics exactly; calendar's schedule
   command consumed by a render-time adjust plus a store-write-only
   effect; research-view's auto-select rewritten as a functional update
   (`cur ?? first`), which removes the `active` closure so its `[]` deps
   become honest; the shadcn carousel's initial canScroll sync moved to a
   render-time adjust keyed on the embla api identity.
5. **use-mobile rewritten onto `useSyncExternalStore`** — the canonical
   form; the effect is gone entirely.

## The exhaustive-deps nine

- `toast` (timeline keydown, calendar load, vdd audition): the hook returns
  a module-level constant — including it is free; done.
- attention-panel: the inline `useAppStore((s) => s.refreshKey)` complex
  dep extracted to a variable (the warning's own recommendation).
- research-view: `active` removed via the functional update above.
- create-view: `startStock` added (a `useCallback`, already listed by the
  sibling callback's deps).
- vdd's fetch battery: **the one reasoned inline disable** — completing
  its deps with `onChanged` (an unstable inline prop from library-view)
  would re-run the whole fetch battery on every parent render; the
  `[video?.id]` key is the deliberate design, the seed adjust carries
  fresh field values on the same trigger, and the disable's comment says
  so in place. This is the stage's single owned exception, disclosed.

## The freeze + census

`react-hooks/set-state-in-effect` and `react-hooks/exhaustive-deps` promoted
to **error** repo-wide. Census re-recorded:
`docs/baselines/s59-lint-census-2026-11-08.txt` — **0 errors · 20 warnings**
(from 62): unused-expressions 11, any 7, import/no-anonymous-default-export
1, no-location-assign-relative-destination 1. The remaining programme: the
unused-expressions 11 (the natural S60), then the any 7, then the two
singles.

## The gates + the live battery

| Gate | Result |
|---|---|
| tsc --noEmit | 0 |
| eslint . (frozen config) | **0 errors / 20 warnings** (start: 0/62) |
| react-hooks classes | set-state-in-effect **33 → 0** · exhaustive-deps **9 → 0** |
| unit (test-unit.mts) | **247/247** |
| billing (test-billing.mts) | 40/40 |
| queue (test-queue.mts) | PASS |
| next build (Turbopack) | exit 0, 57/57 pages, the same four documented warnings |

**The live preview battery** (standalone production build, daemonized,
agent-browser — the S58 infrastructure): a fresh account registered through
the restructured auth-gate; all nine views walked (Dashboard, Analytics,
Topic Radar, Create, Library, Cast, World, Voice Studio, Calendar,
Channels, Settings); the Settings cards render with live data (plan
loaded — the derived-busy resolution proven); the create-view draft
saved, survived a full page reload, and restored with its banner (the
`applyDraft` fold, including the after-defaults ordering); the command
palette opened, filtered, and closed (both reset paths); the mobile
breakpoint crossed both ways (the `useSyncExternalStore` rewrite — the
hamburger nav appears at 390px, the sidebar restores at 1440px). **Zero
page errors, zero console errors for the entire session.** Screenshots:
`download/tf-s59-desktop.png`, `tf-s59-mobile.png`.

Honest limits, stated: video-detail-dialog, timeline-studio, and
scene-editor's deep paths were NOT live-exercised — the local database
carries no videos (fresh secrets, fresh org), and creating one requires
the paid pipeline the spend gate rightly blocks. Their restructures follow
the same verified idioms, pass tsc/build, and their create→detail flows
are covered by CI's E2E job on landing.

## The spend-gate law — untouched, observable

- No `TUBEFORGE_SPEND_GATE=0` anywhere in S59.
- No forced `TUBEFORGE_PRICING_VERIFIED`; zero gateway quota, zero paid
  dispatches — S59 touched only client-side React code; no provider path.

## The landing — pushed, CI-verified, closed (2026-11-08, later the same day)

The owner's rotated PAT arrived; S59 pushed alone as `39721de..62b3656`
(`ec24c80` docs open + `62b3656` feat). **CI run 42485325793** on the head:

| Job | Attempt 1 | Attempt 2 (`rerun-failed-jobs`) |
|---|---|---|
| Secret scan (gitleaks) | success | kept |
| Typecheck · Lint · Unit | success | kept |
| Money-path coverage | success | kept |
| Production build | success | kept |
| E2E (Playwright) | **failure** — 1 of 26 | **success — 26/26 (42.7s)** |

### The attempt-1 E2E failure — triaged as a CI dev-server flake, not a regression

The one red: `e2e/premium-ux.spec.ts:151` "voice studio: catalog renders
and pronunciations roundtrip (T-4.10/T-4.11)" — after filling
"colonel"→"kernel" and clicking Add, `getByText('colonel')` timed out at
15s ("element(s) not found"); the other 25 passed. The triage, in
evidence order:

1. **The failing path contains no S59-touched code.** The add flow is
   pure event-handler code (`addPron` → `savePron` → PUT
   `/api/voices/pronunciations` → `setPronEntries` → the chip map);
   S59's voice-view diff is the 6-line await-first IIFE around
   `loadProfiles` — and the catalog it loads RENDERED fine in the same
   failed run (the test's earlier catalog asserts passed). No S59 file
   touches an API route.
2. **The dev-server compile noise is pre-existing, not new.** The failed
   attempt's log carries 320 "Ecmascript file had an error" lines, all
   trailing the known `instrumentation.ts` Edge-runtime warning; the
   GREEN S58 run (42480528396) carried 338 of the same, and the green
   attempt 2 carried 332. Same noise, opposite outcomes.
3. **Local reproduction: 10/10 passes under the CI-identical condition.**
   `npx playwright test e2e/premium-ux.spec.ts -g "voice studio"
   --repeat-each=5 --workers=1` against the config's own `npm run dev`
   webServer — the exact failing test ×5 plus the clone-tab deep-link
   test ×5, all green (1.1m).
4. **Same commit, rerun: green.** `rerun-failed-jobs` on 42485325793 →
   attempt 2 E2E success, 26/26, all five jobs green.

Verdict: a Turbopack on-demand compile stall on the loaded 2-worker CI
runner — the attempt-1 failure window (the 15s expect starting ~13:34:45)
sits inside a burst of that compile noise (13:34:50). Suite history:
seven consecutive green main-push runs before this one (#117–#123). No
code change was made for this; the flake and its evidence are recorded
here instead.

## What remains (and whose it is)

1. **Owner: rotate the PAT again** — the S59 landing token transited chat
   once (the standing law's threshold; rotation is the recorded
   instruction at every close).
2. **Owner-side, unchanged**: Dependabot PR triage (8 open, human merge
   decisions; the typescript-7 major is a known CI-red);
   Sentry/GlitchTip + uptime monitor (P0-7's other half); the S55 standing
   human items.
3. **Next in-repo tranche (S60 candidate)**: unused-expressions 11, then
   the any 7, then the two singles — the warning programme's last 20.
