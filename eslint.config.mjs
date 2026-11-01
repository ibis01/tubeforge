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
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" },
    ],
    "@typescript-eslint/no-non-null-assertion": "warn",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",

    // React rules
    "react-hooks/exhaustive-deps": "warn",
    // Next 16 ships this React-Compiler rule at error level; 17 pre-existing
    // call sites trip it. Warned for Stage 1 (refactoring them is their own
    // task); tighten to "error" once they are addressed.
    "react-hooks/set-state-in-effect": "warn",
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
    "prefer-const": "warn",
    "no-unused-vars": "off", // superseded by @typescript-eslint/no-unused-vars
    "no-console": ["warn", { "allow": ["warn", "error", "info"] }],
    "no-debugger": "warn",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-redeclare": "off",
    "no-undef": "off", // TS handles undefined globals
    "no-unreachable": "warn",
    "no-useless-escape": "warn",
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
  // pack/ is a packaging artifact mirror; scripts/*.cjs are standalone ops
  // scripts executed directly with node (CommonJS by design, not app code).
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills", "pack/**", "scripts/**/*.cjs"]
}];

export default eslintConfig;
