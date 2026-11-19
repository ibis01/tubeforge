# TubeForge — B3 Production Workspace Specification

Status: SPECIFIED (implemented in this pass; execution record in §8) · Author: design/engineering session
Scope: the unified per-project production workspace — B3 of the B1 design specification
(`B1_DESIGN_SPECIFICATION.md` §6 recorded the direction; this document commits the build).

Related: `TUBEFORGE_DESIGN_KICKOFF.md` (bootstrap), `B1_DESIGN_SPECIFICATION.md` (B1+B2).

---

## 0. Exit condition

**A creator can inspect and revise individual scenes without leaving the project.**

Concretely: opening a project lands on a full-page workspace (not a dialog) where every
stage of the production line — brief, script, storyboard, scene art, timeline, QC, ship —
is reachable in one surface, and scene-level inspection + revision (art, narration,
captions, style, continuity, re-rolls) happens inline.

---

## 1. From dialog to workspace

The B2 pass kept the detail dialog (`video-detail-dialog.tsx`, 4.4k lines: Package · Script ·
Storyboard · Video) as the production surface. B3 promotes it: the dialog chrome is retired
and its interior becomes **the production workspace** — a first-class full-page destination.

- New file: `src/components/tubeforge/production-workspace.tsx` (git-mv of the dialog file;
  the two S119/S151 source-contract pins follow the file).
- New view: `workspace` (ViewId). Not a sidebar destination, not a hub tab — it is opened
  **per project** from: Projects cards, Home (continue row + recent projects), the ⌘K
  palette (recent videos), Create ("open the workspace" on success), Topic Radar greenlight,
  Calendar slots, Analytics rows, Cast recent videos.
- The dialog component and its library-view mount are deleted; `SceneEditorDialog` becomes
  `SceneStudioPanel` (the same engine, inline — see §3).

Language law carries over: no automation nouns; the workspace copy speaks creator-control
("You direct · AI assists").

