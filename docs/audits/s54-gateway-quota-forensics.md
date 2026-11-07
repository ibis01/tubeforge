# S54 gateway quota forensics — 2026-11-07 (07:20–08:36 UTC)

Why the S54 owed legs (§A podcast + islamic-history, §B) stayed blocked after
~35 min of cool-downs in the first S54 session — measured from the wire, not
inferred. Every claim below is a raw HTTP response header from
`https://internal-api.z.ai/v1/chat/completions` (the platform SDK gateway,
`/etc/.z-ai-config`), captured 2026-11-07 08:28–08:34 UTC.

## The three quota layers (response headers, verbatim)

```
x-ratelimit-limit-daily: 300            ← POOL-WIDE rolling-24h budget
x-ratelimit-remaining-daily: 0          ← the pool, shared across sandboxes
x-ratelimit-user-daily-remaining: 133   ← this sandbox's own budget
x-ratelimit-limit-qps: 2                ← per-user requests/second
x-ratelimit-user-10min-limit: 30        ← per-user rolling-10min requests
x-ratelimit-reset: 1794040122           ← ALWAYS ≈ now + 1s (see below)
```

## The four facts that matter

1. **The blocking layer is the POOL, not this user.** While the first 429 was
   answered, the pool showed `remaining-daily: 0` while
   `user-daily-remaining: 133` — other sandboxes on the shared gateway had
   consumed the entire 300-request rolling-24h pool. This sandbox could not
   have fixed that by waiting politely: its own budget was never the problem.

2. **The pool is in saturated steady state.** Consecutive probes 46 s apart
   each reported `x-ratelimit-reset` ≈ now + 1 s: the header is recomputed
   per request ("the oldest slot would age out in ~1 s if ALL traffic stopped
   now"), it is NOT a schedule to race. Demand arrives at or above the
   aging-out rate, so `remaining-daily` stays pinned at 0. A 20-attempt race
   fired exactly at the published reset epochs lost 20/20 — the target moves
   with the observer.

3. **Every request costs, success or 429.** `user-daily-remaining` fell
   133 → 107 across ~26 rejected probes (and each rejection also occupies a
   pool slot for its full 24 h). Diagnostic probing therefore makes the
   saturation it is watching slightly worse; the 10-min bucket (30) throttles
   how fast that cost can be paid.

4. **The unblock condition is pool de-saturation** — aggregate gateway demand
   over the trailing 24 h falling below 300, most plausibly in the platform's
   off-peak hours. Nothing in this sandbox's control changes it.

## What this explains retroactively

The first S54 session's "~35 min of cool-downs did not clear it" (T-54.3) was
not impatience: cool-downs address the per-user layers (QPS 2, 30/10 min,
user-daily), which were never the binding constraint. No retry cadence clears
a pool that other tenants keep saturated.

## Probe-hygiene law for the owed legs' completion

- Probe ≤ once per ~45 min; each probe costs 1 user-daily + 24 h of a pool
  slot. Never race reset epochs.
- Watch `x-ratelimit-remaining-daily` (the POOL counter, not the user one).
  At ≥ 20, launch immediately: `S54_LEG=A S54_PROFILES=podcast,islamic-history
  node --import tsx scripts/s54-genre-benchmark.mts` → `S54_LEG=B …` →
  `S54_LEG=report …` (per T-54.3's runbook; the durable state twin in
  `docs/baselines/s54-genre-benchmark-state.json` carries the 12 measured
  rows). The harness's own 75 s cool-down handles mid-window pressure.
- Budget: the legs need ~15–20 successes; this sandbox's user-daily had 107
  left at the time of writing — ample if probes stay sparse.

## Diagnostic cost, on the record

~26 probes + 20 race attempts ≈ 46 requests, all rejected (429): ~46
user-daily burned (133 → 107), ~46 pool slots occupied for 24 h, 0 successes,
0 measurement errors. The forensics value above is what it bought; the legs
remain owed, not claimed.
