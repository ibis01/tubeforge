// The named-invariant helper — S58/T-58.1.
//
// `must()` is the total-code alternative to `!`: it documents, at the use
// site, WHICH invariant guarantees the value exists, and converts a broken
// one into a named error instead of a TypeError at the deref. Use it ONLY
// where presence is proven by construction (a keyset built in this function,
// a permutation validated above, a fallback that already returned) — a
// must() throw is a bug report, never a control-flow path.

export function must<T>(what: string, value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new Error(`internal error: ${what} is missing (broken invariant)`);
  }
  return value;
}
