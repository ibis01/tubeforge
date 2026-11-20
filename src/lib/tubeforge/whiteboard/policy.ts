// P0 — the whiteboard lane's content-policy guard (the audit's I.8 gap +
// the plan's P0-7). The doctrine lives SYSTEM-LEVEL in
// restricted-subjects.ts (L1–L5 in the story/cinematic lane); the
// whiteboard lane had ZERO enforcement until the raster lane opened —
// arbitrary uploads AND AI generations would have carried unrestricted
// imagery into the drawing pipeline.
//
// The P0 guard is honest and additive (the plan's words): prompt
// constraint + refusal + provenance.
//   (a) CONSTRAINT — the generation prompt composes the operator's text
//       with the whiteboard style suffix AND the policy's visual rules;
//       the negative clause rides the providers that accept one.
//   (b) REFUSAL — a generation whose sanitized prompt still names a
//       restricted subject under the islamic-history policy is refused
//       with a readable reason (the sentence-level substitution already
//       rewrote what it could; what SURVIVED sanitization must not ride).
//   (c) PROVENANCE — the policy id rides the manifest row (asset-store
//       traced meta), so every generated asset names the policy it was
//       made under.
// Frame-level scan integration is P4 scope (the plan's own boundary).
//
// PURE module: no fs, no DB, no network — the route composes, the provider
// machinery dispatches, the store records.
import { imageGenerate } from "@/lib/tubeforge/providers/image";
import {
  policyNegativeClause,
  policyVisualRules,
  resolveContentPolicy,
  sanitizePromptForPolicy,
  scanRestrictedSubjects,
  type ContentPolicyId,
} from "@/lib/tubeforge/restricted-subjects";

/** The whiteboard style suffix — traced-output quality is a prompt-shaped
 *  problem before it is an algorithm problem (the plan's words): line art,
 *  black ink on white, no shading gradients. */
export const WHITEBOARD_STYLE_SUFFIX =
  "Style: clean black line art on a pure white background, outline drawing only, no shading, no gradients, no color fills, no photograph — a whiteboard illustration that can be drawn with a marker.";

/** Compose the generation prompt for one video's policy: the operator's
 *  prompt sanitized for the policy (sentence-level substitution), then the
 *  policy's negative clause, then the whiteboard style suffix, then the
 *  policy's visual rules. Deterministic. */
export function composeWhiteboardPrompt(rawPrompt: string, policy: ContentPolicyId): string {
  // sanitizePromptForPolicy appends the negative clause itself by default;
  // compose the clauses HERE instead so the whiteboard style suffix lands
  // in a known position (the provider sees one coherent prompt).
  const sanitized = sanitizePromptForPolicy(rawPrompt.trim(), policy, { appendNegative: false });
  const clauses = [sanitized.prompt];
  const negative = policyNegativeClause(policy);
  if (negative) clauses.push(negative);
  clauses.push(WHITEBOARD_STYLE_SUFFIX);
  const rules = policyVisualRules(policy);
  if (rules) clauses.push(rules);
  return clauses.filter(Boolean).join(" ");
}

export interface WhiteboardGenerationGuard {
  ok: boolean;
  /** The composed prompt (present when ok). */
  prompt?: string;
  /** The negative clause for the providers that accept one. */
  negativePrompt?: string;
  /** The readable refusal (present when !ok). */
  error?: string;
}

/** The P0-7 gate: compose + refuse. `prompt` is the operator's raw text;
 *  the returned prompt is what the provider receives. */
export function guardWhiteboardGeneration(rawPrompt: string, policyRaw: string | null | undefined): WhiteboardGenerationGuard {
  const policy = resolveContentPolicy(policyRaw);
  const prompt = composeWhiteboardPrompt(rawPrompt, policy);
  const negative = policyNegativeClause(policy);
  // (b) — what SURVIVED sanitization must not name a restricted subject.
  // scanRestrictedSubjects matches figure aliases; a hit AFTER substitution
  // means the operator tried to sneak the subject through composition.
  const hits = scanRestrictedSubjects(prompt, policy);
  if (hits.length > 0) {
    return {
      ok: false,
      error: `the prompt names a restricted subject (${hits
        .map((h) => h.alias)
        .slice(0, 3)
        .join(", ")}) under the ${policy} content policy — rephrase the illustration request around the activity, the architecture or the setting instead`,
    };
  }
  return { ok: true, prompt, negativePrompt: negative || undefined };
}

/** The AI bridge dispatch — the plan's "deliberately THIN bridge": the
 *  story lane's provider machinery reused exactly, no whiteboard-owned
 *  image model. Exported so the bridge route stays a thin shell. */
export function generateWhiteboardIllustration(prompt: string, negativePrompt: string | undefined, size: string): Promise<Buffer> {
  return imageGenerate({ prompt, size, ...(negativePrompt ? { negativePrompt } : {}) });
}
