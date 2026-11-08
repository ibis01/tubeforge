import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TypeScript rules — Stage 1 (T-1.4): the blanket "off" pass was reverted
    // to `warn` so `npm run lint` reports real issues without blocking the
    // build. Tighten selected rules to "error" once the warning count is
    // driven down to zero.
    "@typescript-eslint/no-explicit-any": "warn",
    // S56/T-56.6: the trivial tranche is at ZERO (72+3+5 sites burned down,
    // 2026-11-08) — promoted to "error" so the class cannot grow back.
    // Underscore-prefixed names stay allowed (argsIgnorePattern/
    // varsIgnorePattern); catch params should use optional catch binding.
    "@typescript-eslint/no-unused-vars": [
      "error",
      { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_", "caughtErrors": "none" },
    ],
    // S58/T-58.3 — the non-null-assertion freeze: 159 `!` sites burned down
    // (2026-11-08; 43 src/ + 116 scripts/), each replaced by a guard, a
    // restructure, providerMetaRequired/must()/req(), or narrowing the
    // compiler can see. Promoted to "error" — the class cannot grow back
    // without failing CI. No carve-outs: tests get req(), not exemptions.
    "@typescript-eslint/no-non-null-assertion": "error",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",
    "prefer-const": "error", // S56/T-56.6 — frozen at zero
    "no-useless-escape": "error", // S56/T-56.6 — frozen at zero

    // React rules
    // S59 — both react-hooks correctness classes frozen at error, no
    // carve-outs: set-state-in-effect 33→0 and exhaustive-deps 9→0. The one
    // reasoned inline disable (video-detail-dialog's fetch battery, whose
    // deps would otherwise storm on an unstable inline prop) is disclosed
    // in the S59 reliability record.
    "react-hooks/exhaustive-deps": "error",
    "react-hooks/set-state-in-effect": "error",
    "react-hooks/purity": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",

    // Next.js rules
    // <img> is deliberate here: all media streams from same-origin /api/...
    // routes (thumbnails, scene art, video), so next/image adds nothing.
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",

    // General JavaScript rules
    // (prefer-const and no-useless-escape stay at "error" from the
    // T-56.6 freeze above — the duplicate "warn" keys that used to sit
    // here silently overrode them, JS-object-literal last-key-wins. Found
    // and deduped by S58/T-58.3; the freeze is real again.)
    "no-unused-vars": "off", // superseded by @typescript-eslint/no-unused-vars
    // S57/T-57.3 — the structured-logger freeze: src/ (the running app) has
    // NO console sites left; every line goes through log.ts (pino-format
    // JSON with request ids). Promoted to a bare error (no allow list) — the class
    // cannot grow back without failing CI. The owned exceptions carry
    // inline eslint-disable comments with their reasons (log.ts's portable
    // fallback sink, email.ts's console delivery channel, pwa.tsx's client
    // line, instrumentation.ts's last-resort boot line). scripts/ and e2e/
    // are scoped OFF below — they are operator-facing CLI harnesses where
    // readable console output IS the interface.
    "no-console": "error",
    "no-debugger": "warn",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-redeclare": "off",
    "no-undef": "off", // TS handles undefined globals
    "no-unreachable": "warn",
  },
}, {
  // Stage 2 multi-tenant guard: route handlers must go through the tenant-
  // scoped client (src/lib/tubeforge/tenant-db.ts). A raw @/lib/db import in
  // src/app would silently BYPASS the organizationId filter — this rule makes
  // that a lint error instead of a cross-tenant hole. Allow-listed exceptions:
  // the auth/account bootstrap routes (no tenant exists yet there by design).
  files: ["src/app/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [{
        group: ["@/lib/db", "@/lib/db*"],
        message: "Routes must use the tenant-scoped client: import { db } from \"@/lib/tubeforge/tenant-db\" (raw @/lib/db bypasses the organizationId guard).",
      }],
    }],
  },
  ignores: [
    "src/app/api/auth/**",
  ],
}, {
  // S57/T-57.3 — the CLI harness scope: scripts/ and e2e/ are operator-
  // facing tools (probes, suites, workers, evidence harnesses). Their
  // console output is the human interface, not app observability — JSON
  // lines there would bury the operator. The structured-logger law governs
  // src/ only; harnesses that want structure import log.ts themselves.
  files: ["scripts/**/*.{js,mjs,mts,ts}", "e2e/**/*.ts"],
  rules: {
    "no-console": "off",
  },
}, {
  // pack/ is a packaging artifact mirror; scripts/*.cjs are standalone ops
  // scripts executed directly with node (CommonJS by design, not app code).
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills", "pack/**", "scripts/**/*.cjs"]
}];

export default eslintConfig;