## 2. Workspace layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [← Projects]  (badges: status · niche · host · format · MP4 · live)      │
│               Project title (h2)                                         │
│               words · length · voice · channel                           │
├──────────────────────────────────────────────────────────────────────────┤
│ ProductionBoard (S91) — stages · checkpoints · costs · history           │
│                             ← the visible approval line                  │
├──────────────────────────────────────────────────────────────────────────┤
│ Director      Storyboard      Canvas      Timeline      Inspector        │ ← workspace areas
├──────────────────────────────────────────────────────────────────────────┤
│ (area content — full page width, no dialog caps)                         │
└──────────────────────────────────────────────────────────────────────────┘
```

Area map (the four dialog tabs regrouped into the five B1 areas; no engine rewrite):

| Workspace area | Carries | Was |
|---|---|---|
| **Director** | research sources, script editor / per-scene beats, narrative structure + emotional progression, pacing strip, Hook lab, ASR accuracy check | Script tab |
| **Storyboard** | DirectorCard (shot plan), scene grid / filmstrip, density toggle, generate actions; WhiteboardStudio / GraphicsStudio own the area for their lanes | Storyboard tab |
| **Canvas** | NEW — scene-focused art surface: scene rail (thumbnail strip) + `SceneStudioPanel` inline (style · prompt · AI edit · upload · Before/After compare · continuity panel) | SceneEditorDialog (nested dialog) |
| **Timeline** | TimelineStudio, render controls (mode, captions, export presets), music/motion/transition pickers, brand kit, render actions, QC scorecard + ship gate, CriticCard, final video, Auto-Short, export bundle | Video tab |
| **Inspector** | voiceover + voice panel (TTS/clone/upload/URL), engagement kit, description, tags, Thumbnail A/B lab, ship actions (voice/thumbnail/schedule/export/publish/retention), delete | Package tab + dialog footer |

Rules:
- **Lane law** (kept): `renderMode === "whiteboard"` / `"graphics"` → the Storyboard area is
  owned by WhiteboardStudio / GraphicsStudio; Canvas shows a pointer card to the owning
  studio (scene art editing is the studio's job in those lanes).
- **Format law** (kept): classic narration projects (no scenes) get two areas — Director ·
  Inspector — with the "Make it a scene video" convert upsell in Inspector. Scene formats
  get all five.
- The storyboard grid's "Edit scene" action now lands the creator on **Canvas** with that
  scene selected (was: opening a nested dialog). Default area: Timeline when a video/voice
  exists, Director otherwise (the S86 controlled-tab law, new area ids).
- Scene rail on Canvas: one thumbnail per scene (current take highlighted), keyboard
  reachable, 44px touch targets.

## 3. Scene Studio, inline

`scene-editor.tsx`: `SceneEditorDialog` (Dialog wrapper) → `SceneStudioPanel` (inline
surface with the same four editing ways and the S77 continuity panel). `open/onOpenChange`
props die; state reseeds on scene change (guarded seed compare, now scene-only); the
Before/After compare tracks image transitions while the scene is displayed. No logic
changes — PATCH/reroll/AI-edit/upload endpoints and their error-honesty behavior unchanged.

## 4. Store & navigation

- `ViewId` += `"workspace"` (all existing ids preserved — zero breakage).
- `focusVideoId` semantics: "open this project in the production workspace" (was "open the
  detail dialog"). Every producer of `focusVideoId` now pairs it with `setView("workspace")`.
- `activeNavId("workspace")` → `"library"` (the sidebar highlights Projects while the
  workspace is open).
- The header "New Project" CTA is hidden on the workspace (focused surface, same law as
  Create/Settings).

## 5. Copy (language-law compliant)

- Back control: "Projects" (returns to the Projects destination).
- Canvas empty states: "Pick a scene above — its art, prompt and continuity live here."
- Whiteboard/graphics Canvas pointer: "The Whiteboard Studio owns scene editing for this
  format — open the Storyboard area." / "…Graphics Studio…"
- Palette/research/calendar/cast/analytics/create labels: "Open in workspace" / "Open
  workspace" vocabulary.

## 6. Component inventory (files touched by B3)

| File | Change |
|---|---|
| `src/components/tubeforge/video-detail-dialog.tsx` → `production-workspace.tsx` | git-mv; dialog chrome retired; 5-area workspace layout; Canvas area; header; footer folded into Inspector |
| `src/components/tubeforge/scene-editor.tsx` | SceneEditorDialog → SceneStudioPanel (inline) |
| `src/components/tubeforge/views/workspace-view.tsx` | NEW — per-project view host (loads the video, renders the workspace, error/empty states) |
| `src/components/tubeforge/views/library-view.tsx` | cards open the workspace; dialog mount removed |
| `src/components/tubeforge/views/{dashboard,create,research,calendar,cast,analytics}-view.tsx`, `command-palette.tsx` | entry rewiring to the workspace |
| `src/lib/store.ts` | ViewId += workspace; focusVideoId comment |
| `src/app/page.tsx` | VIEW_META + lazy WorkspaceView + CTA gate |
| `src/components/tubeforge/app-sidebar.tsx` | activeNavId workspace → library |
| `e2e/premium-ux.spec.ts`, `e2e/mobile-sweep.spec.ts` | deliberate flow updates (dialog → workspace) |
| `scripts/test-unit.mts` | the two S119/S151 file pins follow the rename; new B3 source-pin suite |

Untouched by contract: all API routes, `src/lib/**` engines (scene-revisions, poll, qc,
qc-policy), Prisma schema/migrations, the compat seams.

## 7. Acceptance criteria & test plan

1. **Surface**: opening any project renders the full-page workspace with the five areas
   (two for classic); no Dialog chrome; back control returns to Projects.
2. **Canvas**: picking a scene shows its art + SceneStudioPanel inline; storyboard
   "Edit scene" lands there; Before/After compare + continuity panel work.
3. **Lanes/format**: whiteboard & graphics own Storyboard; classic shows Director+Inspector
   with the convert upsell.
4. **Entries**: Projects/Home/palette/create/research/calendar/cast/analytics all land on
   the workspace with the right project.
5. **Language**: workspace copy greps clean of automation nouns.
6. **Battery**: `npm test` green (S119/S151 pins re-pointed; new B3 suite).
7. **Typecheck/lint/build**: green.
8. **E2E**: premium-ux + mobile-sweep updated flows green; the other specs untouched.
9. **Browser re-inspection**: 1440px + 390px walk of the workspace; no overflow; sticky
   footer law holds.
10. **CI**: push → 8/8 checks green.

## 8. Execution record

Implemented 2026-11 (single pass). Receipts per §7:

1. **Surface**: the walk opened the walk-seeded story project — full-page workspace at
   1440px and 390px: header (back control, badges, title, meta), ProductionBoard
   approval line, five areas (screenshots under /tmp/b3walk, session artifacts;
   re-runnable via `scripts/b3-walk.sh` + `scripts/seed-walk.mts`). No Dialog chrome
   anywhere in the surface; the sticky footer law holds at both widths.
2. **Canvas**: the scene rail renders one thumbnail per scene (picked take glows);
   `Scene 1 Studio` hosts inline with style/prompt/AI-edit/upload, Before/After compare
   and the S77 continuity panel ("History, checks & approval"). The storyboard's
   **Edit scene** lands Canvas with the scene picked (receipt 52); the rail re-picks
   (scene 3 → "Scene 3 Studio", receipt 53). The walk seeded scenes WITHOUT art on
   purpose — the "no art yet" tiles are part of the verified layout.
3. **Lanes/format**: whiteboard/graphics Canvas pointer cards name the owning studio
   (pinned); classic format gets Director + Inspector (the e2e clone deep-link drives
   Inspector through the voice panel).
4. **Entries**: Projects cards, Home continue row ("Resume production"), palette
   recent videos, Create success, Topic Radar greenlight, Calendar slots, Analytics
   rows, Cast recent videos — all verified to pair `setFocusVideoId` with
   `setView("workspace")` (battery pin; the Home row exercised in the browser).
5. **Language**: residual scans clean — the walk CAUGHT one escape the B2 grep list
   missed: the Narrative profile's user-facing blurb still read "The faceless-YouTube
   classic" (now "The classic narration-first studio"); a new battery pin sweeps ALL
   profile blurbs for legacy vocabulary. Internal `autopilot` identifiers remain by
   design (B1 law).
6. **Battery**: `npm test` → **1013/1013** (1008 + five B3 pins; the two S119/S151
   file pins re-pointed to the renamed production-workspace.tsx with their
   error-honesty strings intact).
7. **Typecheck/lint/build**: all green.
8. **E2E**: full Playwright suite **37/37** against a Playwright-managed server.
   Deliberate spec updates: premium-ux's two detail-dialog flows ride the workspace
   (Director autosave; Inspector → voice panel → Voice Studio deep-link), mobile-sweep's
   dialog-fit check became the workspace-at-390px overflow check (scrollWidth 390).
9. **Browser re-inspection**: 1440px + 390px walks (walk.sh receipts); no layout
   regressions, no horizontal overflow, area strip scrolls horizontally at 390px.
10. **CI**: pending push — recorded at close.
