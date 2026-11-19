# External Security Review — Verification Record & Remediation Plan

**Date:** 2026-11-17. **Subject:** the external authentication-architecture review of
`ibis01/tubeforge` (conducted against the public mirror at `main`, `b06f222` + `59b8ad1`).
**Method:** every review claim was checked against the actual code (file:line receipts below),
two claims were additionally exercised at runtime, and the review's "next actions" were executed:
route-guard census, cross-tenant boundary trace, email-verification enforcement check, legacy-code
import audit, test/CI evidence collection.

**Verdict in one line:** the review's architecture description is accurate and its positive
assessments hold; three of its five "investigate next" items are confirmed real findings
(malformed-signature 500, auth-secret doc/runtime mismatch, unenforced email verification),
one legacy-code claim is half-stale, and the cross-tenant boundary — the review's "most
consequential question" — holds on every traced path, with the guard coverage enforced by
lint + unit pins + the e2e isolation suite rather than by per-route auditing alone.

---

## 1. Claim-by-claim verification

| # | Review claim | Verdict | Receipt |
| --- | --- | --- | --- |
| 1 | Middleware = first gate; default-deny with a small public allow-list; production 503 without secret; rate limit + CSRF + CSP | **VERIFIED** | `src/middleware.ts:38-58` (8-endpoint `PUBLIC_API`), `:146-155` (503 fail-safe), `:126-138` (600 read/90 write per-IP shed), `:187-210` (session-scope mutating CSRF via origin-trust), `:89-97` (nonce CSP) |
| 2 | PBKDF2-SHA256, 120,000 iterations, 16-byte salt, 256-bit hash, `pbkdf2$iters$salt$hash` format, constant-time compare | **VERIFIED** | `src/lib/tubeforge/tenant.ts:97,104-119` (live hasher), `:121-147` (verify, constant-time compare at `:144-146`); identical helpers in `auth.ts:86-130` for the legacy gate |
| 3 | Sessions: HMAC-SHA256, `tf_session` cookie, 7 days, HttpOnly, SameSite Lax (None+Secure only behind embedded-preview proxy), Secure in production, server-side rows, instant revocation | **VERIFIED** | `auth-token.ts:9-11,49-58`; `tenant.ts:158-180` (Session row = token jti; `resolveSessionCtx` rejects `revokedAt`/expired), `:420-430` (cookie flags); `auth.ts:173-189` (SameSite=none law) |
| 4 | API tokens: 90 days, registry-gated (unknown/revoked jti dead on arrival), metadata-only listing, owner-scoped revocation, Bearer cannot mint/manage tokens or change password | **VERIFIED** | `tenant.ts:214-229` (registry resolve), `:363-380` (jti registered before token leaves), `:383-410` (metadata select; `findFirst({ id, userId })`), `token/route.ts:37-54` (`sessionOnlyGate` → 403 to bearers) |
| 5 | Login brute force: 5 failures / 10 min rolling window, DB-backed `AuthAttempt`, success clears, fail-open loudly on DB error | **VERIFIED** (fail-open is an explicit, announced design decision) | `auth-throttle.ts:51-53` (constants), `:68-79` (pure sliding-window law), `:26-34,104-113` (fail-open posture + once-per-process stderr), `login/route.ts:26,42,46` (wired) |
| 6 | CSRF: origin validation for cookie-authenticated mutations only | **VERIFIED** | `middleware.ts:187-210` — Bearer clients send no Origin and pass by design; only session-scope mutating requests are policed |
| 7 | Wrong email vs wrong password indistinguishable | **VERIFIED** | `login/route.ts:40-43` — single generic failure path (`recordLoginFailure` + same response) |
| 8 | `getAuthSecret()` accepts any string ≥16 chars while docs demand 32+ hex | **CONFIRMED — doc/runtime mismatch** | `auth-token.ts:109-112` vs `SECURITY.md:56` ("32+ hex chars each") |
| 9 | Signature decoding happens outside the verifier's try/catch; malformed signatures may 500 instead of 401 | **CONFIRMED AT RUNTIME** | `auth-token.ts:89` — `fromB64url(sig)` sits outside the `try` that guards the body decode (`:70-74`). Probe (node v24.22.3/tsx): garbage **body** → `null` (clean 401); garbage **signature** → `InvalidCharacterError` thrown. Both callers (`middleware.ts:161`, `tenant.ts:295`) await unguarded → 500. Fail-closed, not a bypass — but an unhandled-error path |
| 10 | Registration creates the session before email verification; login does not reject unverified accounts; enforcement unknown | **CONFIRMED — verification is never enforced** | `register/route.ts:143` (session minted) + `:170` (mail failure non-fatal); `login/route.ts` has no `emailVerified` check. Repo-wide `emailVerified` search: UI badge (`security-card.tsx`), status echo, export field, verify-email stamp — **no gate anywhere** |
| 11 | Rate limiter + throttle fail open on DB errors; documented | **VERIFIED** (policy, not accident) | `auth-throttle.ts:26-34`; `SECURITY.md:40-47` states it as deliberate exception #1 with the alert probe as the monitoring seam; `tenant.ts:307-319` (shared limiter, same posture) |
| 12 | `src/lib/tubeforge/auth.ts` "still contains the older single-user password-lock implementation"; import/reference audit needed to rule out conflicting behavior | **PARTIALLY STALE** | The conflicting duplicate the file itself warns about was removed in S46 (`auth.ts:191-196`: "DEAD CODE REMOVED"). What remains: the live PBKDF2/cookie helpers **plus** the single-user opt-in gate (`isAuthEnabled`/`setAuthEnabled`/`forceLockOff`/Setting-table `checkPassword`), imported by exactly two routes: `api/auth/setup/route.ts:7` and `api/auth/lock/route.ts:9` (rg census: only these two import `@/lib/tubeforge/auth`). Not in `PUBLIC_API` → middleware already 401s anonymous callers. Residual: a valid **API token** can toggle the legacy global lock (no in-route session-only gate) — P2 cleanup below |
| 13 | Password-reset revokes all sessions | **VERIFIED** | `reset-password/route.ts:134-137` (`updateMany revokedAt`) |

