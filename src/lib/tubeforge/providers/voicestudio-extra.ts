// voicestudio-extra.ts — the dub client for VoiceStudio's audited /dub route set.
//
// S121 P3/P4 substrate — TubeForge orchestration over a USER-MANAGED
// VoiceStudio server's audited dub/diarization route set, and the
// model-license gate as executable data (model-license-policy.ts).
// VoiceStudio is a separate, optional, AGPL service — TubeForge talks its
// OpenAI-compatible HTTP API only and never bundles it (the AGPL law).
//
// NO TubeForge job kind is created here — these are client builders only.
// The dub lane is deferred until a live server can contract-test it: the
// job-id payload shapes below are the three observed in the audited repo
// (v0.5.9-beta.2) and the upload route's multipart field names are
// unconfirmed, so nothing in this module constructs a dub job or guesses a
// request schema. The pure builders (dubUrl / dubAuthHeaders / parseDubJobId /
// dubUploadRequest) do no I/O and read no clock; the thin wrappers only
// compose them and call the shared providerFetch plumbing in ./http.
//
// Audited route + auth facts this module pins (VoiceStudio v0.5.9-beta.2):
//   • POST /dub/upload               multipart upload or {url} ingest
//     GET  /dub/transcribe/{job_id}  poll — transcription pass
//     GET  /dub/generate/{job_id}    poll — dub generation pass
//     GET  /dub/download/{job_id}    binary result (+variants as query params)
//     GET  /dub/srt/{job_id}         SRT subtitles
//     GET  /dub/vtt/{job_id}         VTT subtitles
//     Default port 3900.
//   • Auth: loopback servers run KEYLESS (no Authorization header); remote
//     servers take `Authorization: Bearer $OMNIVOICE_API_KEY`.
//   • Job-id payloads were observed in THREE shapes: {"job_id": "..."},
//     {"id": "..."}, {"job": {"id": "..."}}.

import { joinUrl, providerFetch, providerFetchJson } from "./http";

// -------------------------------------------------------------- route table

/** The audited dub route set — the ONLY paths this client may build. */
export type VoiceStudioDubRoute =
  | "/dub/upload"
  | "/dub/transcribe"
  | "/dub/generate"
  | "/dub/download"
  | "/dub/srt"
  | "/dub/vtt";

const DUB_ROUTES: readonly VoiceStudioDubRoute[] = [
  "/dub/upload",
  "/dub/transcribe",
  "/dub/generate",
  "/dub/download",
  "/dub/srt",
  "/dub/vtt",
];

/**
 * Refusal error for the dub client. Every refusal NAMES its reason in the
 * message (house law); callers can catch this class to surface the reason
 * verbatim in the activity feed.
 */
export class VoiceStudioDubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceStudioDubError";
  }
}

// ------------------------------------------------------------ pure builders

/**
 * Join a dub route (and, where the route carries one, the job id) onto the
 * server base URL: trailing slashes on the base are stripped and segments
 * are joined with single slashes; the job id is percent-encoded as one path
 * segment so a crafted id cannot escape the route.
 *
 * Refusals (each a VoiceStudioDubError naming its reason):
 *   • a blank base URL;
 *   • a route outside the audited set (guards JS callers casting junk);
 *   • a job id absent/blank on /dub/transcribe|generate|download|srt|vtt
 *     (all five are job-scoped);
 *   • a job id supplied to /dub/upload (the upload creates the job — the
 *     server assigns the id afterwards).
 *
 * Pure: no fetch, no clock.
 */
export function dubUrl(
  baseUrl: string,
  route: VoiceStudioDubRoute,
  jobId?: string,
): string {
  if (!DUB_ROUTES.includes(route)) {
    throw new VoiceStudioDubError(
      `dubUrl: "${String(route)}" is not one of the audited dub routes (${DUB_ROUTES.join(", ")})`,
    );
  }
  const base = baseUrl.trim();
  if (!base) {
    throw new VoiceStudioDubError(
      "dubUrl: the VoiceStudio base URL is blank — set the provider's base URL (default port 3900, e.g. http://127.0.0.1:3900) before building a dub route",
    );
  }
  const id = (jobId ?? "").trim();
  if (route === "/dub/upload") {
    if (id) {
      throw new VoiceStudioDubError(
        `dubUrl: the upload route takes no job id — POST /dub/upload creates the job and the server assigns the id afterwards (got "${id}")`,
      );
    }
    return joinUrl(base, route);
  }
  if (!id) {
    throw new VoiceStudioDubError(
      `dubUrl: route "${route}" is job-scoped and the job id is blank or absent — transcribe/generate/download/srt/vtt all need the id the server assigned at upload`,
    );
  }
  return joinUrl(base, route, encodeURIComponent(id));
}

/**
 * THE LAW (pinned): a loopback baseUrl (localhost, *.localhost, 127.x, [::1])
 * NEVER carries an Authorization header — the server runs keyless there. A
 * blank/absent key NEVER carries one. Anything else rides exactly
 * `{ Authorization: "Bearer <key>" }` and nothing else.
 *
 * The loopback set is deliberately literal to the audit (localhost, 127.x,
 * [::1], *.localhost — a trailing DNS dot is tolerated). Anything the law
 * does not name (0.0.0.0, LAN addresses, …) is treated as REMOTE and takes
 * the key: misclassifying a remote host as loopback would leak the key,
 * while the reverse only sends a header a keyless server ignores.
 *
 * A non-blank key against a base URL that is blank/unparsable/non-http(s) is
 * refused with a named VoiceStudioDubError — the loopback-vs-remote law
 * needs a parsable http(s) URL to classify, and guessing would risk leaking
 * the key. Pure: no fetch, no clock.
 */
