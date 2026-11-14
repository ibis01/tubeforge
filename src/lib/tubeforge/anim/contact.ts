// anim/contact — the contact/handoff ownership timeline: who holds what,
// enforced by simulation.
//
// Provenance: these are algorithms worth having from the "Stickman Video
// Director" project (MIT-licensed source, audited 2026-11-14),
// REIMPLEMENTED independently in TypeScript (no code copied). This is
// S121 P2 of the unified integration roadmap — the shared Stage-X motion
// primitives the graphics/character lanes build on.
//
// Laws. S64 purity: every function is PURE — no fs, no clock, no
// randomness, no globals; same inputs → same outputs, always. Ownership
// is a legal-transfer model: an object is grabbed only while unheld,
// released only by its current holder, and handed off only by its current
// holder to a DIFFERENT subject — every other flow is refused with the
// subject, object, and t named (never a bare "invalid"). Equal-t events
// are legal and apply in array order — the deterministic tie-break (the
// narrative order), so the walk never depends on sort stability.
// contactOwnersAt is a pure replay (fresh Map, events never mutated) and
// trusts its precondition: the timeline already passed
// validateContactTimeline.

export type ContactEventKind = "grab" | "release" | "handoff";

/** One beat of contact: `t` in seconds. grab — the subject takes the
 *  object; release — the subject lets go; handoff — the subject passes
 *  the object `to` another subject (a single event that legally
 *  transfers ownership mid-beat). */
export interface ContactEvent {
  t: number;
  kind: ContactEventKind;
  subject: string;
  object: string;
  to?: string;
}

/** Validate the whole timeline in one pass: events must ascend by t
 *  (strictly-decreasing pairs are refused, naming both events; equal t
 *  is legal and applies in array order), and the ownership walk must be
 *  legal at every step:
 *  - grab: the object must be unheld (an object cannot be grabbed twice
 *    — the current holder is named);
 *  - release: the subject must BE the current holder ("X cannot release
 *    Y at t — Z holds it"; releasing nothing is refused too);
 *  - handoff: the subject must be the current holder, `to` must be
 *    present and non-blank, and `to` ≠ subject (a handoff to oneself is
 *    a no-op refused).
 *  Every refusal is "contact timeline refused: ..." naming subject,
 *  object, and t. End: every event legal = OK. */
export function validateContactTimeline(events: ContactEvent[]): void {
  let prevT = -Infinity;
  const holders = new Map<string, string>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!Number.isFinite(e.t)) {
      throw new Error(`contact timeline refused: event ${i} carries a non-finite t (${String(e.t)})`);
    }
    if (e.t < prevT) {
      throw new Error(
        `contact timeline refused: events must ascend by t — event ${i} (${e.subject} ${e.kind} "${e.object}" at t=${String(e.t)}) precedes event ${i - 1} (t=${String(prevT)})`,
      );
    }
    prevT = e.t;
    if (
      typeof e.subject !== "string" ||
      e.subject.length === 0 ||
      typeof e.object !== "string" ||
      e.object.length === 0
    ) {
      throw new Error(
        `contact timeline refused: event ${i} (${e.kind} at t=${String(e.t)}) carries a blank subject or object`,
      );
    }
    if (e.kind !== "grab" && e.kind !== "release" && e.kind !== "handoff") {
      throw new Error(
        `contact timeline refused: event ${i} carries an unknown kind ${String(e.kind)} — expected grab|release|handoff`,
      );
    }
    const holder = holders.get(e.object);
    if (e.kind === "grab") {
      if (holder !== undefined) {
        throw new Error(
          `contact timeline refused: ${e.subject} cannot grab "${e.object}" at t=${String(e.t)} — ${holder} already holds it`,
        );
      }
      holders.set(e.object, e.subject);
    } else if (e.kind === "release") {
      if (holder === undefined) {
        throw new Error(
          `contact timeline refused: ${e.subject} cannot release "${e.object}" at t=${String(e.t)} — nobody holds it`,
        );
      }
      if (holder !== e.subject) {
        throw new Error(
          `contact timeline refused: ${e.subject} cannot release "${e.object}" at t=${String(e.t)} — ${holder} holds it`,
        );
      }
      holders.delete(e.object);
    } else {
      if (holder === undefined) {
        throw new Error(
          `contact timeline refused: ${e.subject} cannot hand off "${e.object}" at t=${String(e.t)} — nobody holds it`,
        );
      }
      if (holder !== e.subject) {
        throw new Error(
          `contact timeline refused: ${e.subject} cannot hand off "${e.object}" at t=${String(e.t)} — ${holder} holds it`,
        );
      }
      if (typeof e.to !== "string" || e.to.trim().length === 0) {
        throw new Error(
          `contact timeline refused: ${e.subject} cannot hand off "${e.object}" at t=${String(e.t)} — the "to" field is missing or blank`,
        );
      }
      if (e.to === e.subject) {
        throw new Error(
          `contact timeline refused: ${e.subject} cannot hand off "${e.object}" at t=${String(e.t)} — a handoff to oneself is a no-op refused`,
        );
      }
      holders.set(e.object, e.to);
    }
  }
}

