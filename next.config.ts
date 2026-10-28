import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Strict TypeScript is enforced: `bun run typecheck` and the build both fail
  // on compiler errors. (ignoreBuildErrors was removed 2025-10 per the security
  // audit — all previously-suppressed errors were fixed at the source.)
  reactStrictMode: false,
  devIndicators: false,
};

export default nextConfig;