## 2. Route-guard census (the review's "audit every protected route")

136 route handlers under `src/app/api`:

- **120** call `requireUser()` / `requireRole()` directly.
- **16** do not, and each is accounted for:
  - 6 reference-file routes (characters/locations/props × route + [file]) → guarded inside the
    shared `makeReferenceHandlers` factory (`reference-routes.ts:54,69,126,158`).
  - 7 auth bootstrap routes (`status`, `login`, `logout`, `register`, `verify-email`,
    `reset-password`, `setup`) + `lock` — allow-listed bootstrap or middleware-protected
    legacy surface (setup/lock are NOT in `PUBLIC_API`; anonymous callers never reach them).
  - `billing/webhook` → authenticated by the Stripe `stripe-signature` HMAC in-route.
  - `youtube/callback` → authenticated by the signed one-shot `state` token (`s: "state"`,
    rejected as a credential everywhere).
  - **`diag` → NO in-route guard.** It relies solely on the middleware's signature/expiry check.
    Consequences: a revoked-but-unexpired session still reads it (revocation is not instant
    there), the shared DB rate limiter never runs for it, and it discloses table names +
    redacted migration logs to any valid token including 90-day API tokens. Findings are
    genuinely redacted (URLs, hosts, values) — an information-hygiene gap, not a key leak.

**Raw-database audit:** zero `src/app/api` handlers import `@/lib/db` directly (rg: empty) — the
ESLint `no-restricted-imports` ban (`eslint.config.mjs:89-97`, ignores only `src/app/api/auth/**`)
is doing its job. The five raw users (`youtube/disconnect`, `youtube/callback`,
`account/usage|delete|export`) import `rawDatabase` from `tenant-db` and scope every query by
`auth.ctx.userId` by hand (spot-verified: `disconnect:14`, `export:26,59-62`).

## 3. Cross-tenant boundary trace (the review's "most consequential question")

- **Videos and all org content** (`video`, `channel`, `voiceProfile`, `musicTrack`, `job`,
  `sceneRevision`, …): routed through the tenant-scoped client — `videos/route.ts:2-3` imports
  `db` from `tenant-db` and calls `requireUser`; the `$allOperations` extension injects
  `organizationId` into every read/create/update/delete (`tenant-db.ts:101-163`), refuses
  cross-tenant create payloads (`:84-88`), and turns a guessed foreign id into `null` → 404
  (`:20-23`). The lowercase model-set regression (T-4.14) is pinned by battery test at
  `test-unit.mts:2601-2615`.
