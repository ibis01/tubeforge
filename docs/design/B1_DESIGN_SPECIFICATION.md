# TubeForge — B1 Design Specification & B2 Implementation Plan

Status: IMPLEMENTED (B1+B2 shipped; execution record in §10) · Author: design/engineering session
Scope: B1 (design foundation) + B2 (Home & project management) implemented in this pass.
B3+ (production workspace, asset tools, QC/publishing, product testing) are specified here as
direction and scheduled separately.

Related: `TUBEFORGE_DESIGN_KICKOFF.md` (bootstrap), `docs/audits/external-security-review-2026-11-17.md`,
stage-E rebrand execution record (`docs/audits/`).

---

## 0. Product thesis

TubeForge is a **premium AI video production workspace**, not an automation bot.

One sentence the whole product must communicate: *a creator brings an idea into the studio,
directs its production, controls every scene, and leaves with a finished video.*

The agreed workflow stays one connected production line, with human approval at every
important stage:

**01 Brief → 02 Script → 03 Storyboard → 04 Generate → 05 Edit → 06 Review → 07 Export**

Language law (enforced from B1): the UI never says "fully automated", "zero manual work",
"auto-pilot", "you just hit publish". AI assists; the creator directs. Every generation shows
what it is doing, why, what it costs, and what can be changed (cost transparency lands with
B3's generation panels; B2 starts the language migration).

---

## 1. Rendered UI inspection (evidence, pre-redesign)

Method: fresh clone → `npm ci` → isolated SQLite `.env` → `next dev` → Playwright-driven
browser walk (agent-browser) at 1440×900 and 390×844, every view visited, screenshots archived
under `/tmp/inspect/` (session artifact; re-runnable via the receipt commands below).

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| I1 | Setup/lock screen wordmark still renders **"TubeForge"** | `src/components/tubeforge/auth-gate.tsx:301` | Legacy leak — MUST_RENAME (stage-E escape) |
| I2 | Login page wordmark still renders **"TubeForge"** | `src/app/login/page.tsx:90` | Legacy leak — MUST_RENAME |
| I3 | `BrandLockup` wordmark still renders **"TubeForge"** | `src/components/tubeforge/brand.tsx:96` | Legacy leak — MUST_RENAME |
| I4 | 11 flat top-level nav destinations on desktop and mobile sidebar | `app-sidebar.tsx` NAV_ITEMS | IA fragmentation |
| I5 | Automation framing: "Mission Control", "Your faceless channel, fully automated.", "Auto-Pilot Online", "Auto-Pilot Active — Zero manual work", "Fire up Auto-Pilot", "Production Line", footer "Automated faceless YouTube content engine", wordmark subtitle "Auto-Pilot Engine" | dashboard-view, app-sidebar, page.tsx, logo.tsx, brand.tsx | Product-identity mismatch |
| I6 | Identity: near-black charcoal (`oklch(0.128 0.005 285.8)`) + red-orange gradient (`#FF2020→#FF7A1F`); not the agreed navy/blue/cyan | `globals.css:46-81`, `brand.tsx` BRAND_GRADIENT | Visual identity |
| I7 | Format picker is text-only: six `VIDEO_TYPES` cards, description only, no visual example or style preview | `create-view.tsx:99-154` | Create experience |
| I8 | Mobile nav = same flat 11-item sheet; shell otherwise sound (no overflow, 44px targets) | mobile-sweep spec + inspection | IA fragmentation |
| I9 | Shell engineering is strong: code-split views, ⌘K palette, sticky footer, CSP nonce handling, PWA wiring | page.tsx, layout.tsx | Keep — do not regress |

I1–I3 close in this pass (brand identity is B1 scope). I4–I8 are the B1/B2 work items below.

---

## 2. Visual identity (B1)

Dark-first. Deep navy surfaces, panel blues, a single cyan accent family. Red is reserved
for destructive/failed states only. Restrained gradients (brand CTA + logo + one hero wash)
— never gradients on body panels.

### 2.1 Design tokens (globals.css `:root, .dark`)

| Token | Current (charcoal/red-orange) | New (navy/blue/cyan) | Notes |
|---|---|---|---|
| `--background` | `oklch(0.128 0.005 285.8)` neutral | `oklch(0.145 0.02 248)` deep navy | hue 248 ≈ #0B1220 family |
| `--foreground` | 0.96 neutral | `oklch(0.95 0.005 240)` | cool white |
| `--card` | `oklch(0.165 0.006 285.8)` | `oklch(0.19 0.024 250)` panel navy | |
| `--popover` | `oklch(0.17 …)` | `oklch(0.205 0.024 250)` | |
| `--primary` | `oklch(0.628 0.258 29.23)` red-orange | `oklch(0.80 0.105 205)` cyan | CTA/accent/active-nav |
| `--primary-foreground` | white | `oklch(0.17 0.03 245)` dark navy | AA on cyan |
| `--secondary` | neutral 0.22 | `oklch(0.24 0.024 250)` | |
| `--muted` / `--muted-foreground` | neutral | `oklch(0.225 0.02 250)` / `oklch(0.68 0.02 246)` | AA on navy |
| `--accent` | red-tinted | `oklch(0.27 0.04 232)` blue hover tint | |
| `--destructive` | red | unchanged (semantic) | red = failure only |
| `--ring` | red-orange | = `--primary` | focus |
| `--chart-1…5` | red/orange/gold | cyan `0.80 0.105 205`, blue `0.62 0.14 250`, teal `0.70 0.09 190`, slate `0.55 0.02 248`, violet `0.65 0.10 290` | production charts |
| `--sidebar` | 0.145 neutral | `oklch(0.16 0.02 248)` | one step off background |
| `--sidebar-accent` | neutral | `oklch(0.25 0.03 248)` | active nav pill |
| `--border` / `--input` | white/10% & 14% | unchanged alpha model (reads blue on navy) | |

Derived semantic set (Stage-4a `--tf-*` layer) stays: `--tf-positive` emerald, `--tf-warning`
amber, `--tf-danger` red, `--tf-info` sky — these are production-state colors, not brand.
`--tf-focusable` outline moves red-orange → cyan.

Utility renames (class names keep their call sites): `glow-red` → `glow-brand`,
`glow-red-soft` → `glow-brand-soft`; `.text-gradient` / `.bg-brand-gradient` keep names,
new stops `#2563EB → #0EA5E9 → #22D3EE` (blue → sky → cyan, 135°). Glass surfaces and grid
backdrop keep their alpha model (they read correctly on navy).

### 2.2 Brand kit (logo.tsx, brand.tsx, icon.svg, manifest)

- `BRAND_GRADIENT` constants: `#2563EB / #0EA5E9 / #22D3EE`.
- Logo tile + `ForgeMark`: same geometry (it is a good mark), new gradient stops; glow
  shadows move red → cyan.
- Wordmark: **"TubeForge"** everywhere (auth-gate I1, login I2, BrandLockup I3, logo.tsx).
- Wordmark subtitle: "AI Video Studio" (was "Auto-Pilot Engine").
- `public/manifest.webmanifest` + PWA theme colors follow the navy background; `src/app/icon.svg`
  re-graded to the new gradient (viewport `themeColor` = `#0B1220`).

### 2.3 Typography & spacing

- Keep Geist Sans/Mono (clean, technical, already loaded).
- Headings `tracking-tight`; section labels use the existing `.tf-kicker` pattern.
- Spacing/panel geometry: `rounded-2xl` cards, `p-5/p-7` padding, `gap-4` grids — already
  consistent in the shell; B1 formalizes this as the only allowed card grammar
  (`.tf-card` + `.tf-card-hover` for interactive surfaces).

### 2.4 Motion

- Keep the existing 120/200ms token durations; hover lifts, focus rings, view cross-fades.
- No new animation families in B1. `prefers-reduced-motion` behavior unchanged.

---

## 3. Application navigation architecture (B1)

### 3.1 Destinations

Four destinations + Settings. Nothing else at the top level.

```
01 Home        → dashboard-view   (redesigned in B2)
02 Projects    → library-view     (project list; "New Project" is an action, not a destination)
03 Assets      → assets-hub (NEW) tabs: Cast · World · Voice Studio
04 Insights    → insights-hub(NEW) tabs: Analytics · Topic Radar · Publishing Calendar · Channels
   Settings    → settings-view
```

Rules:
- The header keeps a single primary CTA: **New Project** (was "New Video") — visible
  everywhere except Create/Settings, same as today.
- Specialist modules are NOT deleted. They live as tabs inside their destination hub
  (`cast-view`, `world-view`, `voice-view`, `analytics-view`, `research-view`,
  `calendar-view`, `channels-view` render unchanged inside the hubs).
- Deep jumps keep working programmatically (`setView("voice")` from the clone deep-link,
  `setView("calendar")` from a project, etc.). The sidebar highlights the destination that
  owns the active view (voice → Assets). The hub tab strip reflects the active child.
- New `ViewId`s: `assets`, `insights` (added to the union; all existing ids preserved —
  zero API/store breakage).

### 3.2 Sidebar (desktop)

Linear-discipline: five rows, section-free (no 11-item scan), 2.5px radius pills, active row
gets the cyan accent + left glow dot (existing pattern, recolored). Studio status card at the
bottom replaces the Auto-Pilot card:

```
┌──────────────────────────┐
│ ◆ TubeForge         │   ← logo + wordmark, subtitle "AI Video Studio"
│   AI Video Studio        │
├──────────────────────────┤
│ ⌂ Home                   │
│ ▤ Projects               │
│ ◫ Assets                 │
│ ↗ Insights               │
│ ⚙ Settings               │
├──────────────────────────┤
│ Studio status            │   ← "You direct · AI assists." + pipeline hint
│ Idea → Script → Scenes…  │
│ [Sign out]               │
└──────────────────────────┘
```

### 3.3 Mobile (≤ lg)

Sheet nav mirrors the same five destinations (44px rows), hub tab strips scroll
horizontally under the page title. The hamburger/sheet mechanics stay (they pass
mobile-sweep today).

### 3.4 Command palette

`NAV_ITEMS`-driven rows follow the new destinations automatically; the "New video" action
re-anchors to "New project"; recent-projects rows unchanged.

---

## 4. Home (B2 redesign of dashboard-view)

Data logic untouched (S60 independent-load guards, stats DTO, attention panel all stay).
Copy and emphasis change to creator-control framing:

- Badge: "Studio ready" (was "Auto-Pilot Online").
- H2: **"Bring an idea in. Leave with a finished video."** (was "Your faceless channel,
  fully automated.")
- Sub: "You direct the production — AI assists with scripts, scenes, narration and
  packaging. Every important step stays yours to approve."
- CTAs: **Start a new project** (primary) · **Find your next topic** (secondary, Topic Radar).
- One-tap topic chips stay (they prefill the brief).
- Section headers: "Recent Projects" (opens the project, thumbnail-first), "Production
  pipeline" (was "Pipeline Breakdown"), "Recent Activity" subtitle becomes "Latest studio
  events" (was "Live from the automation floor").
- "Continue where you left off" row stays — it is the strongest creator-control pattern
  already in the product.
- KPI row: "Generate a Video"-era labels renamed ("In Pipeline" sub becomes
  "Script / scenes / voice"); card accents recolored by the token swap.

Wireframe:

```
┌────────────────────────────────────────────────────────────────────┐
│ ● Studio ready          Bring an idea in. Leave with a finished     │
│                         video.                                     │
│   You direct the production — AI assists with scripts, scenes,     │
│   narration and packaging. Every important step stays yours.       │
│   [ Start a new project ]   [ Find your next topic ]               │
│   START IN ONE TAP: (topic chips…)                                 │
└────────────────────────────────────────────────────────────────────┘
[ Projects ]  [ In production ]  [ Ready ]  [ Published ]   ← KPI row
[ Continue where you left off → (most recent in-flight project) ]
[ Production volume · 7d ───────────── ] [ Production pipeline ───── ]
[ Recent projects — thumbnail cards ─────────────────────────────── ]
[ Recent activity ───────────────────────────────────────────────── ]
```

---

## 5. Projects & the creation experience (B2)

### 5.1 Projects (library-view reframe)

- Page title: **Projects** (was "Video Library"); subtitle: "Every project in your studio —
  click to open the production workspace."
- Status filter rail unchanged (All/Drafts/Scripted/Voiced/Ready/Published/Failed).
- Empty state: "No projects yet" + "Start your first project — brief in, finished video
  out." + [New project] CTA (was "Library is empty / Fire up Auto-Pilot…").
- Cards/dialog logic unchanged (the detail dialog becomes the B3 production workspace).

### 5.2 Create (format previews)

The six `VIDEO_TYPES` cards gain a **visual preview** (16:9 image, ~120px tall, rounded,
object-cover) + the existing title/description, so choosing a format shows what the output
looks like and how it produces:

| Type | Preview concept |
|---|---|
| Classic narration | Cinematic still with subtle narration waveform overlay |
| Scene story | Storyboard grid of painted scene frames |
| Whiteboard explainer | Hand-drawn diagram mid-draw on a whiteboard |
| Motion graphics (2D) | Flat headline + counter + bar-chart composition |
| Character animation | Stylized character rig with pose ghosts |
| Keynote slides | Typographic slide deck fanned in perspective |

Implementation: images generated once into `public/formats/<id>.jpg` (navy/cyan-graded so
they belong to the identity), `preview` field added to `VIDEO_TYPES`, card renders the
strip when present. **No wizard logic changes.**

Header/meta: view title "New Project" (was "Auto-Pilot Studio"); subtitle "Brief in —
directed production out". The wizard's five steps and Production Line panel keep their
mechanics; automation-noun copy inside the wizard migrates opportunistically where not
test-pinned (full pass lands with B3's workspace).

---

## 6. Production workspace wireframes (B3 direction — NOT in this pass)

The unified per-project workspace (Director · Storyboard · Canvas · Timeline · Inspector)
builds on the existing scene-editor/repair engine. Recorded here so B2's Projects detail
dialog work does not paint B3 into a corner:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Director      Storyboard      Canvas      Timeline      Inspector    │ ← workspace tabs
├───────────┬──────────────────────────────────────────┬───────────────┤
│ Director  │  Canvas: large preview of selected scene │ Inspector     │
│ brief     │  (composition + animation controls)      │ scene settings│
│ script    │                                          │ model/style   │
│ pacing    │  [ regenerate ] [ variants ] [ approve ] │ motion/revs   │
├───────────┴──────────────────────────────────────────┴───────────────┤
│ Timeline: video ▂▂▂ narration ▂▂ music ▂ sfx ▂ captions ▂ transitions │
└──────────────────────────────────────────────────────────────────────┘
```

Feature commitments (from the product assessment): scene-level regeneration, variant
comparison, continuity system, director controls, motion preview, QC with targeted repairs,
revision history, approval gates. Exit condition B3: a creator can inspect and revise
individual scenes without leaving the project.

---

## 7. Component inventory (files touched by B1+B2)

| File | Change |
|---|---|
| `src/app/globals.css` | token swap §2.1, utility renames, scrollbar/focus recolor |
| `src/app/layout.tsx` | metadata title/description/keywords, themeColor navy |
| `src/components/tubeforge/logo.tsx` | gradient, subtitle, glow classes |
| `src/components/tubeforge/brand.tsx` | BRAND_GRADIENT, ForgeMark stops, BrandLockup wordmark (I3) |
| `src/components/tubeforge/auth-gate.tsx` | wordmark (I1) + gate copy de-automation |
| `src/app/login/page.tsx` | wordmark (I2) + copy |
| `src/components/tubeforge/app-sidebar.tsx` | 4-destination NAV, status card, active styles |
| `src/components/tubeforge/command-palette.tsx` | action label "New project"; views follow NAV_ITEMS |
| `src/app/page.tsx` | VIEW_META (Home/New Project/hubs), hub rendering, header CTA, footer |
| `src/lib/store.ts` | ViewId += `assets`, `insights` |
| `src/components/tubeforge/views/assets-hub.tsx` | NEW — tab host for cast/world/voice |
| `src/components/tubeforge/views/insights-hub.tsx` | NEW — tab host for analytics/research/calendar/channels |
| `src/components/tubeforge/views/dashboard-view.tsx` | B2 Home reframe (§4) |
| `src/components/tubeforge/views/library-view.tsx` | B2 Projects reframe (§5.1) |
| `src/components/tubeforge/views/create-view.tsx` | B2 format previews (§5.2) |
| `public/formats/*.jpg` | NEW — six generated format previews |
| `public/manifest.webmanifest`, `src/app/icon.svg` | theme/gradient regrade |
| `e2e/premium-ux.spec.ts`, `e2e/mobile-sweep.spec.ts` | deliberate selector updates (§9) |

Untouched by contract: all 136 API routes, `src/lib/**`, Prisma schema/migrations, the
compat-env/cookie seams, the 1008-test battery expectations.

---

## 8. Responsive & accessibility

- Breakpoints: 390 / 768 / 1024 / 1440 (mobile-sweep covers 390 today; B2 re-checks all
  four in browser).
- Sidebar → sheet under `lg`; hub tab strips horizontally scrollable on mobile; all
  interactive elements ≥ 44px on touch.
- Contrast: cyan primary on navy and dark-navy-on-cyan both AA; muted text stays ≥ 4.5:1
  (Stage-4a law); focus rings visible everywhere (`.tf-focusable` recolored, never
  suppressed).
- Semantic nav/heading structure unchanged (`nav[aria-label='Main navigation']` preserved —
  tests and screen readers anchor to it).

## 9. Acceptance criteria & test plan

1. **Identity**: grep `Tube|Forge` over `src/` returns only unrelated words (e.g. production
   prose), zero brand instances; setup screen, login page, sidebar, footer all read
   "TubeForge". Smoke spec title check unchanged (`/TubeForge/i`).
2. **IA**: sidebar renders exactly 5 destinations (4 + Settings) at 1440px and 390px; every
   legacy module reachable in ≤ 2 interactions; programmatic deep-jumps still land.
3. **Language**: dashboard/sidebar/footer/library empty-state copy matches §4–§5; grep for
   "Auto-Pilot|fully automated|Zero manual work" over user-facing components returns zero.
4. **Battery**: `npm test` → 1008/1008 (compat seams untouched).
5. **Typecheck/lint/build**: all green.
6. **E2E**: updated premium-ux + mobile-sweep green locally (Playwright boots its own
   server on :3000); the other 8 specs drive APIs and must stay green untouched.
7. **Browser re-inspection**: the §1 walk re-run post-change; screenshots archived; no
   red-orange brand pixels remain; no layout regressions at 390/1440.
8. **CI**: push → 8/8 checks green.

## 10. Execution record

Implemented 2026-11 (B1 + B2, single pass). Receipts per the §9 acceptance criteria:

1. **Identity**: `rg "Tube|Forge" src/ public/manifest.webmanifest` returns only
   YouTube-platform vocabulary (YouTube Data API, Audio Library) — zero TubeForge brand
   instances. Setup screen, login page, BrandLockup, sidebar, footer all read
   "TubeForge". The three stage-E wordmark escapes (I1–I3) are closed.
2. **IA**: sidebar renders exactly 5 destinations (Home, Projects, Assets, Insights,
   Settings) at 1440px and 390px; the legacy modules live in the Assets/Insights hubs
   (HubTabs); `activeNavId` maps child views to their destination; programmatic jumps
   (clone deep-link → voice) land in the hub with the right tab lit; palette gains
   pre-B1 vocabulary aliases (mission control, library, voice studio…).
3. **Language**: `rg "Auto-Pilot|fully automated|Zero manual work|faceless" src/components`
   → zero user-visible matches (internal `autopilot` variable names and code comments
   remain by design). Wizard launch copy: "Run full production"; export metadata
   `generatedBy: "TubeForge production"`; channels drop the "faceless" vocabulary.
4. **Battery**: `npm test` → **1008/1008** (the S155 create-view slice anchor follows the
   "Production complete" toast rename — the one deliberate battery-contract update).
5. **Typecheck/lint/build**: all green (build needs the dev server stopped in the 4 GB
   sandbox — it OOMs with the dev server resident; CI is unaffected).
6. **E2E**: full Playwright suite **37/37** against a Playwright-managed server (the S68
   raised write ceilings — running against a default-limits server re-manifests the
   known 429 flake). Deliberate spec updates: nav → destinations (Projects/Assets +
   tabs/Insights + tabs), "New Project" (exact-match), palette search term "continue"
   (unique), headings "Projects"/"Voice Studio" unchanged.
7. **Browser re-inspection**: 1440px + 390px walk re-run (screenshots under /tmp/inspect2,
   session artifact). Caught and fixed during the pass: hub root landing rendered a bare
   tab strip (HubTabs now resolves the first tab's panel); "Open Library" relabelled
   "Open Projects"; no horizontal overflow at 390px (scrollWidth 390).
8. **CI**: pending — poll after push.

New assets: `public/formats/{classic,story,whiteboard,graphics2d,character,slides}.jpg`
(generated via the Z.ai image API, navy/cyan-graded), `public/icons/*` regenerated from the
B1 brand geometry (`scripts/regen-icons.mjs`), `src/app/icon.svg` gradient fixed (the old
svg referenced a non-existent gradient id) and re-graded.
