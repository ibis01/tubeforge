// model-license-policy.ts — the model-license gate as executable data.
//
// THE LAW (fail-closed): a model/engine may reach a PAYING render only when
// its license record says commercial use is safe. UNKNOWN = NOT SAFE — an
// engine added by silence can never bill, and omnivoice (the VoiceStudio
// DEFAULT engine, CC-BY-NC weights) can never reach a paying render by
// silence. This is the unreviewed-pricing law's sibling: pricing refuses to
// price what no one reviewed; this gate refuses to bill what no one
// licensed. Every row carries its evidence (the audit citation string);
// promoting an engine to "commercial-ok" is a deliberate, reviewed act — a
// new cited row in the tables below, never a default, never an inference.
//
// Provenance: the audited VoiceStudio engine registry (20+ engines,
// v0.5.9-beta.2). The audited VoiceStudio model_licenses.json lists
// commercial_use:false across its whole catalog; TubeForge's policy tracks
// only the engines TubeForge's registry names — omnivoice is the
// non-commercial row (cc-by-nc-4.0). pyannote (HF-gated restricted weights)
// is deliberately ABSENT from every table: it fails closed by omission.

/** The three possible licensing verdicts for an engine. */
export type ModelLicenseVerdict = "commercial-ok" | "non-commercial" | "unreviewed";

/** One engine's license row — evidence is the audit citation string. */
export interface ModelLicenseRecord {
  engine: string;
  verdict: ModelLicenseVerdict;
  license: string;
  evidence: string;
}

const AUDIT_CITATION = "VoiceStudio model_licenses.json, audited 2026-11-14";

/**
 * TTS engines whose license record says commercial use is safe (permissive,
 * audited). A row lands here only with a cited license record — silence
 * never promotes an engine into this table.
 */
export const COMMERCIAL_OK_ENGINES: ModelLicenseRecord[] = [
  { engine: "voxcpm2", verdict: "commercial-ok", license: "apache-2.0", evidence: AUDIT_CITATION },
  { engine: "cosyvoice", verdict: "commercial-ok", license: "apache-2.0", evidence: AUDIT_CITATION },
  { engine: "kittentts", verdict: "commercial-ok", license: "apache-2.0", evidence: AUDIT_CITATION },
  { engine: "moss", verdict: "commercial-ok", license: "apache-2.0", evidence: AUDIT_CITATION },
  { engine: "dots", verdict: "commercial-ok", license: "apache-2.0", evidence: AUDIT_CITATION },
  { engine: "indextts2", verdict: "commercial-ok", license: "apache-2.0", evidence: AUDIT_CITATION },
  { engine: "confucius4", verdict: "commercial-ok", license: "apache-2.0", evidence: AUDIT_CITATION },
  { engine: "supertonic3", verdict: "commercial-ok", license: "openrail-m", evidence: AUDIT_CITATION },
  { engine: "ming", verdict: "commercial-ok", license: "mit", evidence: AUDIT_CITATION },
  { engine: "gpt-sovits", verdict: "commercial-ok", license: "mit", evidence: AUDIT_CITATION },
];

/**
 * Engines whose license record forbids commercial use. omnivoice is the
 * VoiceStudio DEFAULT engine — it can never reach a paying render by
 * silence: absent a deliberate re-license WITH evidence, it stays here.
 * (The audited model_licenses.json lists commercial_use:false across its
 * catalog; any engine row that arrives with commercial_use:false belongs in
 * this table by the same law, with evidence.)
 */
export const NON_COMMERCIAL_ENGINES: ModelLicenseRecord[] = [
  {
    engine: "omnivoice",
    verdict: "non-commercial",
    license: "cc-by-nc-4.0",
    evidence:
      'VoiceStudio model_licenses.json, audited 2026-11-14 (commercial_use:false); the repo states "No commercial clearance is asserted"',
  },
];

/**
 * ASR engines — an explicit table, NOT inherited from the TTS rows; all
 * audited commercial-safe. pyannote (HF-gated restricted weights) is
 * deliberately absent — it fails closed by omission (unreviewed) and must
 * not be added here without its own cited license record.
 */
