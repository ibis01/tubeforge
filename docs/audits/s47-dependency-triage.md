# S47 dependency alerts triage (T-47.9)

**Recorded:** 2026-11-06 UTC (S47 close, tranche 2)
**Sources:** `npm audit --json` against the S47-close lockfile (same GitHub
Advisory DB Dependabot reads), repo-wide reference sweeps (`rg` over
`src/`, `e2e/`, `scripts/`, `voice-server/`, `next.config.ts`), the runtime
import graph, and the deployment topology (Fly standalone Node — NOT
Vercel serverless).

**Count reconciliation.** Dependabot reported **18 alerts (11 high / 4
moderate / 3 low)** on the default branch; `npm audit` at the same tree
reports **17 advisories (5 high / 12 moderate)**. The difference is
enumeration, not coverage: Dependabot counts **per advisory** (sharp's three
libvips CVEs = 3 alerts; prisma + @prisma/config + deepmerge-ts = 3 alerts
for one underlying advisory) while npm audit dedupes **per package+range**
at the top severity. The per-alert breakdown was not retrievable
unauthenticated (Dependabot REST API requires push access); the triage
below is keyed by package and covers every advisory npm audit enumerates.

## Actions taken in S47 (runtime-reachable only)

| Package (advisory) | Severity | Where it lived | Reachability verdict | Action |
| --- | --- | --- | --- | --- |
| `sharp` ≤0.35.5-rc.1 (libvips CVE-2026-33327 / -33328 / -355xx) | high | **runtime** — dynamic import at `src/lib/tubeforge/providers/image.ts:572` converting provider-returned JPEG (Pollinations path) to PNG | **reachable**: bytes come from external providers; image bytes are the input libvips parses | **Upgraded `sharp` ^0.34.5 → ^0.35.5** (semver-major; our usage is `sharp(bytes).png().toBuffer()` — API-stable). Smoke-tested the roundtrip; 197/197 unit suite green. |
| `@mdxeditor/editor` ≤4.0.3 (via `js-yaml` 4.0.0–4.3.1 quadratic DoS) | high/moderate | declared in `dependencies` | **not reachable — dead weight**: zero references repo-wide (no static or dynamic imports, no `transpilePackages`, no UI usage) | **Removed from `dependencies`.** The js-yaml chain (quadratic merge-key DoS) only fires on YAML the editor parses; nothing imports the editor at all. |
| `react-syntax-highlighter` 15.6.6 (via `prismjs` <1.30.0 DOM clobbering, `refractor` ≤4.6.0) | moderate | declared in `dependencies` | **not reachable — dead weight**: zero references repo-wide | **Removed from `dependencies`.** PrismJS DOM clobbering requires attacker-crafted highlighted content; nothing renders code blocks through it. |

**Result:** `npm audit` after the changes — **11 advisories (3 high / 8
moderate), every one in the dev/build chain, zero runtime**. Lockfile
updated (`@mdxeditor/editor`, `react-syntax-highlighter` and their subtrees
gone; `sharp` 0.35.5 in).

## Accepted, with rationale (dev/build chain only)

| Chain | Packages | Severity | Why it is not a production surface | Disposition |
| --- | --- | --- | --- | --- |
| Prisma config | `prisma`, `@prisma/config`, `deepmerge-ts` <8.0.0 (stack exhaustion merging recursive object graphs) | high | Prisma is the **dev/build** CLI + client generator; the runtime ships only the generated client (no `deepmerge-ts`). The merged object graphs are Prisma **config files** — repo-authored, never attacker-controlled | Accept. Revisit when Prisma ships a fixed minor; the advisory is filed against the CLI's config parser. |
| ESLint toolchain | `@typescript-eslint/*` (plugin, parser, type-utils, typescript-estree, utils), `typescript-eslint`, `eslint-config-next` ≥15.6.0-canary, `minimatch` 7–11 (globparts amplification DoS) | moderate | Lint-time only; parses **our own** globs and source. No production process imports any of it | Accept. The remediation (semver-major `eslint-config-next` 15.5.29 chain) is a toolchain upgrade bundled with a lint-config maintenance window, not an integrity-sprint change. |

## Residual risk statement

1. The runtime surface after S47: `sharp 0.35.5` (patched), everything else
   in `dependencies` advisory-clean per the current DB.
2. The dev-chain advisories matter only on contributor machines / CI, where
   the "attacker" would have to be the repository itself — the threat model
   is repo compromise, which gitleaks + review already cover.
3. Re-run cadence: `npm audit` at every sprint close alongside the lint
   census (same discipline as `docs/baselines/s47-lint-baseline-*`). A new
   **runtime-reachable** advisory is a sprint blocker; a new dev-chain one
   is a backlog item.