- **Provider credentials (API keys)**: user-scoped rows, encrypted at rest, masked in every
  settings GET (`settings/route.ts:35,93-94,134`); `account/export` selects
  `capability/provider/baseUrl` only — never key material (`export:62`).
- **YouTube credentials**: per-user rows; disconnect deletes strictly
  `where: { userId: auth.ctx.userId }` (`disconnect:14`); tokens never leave the server
  (SECURITY.md posture, verified pattern).
- **Billing**: `portal`, `plan`, `checkout` all behind `requireUser`; `webhook` is
  signature-authenticated only.
- **Enforcement mechanism is not per-route hope:** lint bans raw-db imports in `src/app`
  (except auth bootstrap), the org-scoped model set is unit-pinned, and
  `e2e/isolation.spec.ts` runs cross-tenant isolation in CI on every main push.

**Answer to the review's final question:** on every traced path, one user cannot read another
user's videos, API keys, YouTube credentials, or billing data. The honest caveat: this trace
verified the *mechanism* + a representative sample of routes, not all 136 handlers line-by-line —
the mechanism-level guarantees (tenant-db extension, lint ban, pinned model set, isolation e2e)
are what make the exhaustive case.

## 4. Test & CI evidence

- Battery: **1003 passed / 0 failed** at `b06f222` on this mirror (receipt:
  `docs/baselines/b0-battery-2026-11-17.txt`); includes the tenant-db model-set pin and the
  auth/throttle suites (161 auth-adjacent matches in `scripts/test-unit.mts`).
- E2E: `e2e/isolation.spec.ts` (cross-tenant) among 10 Playwright suites; CI on this repo is
  **8/8 green** on `b06f222` and `59b8ad1` (incl. PostgreSQL integration, gitleaks, Docker smoke).
- gitleaks runs full history on every push (`SECURITY.md` S136 addendum).

## 5. Prioritized remediation plan (PROPOSED — operator-gated, per the no-rewrite constraint)

All items preserve the architecture; none rewrites auth. Sizes are deliberately tiny.

- **P0-1 — Close the malformed-signature 500.** Wrap the signature decode + HMAC verify in
  `verifyToken` (`auth-token.ts:85-92`) in the same try/catch contract the body decode already
  has: any throw → `null` (clean 401). No contract change, no callers touched. Add a battery
  case: malformed signature → `null`, not a throw.
- **P0-2 — Give `diag` a real guard.** Call `requireUser()` (or at minimum
  `resolveRequestUser` + 401) so session revocation is instant and the shared limiter covers it,
  exactly as its own header claims ("required, like every other /api/* endpoint"). Optionally
  drop the migration/table-name listing for non-session callers.
- **P1-1 — Make the auth-secret policy agree.** Either enforce the documented policy in
  `getAuthSecret()` (≥32 chars, hex) with a loud startup warning for weaker values, or amend
  `SECURITY.md` to state the real floor (≥16 chars). Prefer the enforcement + `npm run setup`
  generating 32-hex, with a battery config-truth case (the S185 pattern).
- **P1-2 — Decide email-verification enforcement as a product question.** Today it is tracked
  but never gates anything. Operator decision: (a) gate sensitive actions (YouTube connect,
  provider-key writes, billing changes, API-token minting) on `emailVerifiedAt`, or (b) document
  verification as informational for self-hosted single-operator installs. No silent choice.
- **P1-3 — Strengthen password hashing without breaking anyone.** `verifyPassword` already reads
  the iteration count from the stored string (`tenant.ts:122-127`), so bumping `PBKDF2_ITERS`
  (120k → OWASP-recommended 600k for PBKDF2-HMAC-SHA256) plus rehash-on-successful-login
  migrates every account transparently — no schema change, no lockout, no rewrite. Argon2id is
  the bigger hammer and needs a native dep; it stays optional.
