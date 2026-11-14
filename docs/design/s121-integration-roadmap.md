# S121 — the unified integration roadmap: decision, landed slices, deferred list

Status: the INTEGRATE SELECTIVELY decision of the 2026-11-14 read-only audit
(`TUBEFORGE_UNIFIED_INTEGRATION_AUDIT.md`) turned into shipped, pinned code.
Audited heads: VoiceStudio `dd0f6bde` (v0.5.9-beta.2, AGPL-3.0) · Stickman
Video Director `1b73731f` (MIT) · TubeForge main `37796ce`.

## 1. The decision

- **VoiceStudio integrates as an optional, separately-deployed audio
  provider** reached over its OpenAI-compatible API — never embedded, never
  forked inside TubeForge. Headline wins: verified word-level ASR
  timestamps (`verbose_json` + `timestamp_granularities[]=word`, whisperx
  ±10-30 ms) upgrading captions and the W4 anchor ladder from DERIVED to
  MEASURED timing, and expressive multi-engine TTS behind TubeForge's
  existing `TtsRequest → ttsSynthesize` choke point.
- **Stickman Video Director contributes ALGORITHMS ONLY** — reimplemented
  independently in TypeScript (MIT source): word→cue caption grouping, the
  declarative scene-action semantics, the scene-scale-motion guard, the
  camera-keys model, two-bone planar IK, the contact/handoff timeline, the
  gait phase model, the evidence-bound review gate. No Autopilot port, no
  second renderer, no stickman art constraints. TubeForge's own Director
  stays the only orchestrator.
- **Rejected**: embedding VoiceStudio code (AGPL) into the product; using
  `commercial_use:false` weights commercially; adopting SVD's
  agent-driven "intelligence" as TubeForge's Director.

## 2. The licensing policy (executable)

`src/lib/tubeforge/providers/model-license-policy.ts` — FAIL-CLOSED: an
engine reaches a paying render only when its cited license record says
commercial use is safe. UNKNOWN = NOT SAFE. `omnivoice` (VoiceStudio's
DEFAULT engine, CC-BY-NC weights) can never bill by silence; pyannote
(HF-gated) fails closed by omission. Promoting an engine is a deliberate,
reviewed act — a new cited row, never a default, never an inference.

## 3. The measured-word timing law

`transcribeWords` (verify.ts) rides the DETAILED ASR pass over any-length
audio; chunked files shift word times by each chunk's MEASURED length
(never an assumed 25.000 s). `measuredAlignment` (captions.ts) is the ONE
computation both caption cues and the whiteboard's voice anchors read (the
one-alignment law). The ladder's rungs: measured word timestamps →
silence-run-refined proportional → the word-proportional estimator
BYTE-FOR-BYTE. Acceptance targets (live-service, deferred until a
VoiceStudio instance can contract-test): median ≤60 ms, p95 ≤120 ms
word-start error; transcript similarity ≥ 0.97 on clean audio.

## 4. The landed slices (P0–P2)

- **P0** `feat/audio` — the `asr` capability (follows tts until an `ai.asr`
  row is saved), the `voicestudio` TTS/ASR registry rows (port 3900, engine
  hints carry license verdicts), `asrTranscribeDetailed` (support table,
  verbose_json parsing with the untimed-token skip, the wire form, the
  error mapping 400/401/403/429/503, the bounded 503 ladder),
  `transcribeWords`/`shiftAsrWord`, the measured rung in captions +
  voice-anchors (baseline byte-identical when absent), the VoiceStudio
  clone lane (`remoteVoiceId`), the consent ledger schema
  (`consentText/consentRecordedAt/consentBasis`, the closed vocabulary),
  the TTS/ASR priors rows.
- **P1** `feat(director,qc,captions)` + `feat(voice)` — the semantic
  scene-action directives + `validateSceneAction` (every refusal names its
  reason) + `sceneScaleMotionFindings` ("camera movement does not count as
  acting") riding the critic's motion dimension; `measuredAlignment` (the
  one-alignment law) + `groupWordCues` (flush on >400 ms gap / 8 words /
  3.5 s / 58 chars / sentence punctuation; cue text stays the narration);
  the evidence-bound review gate (`canonicalJson` + `reviewEvidenceHash` +
  the stamped override — content-bound, backward-compatible); the consent
  ledger end-to-end (`parseCloneConsent` — the ONE consent decision — plus
  the clone-form UI and the card display).