export function dubAuthHeaders(
  baseUrl: string,
  apiKey: string | null | undefined,
): Record<string, string> {
  const key = apiKey?.trim() ?? "";
  if (!key) return {}; // law 2 — a blank/absent key never rides, whatever the host
  const url = parseHttpBaseUrl(baseUrl);
  if (isLoopbackHost(url.hostname)) return {}; // law 1 — loopback servers run keyless
  return { Authorization: `Bearer ${key}` }; // law 3 — remote servers take the key
}

/** Parse an http(s) base URL or refuse — the auth law cannot classify junk. */
function parseHttpBaseUrl(baseUrl: string): URL {
  const base = baseUrl.trim();
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new VoiceStudioDubError(
      `dubAuthHeaders: the VoiceStudio base URL is blank or unparsable ("${base ? base.slice(0, 120) : "<blank>"}") — the loopback-vs-remote auth law needs a parsable http(s) URL`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new VoiceStudioDubError(
      `dubAuthHeaders: the VoiceStudio base URL must be http(s), got "${url.protocol}" — refusing to classify the Authorization header on an unknown scheme`,
    );
  }
  return url;
}

/** Exactly the audited loopback set; see dubAuthHeaders for why it is literal. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("127.") ||
    host === "::1"
  );
}

/**
 * Defensive job-id extraction across the THREE payload shapes observed in
 * the audited repo: `{"job_id": "..."}`, `{"id": "..."}` and
 * `{"job": {"id": "..."}}`. Returns the id only when one of those shapes
 * yields a non-empty string — a number id, a nested miss or junk input
 * returns null. NEVER guesses: an unparsed payload can never become an id
 * by coercion. Pure: no fetch, no clock.
 */
export function parseDubJobId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const direct = nonEmptyString(payload.job_id) ?? nonEmptyString(payload.id);
  if (direct !== null) return direct;
  if (isRecord(payload.job)) return nonEmptyString(payload.job.id);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// ------------------------------------------------------- thin fetch wrappers

/** Label used in providerFetch errors — names the provider and the lane. */
const DUB_PROVIDER_LABEL = "VoiceStudio dub";

/**
 * Everything the thin wrappers need: the user-managed server's base URL and
 * the optional remote key (loopback servers run keyless — dubAuthHeaders
 * pins that law).
 */
export interface DubRequestContext {
  baseUrl: string;
  apiKey?: string | null | undefined;
}

/**
 * Poll payloads are typed as an opaque record ON PURPOSE: the response
 * schema is unconfirmed until a live server contract-tests the lane (the
 * dub lane is deferred — see the module header). Use parseDubJobId to pull
 * the job id out of whatever shape the server answered with.
 */
export type DubJobStatusPayload = Record<string, unknown>;

function dubPoll(
  route: VoiceStudioDubRoute,
  ctx: DubRequestContext,
  jobId: string,
): Promise<DubJobStatusPayload> {
  return providerFetchJson<DubJobStatusPayload>(
    DUB_PROVIDER_LABEL,
    dubUrl(ctx.baseUrl, route, jobId),
    { method: "GET", headers: dubAuthHeaders(ctx.baseUrl, ctx.apiKey) },
    { capability: "generic" },
  );
}

/** GET /dub/transcribe/{job_id} — poll the transcription pass (generic timeout). */
export function dubTranscribePoll(
  ctx: DubRequestContext,
  jobId: string,
): Promise<DubJobStatusPayload> {
  return dubPoll("/dub/transcribe", ctx, jobId);
}

/** GET /dub/generate/{job_id} — poll the dub generation pass (generic timeout). */
export function dubGeneratePoll(
  ctx: DubRequestContext,
  jobId: string,
): Promise<DubJobStatusPayload> {
  return dubPoll("/dub/generate", ctx, jobId);
}

/**
 * GET /dub/download/{job_id} — the binary dub result, under the
 * download-capability timeout law (capability "download" in ./http — a full
 * dub is a big render). The audited (+variants) form rides as query params
 * the caller appends (e.g. ?variant=instrumental); the route literal stays
 * the audited path. Returns the Response so the caller can stream it.
 */
export function dubDownload(
  ctx: DubRequestContext,
  jobId: string,
): Promise<Response> {
  return providerFetch(
    DUB_PROVIDER_LABEL,
    dubUrl(ctx.baseUrl, "/dub/download", jobId),
    { method: "GET", headers: dubAuthHeaders(ctx.baseUrl, ctx.apiKey) },
    { capability: "download" },
  );
}

/**
 * POST /dub/upload — pure request-target helper ONLY; there is deliberately
 * no dubUpload fetch wrapper. Why: the route takes either a multipart file
 * upload or a {url} ingest, and the multipart field names are unconfirmed in
 * the audited repo (v0.5.9-beta.2) — guessing them would violate the
 * never-guess law, and the dub lane is deferred until a live server can
 * contract-test it (see the module header). No new dependencies may be
 * installed to fake the missing contract, so callers compose this helper's
 * url + headers themselves when the lane lands.
 */
export function dubUploadRequest(
  baseUrl: string,
  apiKey: string | null | undefined,
): { url: string; headers: Record<string, string> } {
  return { url: dubUrl(baseUrl, "/dub/upload"), headers: dubAuthHeaders(baseUrl, apiKey) };
}