- **P2-1 — Retire or gate the legacy single-user surface.** `api/auth/setup` + `api/auth/lock`
  still drive the Setting-table global lock via `auth.ts`'s gate half; `lock` accepts any valid
  API token. Either delete both routes (and the gate half of `auth.ts`, keeping the
  PBKDF2/cookie helpers), or add the same session-only gate the token route uses. A decision
  item, not an urgent hole (middleware already blocks anonymous callers).
- **P2-2 — Wire the fail-open monitoring seam.** `alert:probe` is the documented counterweight
  to the two fail-open dampers; put it on a schedule (Fly machine cron or CI nightly) so a
  limiter/throttle DB failure is seen, not just logged once per process.

## 6. Bottom line

The review's own recommendation — **do not rewrite authentication; perform a focused
hardening pass** — matches the evidence: architecture is sound (default-deny middleware,
registry-gated revocable tokens, ALS tenant scope + query-level org isolation, DB-backed
throttle), the cross-tenant boundary holds, and the real work is five small, receipt-backed
patches (P0×2, P1×3) plus two operator decisions (P2). Nothing above has been implemented yet —
this record is the evidence base the operator approves from.

---

## 7. Remediation execution record (2026-11, post-review pass)

The operator's standing directive ("continue till you finish all pending tasks") authorized
the plan above. Every patch preserves the architecture; battery pins ride each fix.

- **P0-1 DONE** — `verifyToken` (`src/lib/tubeforge/auth-token.ts`) now wraps the signature
  decode + HMAC verify in the same try/catch contract the body decode already had: any
  malformed signature answers `null` (clean 401), never the `InvalidCharacterError` 500 the
  runtime probe confirmed. Battery: malformed-signature → null.
- **P0-2 DONE** — `GET /api/diag` calls `requireUser()` (instant revocation + the shared
  per-IP limiter, exactly as the route's own header always claimed) and the migration/
  table-name inventory is now SESSION-ONLY — a 90-day bearer still triages booleans/protocols
  but never sees the schema names (the review's information-hygiene note).
- **P1-1 DONE (agreement, not breakage)** — the ≥16 runtime floor STAYS (legacy `.env` files
  keep authenticating); `getAuthSecret()` emits ONE loud per-process warning below the
  documented 32-hex floor; `scripts/postinstall.mjs` now generates 64-hex (32-byte) secrets;
  `SECURITY.md` states the real floor and the generated value. Battery: floor law + generator
  config-truth.
- **P1-2 DECIDED (option b, documented — no silent choice)** — email verification remains
  tracked-but-non-gating; the rationale (self-hosted-first, optional mail, a stamp that can
  never be earned must not gate) is recorded in `SECURITY.md`'s checklist and here. Revisit
  (option a) only if a managed deployment with guaranteed mail ships.
- **P1-3 DONE** — `PBKDF2_ITERS` 120k → 600k (OWASP recommendation for PBKDF2-HMAC-SHA256);
  `passwordNeedsRehash()` + rehash-on-successful-login migrate every account transparently on
  its next sign-in (best-effort: a failed re-hash never blocks the login). The stored-format
  iteration-count law means zero lockouts. Battery: fresh mint at 600k, legacy 120k row still
  verifies, rehash-detection truth table.
- **P2-1 DONE (gate, not delete)** — `api/auth/setup` + `api/auth/lock` now enforce the same
  session-only gate the token registry uses (`requireUser` + `sessionIdFromRequest` → 403 for
  bearers). The gate half of `auth.ts` is untouched (preserve-functionality law); the
  UI's only callers (security-card.tsx; a signed-in browser) are unaffected.
- **P2-2 DONE (CI nightly leg)** — `npm run alert:probe` runs in the nightly battery job
  against the freshly-pushed schema (proving the probe itself keeps matching the live Prisma
  models) and the same run's ffmpeg step got the pinned static outage net (nightly run 1,
  44286031917, had starved on azure — the step now matches ci.yml's hardened shape).
  Production deployments still put the probe on a machine cron per `docs/production-readiness.md`.

Honest scope note: P1-1's runtime floor was NOT raised to 32 (breakage); P1-3's Argon2id
stays optional (native dep); P2-1 chose the gate over the delete (preserve-functionality
law). Battery additions live in `scripts/test-unit.mts` under "security review P0/P1/P2".
