#!/usr/bin/env node
// Poll GitHub Actions for the run(s) on a given head SHA until they complete.
// Usage: TF_PAT=... node s58-ci-poll.mjs <owner/repo> <sha> [timeoutSec]
// Exit codes: 0 all runs success · 1 any run failed · 2 still running at timeout · 3 no runs / bad args
import { setTimeout as sleep } from "node:timers/promises";

const [repo, sha, timeoutSec = "540"] = process.argv.slice(2);
const token = process.env.TF_PAT;
if (!repo || !sha || !token) {
  console.error("usage: TF_PAT=… node s58-ci-poll.mjs <owner/repo> <sha> [timeoutSec]");
  process.exit(3);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};
const api = (path) =>
  fetch(`https://api.github.com${path}`, { headers }).then(async (r) => ({
    status: r.status,
    body: await r.json().catch(() => ({})),
  }));

const deadline = Date.now() + Number(timeoutSec) * 1000;
let sawRun = false;
while (Date.now() < deadline) {
  const { status, body } = await api(
    `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`
  );
  if (status !== 200) {
    console.log(`api ${status}: ${body.message ?? ""}`);
    await sleep(15000);
    continue;
  }
  const runs = body.workflow_runs ?? [];
  if (runs.length === 0) {
    console.log("no runs registered yet for this sha");
    await sleep(15000);
    continue;
  }
  sawRun = true;
  const allDone = runs.every((r) => r.status === "completed");
  for (const r of runs) {
    console.log(
      `run ${r.id} "${r.name}" ${r.status}${r.conclusion ? " → " + r.conclusion : ""}\n  ${r.html_url}`
    );
  }
  if (allDone) {
    let fail = false;
    for (const r of runs) {
      const { body: jobs } = await api(
        `/repos/${repo}/actions/runs/${r.id}/jobs?per_page=50`
      );
      for (const j of jobs.jobs ?? []) {
        console.log(`  · ${j.name}: ${j.conclusion ?? j.status}`);
      }
      if (r.conclusion !== "success") fail = true;
    }
    process.exit(fail ? 1 : 0);
  }
  await sleep(20000);
}
process.exit(sawRun ? 2 : 3);
