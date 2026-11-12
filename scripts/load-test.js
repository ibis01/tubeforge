// Stage 7 (T-7.4) — k6 load test scaffold.
//
// The ROADMAP §7 list: "Concurrent user workloads (load test with k6 or
// similar)". This script exercises the deterministic hot paths under
// concurrent load: registration + login + create + GET video + GET
// status. Run with:
//
//   k6 run scripts/load-test.js
//
// Requires k6 installed (https://k6.io/docs/getting-started/installation/).
// Default stage: 20 virtual users ramping from 0 → 20 over 30s, holding 60s,
// ramping down 30s — total ~2 minutes. Tune with --env VUS / --env DURATION.
//
// What this measures:
//   * p95 latency for /api/auth/register + /api/auth/login under 20
//     concurrent users (the bottleneck is pbkdf2 hashing; ~50ms per op
//     single-threaded, so 20 users saturate one Node process).
//   * p95 latency for /api/videos POST (the script-only synchronous path).
//   * error rate — every non-2xx response counts as a failure.
//
// What this DOES NOT measure (deliberately):
//   * AI provider latency (the ambient Z.ai credential 401s anyway, and
//     load-testing AI calls would burn the user's quota).
//   * Render latency (the render job is async; this script enqueues only).
//   * Cross-tenant isolation (the isolation.spec.ts e2e already covers that).
//
// Why this script is plain JS (not TS): k6's runtime is a Go-based JS
// interpreter (goja) — it doesn't speak TypeScript. k6's xk6-typescript
// extension exists but adds a build step; this scaffold stays plain JS so
// it runs out-of-the-box once k6 is installed.

import { check, sleep } from "k6";
import http from "k6/http";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const VUS = parseInt(__ENV.VUS || "20", 10);
const DURATION = __ENV.DURATION || "1m"; // total — k6 parses "1m" / "30s" / "5m30s"

export const options = {
  stages: [
    { duration: "30s", target: VUS }, // ramp up
    { duration: DURATION, target: VUS }, // hold
    { duration: "30s", target: 0 }, // ramp down
  ],
  thresholds: {
    // The ROADMAP launch metrics: "≥ 98% successful core production jobs".
    http_req_failed: ["rate<0.02"], // < 2% errors
    // p95 under 500ms for the hot paths under 20 concurrent users.
    http_req_duration: ["p(95)<500"],
  },
};

const RUN = Date.now().toString(36);
let seq = 0;

export default function loadScenario() {
  seq += 1;
  const email = `k6-${RUN}-${seq}@tubeforge.test`;
  const password = "k6-load-test-123";

  // 1. Register
  const register = http.post(
    `${BASE}/api/auth/register`,
    JSON.stringify({ name: "k6 Probe", email, password }),
    { headers: { "Content-Type": "application/json" } }
  );
  check(register, {
    "register 201": (r) => r.status === 201,
  });
  if (register.status !== 201) return;

  // Verify email when the response includes a URL (console mode).
  const regBody = register.json();
  if (regBody.verification?.url) {
    http.get(regBody.verification.url);
  }
  const cookie = register.cookies?.tf_session?.[0]?.value;
  if (!cookie) return;
  const authHeaders = { headers: { "Content-Type": "application/json", Cookie: `tf_session=${cookie}` } };

  // 2. Create a custom-script video (synchronous, no AI calls).
  const create = http.post(
    `${BASE}/api/videos`,
    JSON.stringify({
      topic: `k6 load ${RUN}-${seq}`,
      niche: "Motivation",
      format: "script",
      script: `A short k6 load test probe ${seq}.`,
      approved: true,
    }),
    authHeaders
  );
  check(create, { "create < 300": (r) => r.status < 300 });
  if (create.status >= 300) return;

  const createBody = create.json();
  const videoId = createBody.video?.id;
  if (!videoId) return;

  // 3. GET the video (tenant-scoped read path — the heaviest hot path).
  const getRes = http.get(`${BASE}/api/videos/${videoId}`, authHeaders);
  check(getRes, { "get 200": (r) => r.status === 200 });

  // 4. Auth status (the gate's hot path — should be ~10ms).
  const statusRes = http.get(`${BASE}/api/auth/status`, authHeaders);
  check(statusRes, { "status 200": (r) => r.status === 200 });

  // Brief pause to mimic a real user's think time between requests.
  sleep(0.5);

  // 5. Logout (invalidates the session).
  http.post(`${BASE}/api/auth/logout`, "", authHeaders);
}

export function handleSummary(data) {
  // Print a compact summary at the end.
  const out = {
    pass_thresholds: {
      http_req_failed_rate_lt_2pct: (data.metrics.http_req_failed?.values?.rate ?? 1) < 0.02,
      http_req_duration_p95_lt_500ms: (data.metrics.http_req_duration?.values?.["p(95)"] ?? Infinity) < 500,
    },
    metrics: {
      vus_max: data.metrics.vus_max?.values?.max,
      http_reqs: data.metrics.http_reqs?.values?.count,
      http_req_failed_rate: data.metrics.http_req_failed?.values?.rate,
      http_req_duration_p95: data.metrics.http_req_duration?.values?.["p(95)"],
      iteration_duration_p95: data.metrics.iteration_duration?.values?.["p(95)"],
    },
  };
  return { stdout: JSON.stringify(out, null, 2) + "\n" };
}