/** The object → holder map at time `t`: the events with e.t ≤ t applied
 *  in order. PRECONDITION: the timeline already passed
 *  validateContactTimeline — this replay does NOT re-validate (the
 *  caller validates once); on precondition-violating input the legal
 *  transitions still apply and illegal ones are inert, so the result
 *  never poisons. Pure: builds a fresh Map, never mutates the events. */
export function contactOwnersAt(events: ContactEvent[], t: number): Map<string, string> {
  if (!Number.isFinite(t)) {
    throw new Error(`contact timeline refused: the query time t must be finite, got ${String(t)}`);
  }
  const holders = new Map<string, string>();
  for (const e of events) {
    if (!(e.t <= t)) continue;
    if (e.kind === "grab") {
      holders.set(e.object, e.subject);
    } else if (e.kind === "release") {
      if (holders.get(e.object) === e.subject) holders.delete(e.object);
    } else if (e.kind === "handoff") {
      if (
        holders.get(e.object) === e.subject &&
        typeof e.to === "string" &&
        e.to.length > 0 &&
        e.to !== e.subject
      ) {
        holders.set(e.object, e.to);
      }
    }
  }
  return holders;
}

/** Per object (in first-appearance order), the ordered list of DISTINCT
 *  holders across the whole timeline. Diagnostic companion to
 *  validateContactTimeline: it walks the same ownership model leniently —
 *  illegal transitions are inert (skipped), it never throws — so even a
 *  refused timeline yields a readable history. Pair it with the validator
 *  for the authoritative refusals. */
export function contactTimelineSummary(events: ContactEvent[]): { object: string; holders: string[] }[] {
  const holders = new Map<string, string>();
  const history = new Map<string, Set<string>>();
  const note = (object: string, who: string): void => {
    let set = history.get(object);
    if (!set) {
      set = new Set<string>();
      history.set(object, set);
    }
    set.add(who);
  };
  for (const e of events) {
    if (typeof e.subject !== "string" || e.subject.length === 0 || typeof e.object !== "string" || e.object.length === 0) {
      continue;
    }
    if (e.kind === "grab") {
      holders.set(e.object, e.subject);
      note(e.object, e.subject);
    } else if (e.kind === "release") {
      if (holders.get(e.object) === e.subject) holders.delete(e.object);
    } else if (e.kind === "handoff") {
      if (
        holders.get(e.object) === e.subject &&
        typeof e.to === "string" &&
        e.to.length > 0 &&
        e.to !== e.subject
      ) {
        holders.set(e.object, e.to);
        note(e.object, e.to);
      }
    }
  }
  // Map/Set iteration order is insertion order — first appearance, both
  // for the objects and for each object's holder list.
  return [...history.entries()].map(([object, set]) => ({ object, holders: [...set] }));
}