- **P2** `feat(anim)` — the four PURE substrate modules (`anim/camera.ts`,
  `anim/ik.ts`, `anim/contact.ts`, `anim/gait.ts`) on the Stage-S substrate
  (`evalEase` — ONE motion feel), nothing importing them yet: the graphics
  acting slice (G1.6+) is the first consumer, gated on G1.5 merging + the
  blind re-score.

## 5. The DEFERRED list — with reasons

1. **Dubbing** (VoiceStudio `/dub/*`): the PURE client builders +
   auth/job-id laws landed (`providers/voicestudio-extra.ts`), but NO
   TubeForge job kind yet — the payload schemas and the `/dub/upload`
   multipart field names need a live server to contract-test (the
   never-guess law). Wiring point: a queue kind consuming the builders.
2. **Diarization** (pyannote 3.1 / Sortformer): rides the dub pipeline in
   practice; pyannote is HF-gated (fails closed in the license policy);
   deferred with dubbing until a live lane exists.
3. **Per-character voices** (per-character VoiceProfile mapping in the
   character bible + the episode-level consistency pin): the wiring point
   is the character bible → `voiceProfileProvider` routing, which already
   routes clones per owner — the mapping UI + the episode pin are the
   remaining work.
4. **Provider fallback chains**: REJECTED for now — a silent swap violates
   the no-silent-fallback law; an explicit user-consented chain is the
   only acceptable form (design pending).
5. **GPU pool (Option C) + utilization gates**: deferred until VoiceStudio
   usage evidence justifies the pool sizing ("1 worker per 5 GB, max 4" —
   audited).
6. **Per-provider real pricing tables**: the unverified-pricing law stands —
   placeholders stay labeled until UsageRecord evidence accumulates.
7. **Model-license review workflow (operator-side table superseding
   `unreviewed`)**: the fail-closed gate is live; the operator review UI is
   deferred until a second engine actually needs promotion.

## 6. Rollback law

Every slice is capability-config gated: an unset `ai.asr` row = today's
behavior byte-identical; the voicestudio rows are inert until configured;
the P2 modules have zero importers (zero behavioral risk); the schema
columns are additive and nullable. No grammar-breaking growth: the
G-series graphics grammar changes only via recorded design slices.

## 7. The deployment security posture (the operator half of the law)

Added after VoiceStudio's 2026-11-14 hardening landed (verified upstream:
`001470e` — the route-authorization census, "fail any mutating route that
ships without an authorization decision"; `9a46ebd` — consumer/admin
authorization gating the model-lifecycle routes; both confirmed by commit
query on the day of this edit). That hardening authorizes VoiceStudio's
HTTP mutating routes. It does NOT close the deployment surface: its own
`docs/api-auth.md` documents that `/ws/tts` and `/ws/events` ride API-key
middleware alone, and that with no `OMNIVOICE_API_KEY` configured remote
connections keep their bootstrap behavior — the HTTP share PIN does not
protect those lanes.

The integration's exposure is bounded by what TubeForge's client speaks:
HTTP only (`POST /v1/audio/speech`, the transcription lane, the deferred
`/dub/*` builders). TubeForge never touches VoiceStudio's WebSocket lanes
(`providers/voicestudio-extra.ts` + the TTS/ASR adapters are the whole
surface). But the transport posture is the operator's, not the code's, and
the deployment law for any server TubeForge reaches is therefore:

1. **Private network placement** — VoiceStudio listens only where
   TubeForge can reach it over a trusted network (loopback, VPC, VPN);
   never a public ingress. The client already assumes this shape: the
   default baseUrl is loopback (`127.0.0.1:3900`), and net-guard keeps
   everything ELSE (voice imports, media downloads) locked to public
   hosts regardless of env flags.
2. **`OMNIVOICE_API_KEY` set on any remote deployment** — the adapter
   rides `Authorization: Bearer` when a key is configured and runs
   keyless on loopback by design; keys never reach logs (`redactText`
   in `providerFetch`). An unauthenticated VoiceStudio reachable from
   outside its own host is a mis-deployment, not a fallback — the
   no-silent-fallback law applies to transport too.
3. **The two guards never substitute for each other** — the private
   network protects the SERVICE; the fail-closed model-license policy
   (§2) protects the RENDERS. A keyless engine behind a perfect firewall
   still cannot bill; a licensed engine on an open socket is still a
   compromised deployment. Both laws hold simultaneously.