export const ASR_COMMERCIAL_OK_ENGINES: ModelLicenseRecord[] = [
  {
    engine: "whisperx",
    verdict: "commercial-ok",
    license: "bsd-4-clause (audited as permissive BSD/Apache family)",
    evidence: AUDIT_CITATION,
  },
  { engine: "faster-whisper", verdict: "commercial-ok", license: "mit", evidence: AUDIT_CITATION },
  { engine: "mlx-whisper", verdict: "commercial-ok", license: "mit", evidence: AUDIT_CITATION },
  { engine: "pytorch-whisper", verdict: "commercial-ok", license: "mit", evidence: AUDIT_CITATION },
  { engine: "nemo-parakeet", verdict: "commercial-ok", license: "apache-2.0", evidence: AUDIT_CITATION },
  { engine: "moonshine", verdict: "commercial-ok", license: "mit", evidence: AUDIT_CITATION },
  { engine: "funasr", verdict: "commercial-ok", license: "mit", evidence: AUDIT_CITATION },
  { engine: "sherpa-onnx", verdict: "commercial-ok", license: "apache-2.0", evidence: AUDIT_CITATION },
];

/**
 * Canonical engine id: lowercase, trimmed, inner runs of whitespace,
 * hyphens and underscores collapsed to a single hyphen, edge separators
 * stripped — case/space-tolerant lookups (" OMNIVOICE ", "gpt_sovits" and
 * "GPT-SOVITS" all normalize onto their table rows). Pure: no fetch, no
 * clock.
 */
export function normalizeEngineId(engine: string): string {
  return engine
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SAFE_BY_ID: ReadonlyMap<string, ModelLicenseRecord> = new Map(
  [...COMMERCIAL_OK_ENGINES, ...ASR_COMMERCIAL_OK_ENGINES].map(
    (row) => [normalizeEngineId(row.engine), row] as const,
  ),
);

const NON_COMMERCIAL_BY_ID: ReadonlyMap<string, ModelLicenseRecord> = new Map(
  NON_COMMERCIAL_ENGINES.map(
    (row) => [normalizeEngineId(row.engine), row] as const,
  ),
);

function licenseRecordFor(engine: string): ModelLicenseRecord | null {
  const id = normalizeEngineId(engine);
  return NON_COMMERCIAL_BY_ID.get(id) ?? SAFE_BY_ID.get(id) ?? null;
}

/**
 * Normalize, then classify. Listed safe (TTS or ASR table) → "commercial-ok";
 * listed non-commercial → "non-commercial"; anything else → "unreviewed".
 * FAIL-CLOSED: unreviewed engines are not commercial safe until added
 * deliberately with a cited license record — an engine added by silence can
 * never bill. The non-commercial table is checked FIRST so a data mistake
 * (an engine somehow in both tables) fails closed too.
 */
export function engineLicenseVerdict(engine: string): ModelLicenseVerdict {
  const id = normalizeEngineId(engine);
  if (!id) return "unreviewed"; // a blank / separator-only id fails closed
  if (NON_COMMERCIAL_BY_ID.has(id)) return "non-commercial";
  if (SAFE_BY_ID.has(id)) return "commercial-ok";
  return "unreviewed";
}

/** The gate itself: true only for a "commercial-ok" verdict. */
export function isCommercialSafe(engine: string): boolean {
  return engineLicenseVerdict(engine) === "commercial-ok";
}

/**
 * Human-readable refusal for a non-safe engine — names the engine, its
 * verdict and its license (or the absence of one), and points at the
 * roadmap doc where the gate's law is written down.
 */
export function licenseGateRefusal(engine: string): string {
  const raw = engine.trim();
  const verdict = engineLicenseVerdict(raw);
  const license = licenseRecordFor(raw)?.license ?? "no cited license record";
  return `engine '${raw}' is ${verdict} (${license}) — it cannot reach a paying render without the operator's own license review; see docs/design/s121-integration-roadmap.md`;
}
