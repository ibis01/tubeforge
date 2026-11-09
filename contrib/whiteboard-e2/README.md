# contrib/whiteboard-e2 — the sandbox E2 whiteboard prototype (archived)

This directory is a **faithful archive** of the parallel whiteboard-engine
prototype built in the engineering sandbox during the S66 reconciliation.
It is **not wired into the app**: nothing in `src/` imports it, and
`contrib` is excluded from `tsconfig.json` and the ESLint ignore list so
the CI contract (typecheck · lint · build · secret scan · money-path ·
Postgres · E2E) is untouched by its presence.

## What is here

| Path | What it is |
| --- | --- |
| `PLAN.md` | The E0→E12 milestone matrix written for the prototype track. |
| `src/lib/tubeforge/whiteboard/` | The prototype engine: `animator`, `composer`, `encoder`, `geometry`, `path-extractor`, `rasterizer`, `schemas`, `svg-validator`, `asset-registry`, `sample-project`, `rendering/renderer`. SVG → progressive path drawing → path-following hand → deterministic frames → MP4 (1080p). |
| `src/lib/tubeforge/whiteboard/assets/library/` | The ten hand-drawn SVG library assets (growth arrow, bar chart, check badge, clock, coin, globe, hand, lightbulb, rocket). |
| `src/app/api/settings/tts/`, `src/lib/tubeforge/tts.ts`, `src/components/tubeforge/editing-studio.tsx` | Old-lineage product files kept for reference only — **superseded on main** by `src/lib/tubeforge/providers/tts.ts`, the `settings/voices` routes, and `timeline-studio.tsx`. |
| `scripts/test-whiteboard.mts`, `scripts/render-sample-whiteboard.mts` | The prototype's test + sample-render entry points (run paths assume the old single-app layout; they are not part of `npm run check`). |

## Why it is archived instead of merged into `src/`

The canonical whiteboard engine lives in `src/lib/tubeforge/whiteboard/`
(`assets/render/storyboard/svg/timing`) — it landed on main in S64 (P0,
native drawing engine, 40 unit contracts, the 63.9s benchmark) and S65
(E1, technical design + budget hardening), each closed on green CI
evidence. The prototype in this directory is an independent implementation
of the same program from the sandbox lineage (commits `b5976ea..b23e551`).

Landing it inside the app would put two engines in the build path; landing
it nowhere would lose real engineering. `contrib/` is the middle line: the
code ships, the product does not change.

## Follow-up (E-series reconciliation)

Decide which implementation carries E3+ (canonical engine vs prototype
capabilities such as the path-following hand and the asset library), then
port the winner's missing pieces and delete the loser. Until then this
directory is read-only reference material.
