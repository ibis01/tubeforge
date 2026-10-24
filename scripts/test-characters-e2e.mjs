// Phase 1 E2E: character bible -> portrait -> consistency sheet -> video w/ cast -> thumbnail.
// Long-running (image jobs): run with generous timeout.
const BASE = "http://localhost:3000";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jfetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok && res.status !== 202) {
    throw new Error(`${opts.method ?? "GET"} ${path} -> HTTP ${res.status}: ${typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)}`);
  }
  return { status: res.status, data };
}

async function pollCharacter(id, predicate, timeoutMs = 8 * 60_000, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await jfetch(`/api/characters/${id}`);
    const c = data.character;
    if (!c) throw new Error("character missing during poll");
    if (c.error) throw new Error(`job error: ${c.error}`);
    if (predicate(c)) return c;
    if (Date.now() > deadline) throw new Error("poll timeout");
    await sleep(intervalMs);
  }
}

async function main() {
  const t0 = Date.now();

  // ---------- 1) GLM character bible on a throwaway character ----------
  log("1) GLM character bible (temp character)…");
  const bible = await jfetch("/api/characters/bible", {
    method: "POST",
    body: JSON.stringify({ name: "The Archivist", concept: "mysterious keeper of lost film reels, noir documentary vibe" }),
  });
  const b = bible.data.bible;
  log(`   role=${b.role?.slice(0, 60)}`);
  log(`   appearance=${b.appearance?.slice(0, 80)}…`);
  log(`   anchor=${b.identityAnchor?.slice(0, 80)}…`);
  log(`   voice=${b.voice} artStyle=${b.artStyle}`);
  if (!b.appearance || !b.identityAnchor) throw new Error("bible incomplete");

  // apply-to-character path
  const temp = await jfetch("/api/characters", {
    method: "POST",
    body: JSON.stringify({ name: "The Archivist", concept: "temp" }),
  });
  const tempId = temp.data.character.id;
  const applied = await jfetch("/api/characters/bible", {
    method: "POST",
    body: JSON.stringify({ name: "The Archivist", concept: "noir archivist", characterId: tempId }),
  });
  if (!applied.data.character.appearance) throw new Error("bible apply failed");
  log("   bible applied to character ✓");
  await jfetch(`/api/characters/${tempId}`, { method: "DELETE" });
  log("   temp character deleted ✓");

  // ---------- 2) Portrait for Professor Vex ----------
  const vexList = await jfetch("/api/characters");
  const vex = vexList.data.characters.find((c) => c.name === "Professor Vex");
  if (!vex) throw new Error("Professor Vex not seeded");

  log(`2) Portrait generation for ${vex.name} (${vex.id})…`);
  const tPort = Date.now();
  const pStart = await jfetch(`/api/characters/${vex.id}/portrait`, { method: "POST" });
  log(`   POST /portrait -> ${pStart.status} in ${Date.now() - tPort}ms`);
  const withPortrait = await pollCharacter(vex.id, (c) => !c.generating.portrait);
  log(`   portrait done in ${((Date.now() - tPort) / 1000).toFixed(1)}s, hasPortrait=${withPortrait.hasPortrait}`);
  if (!withPortrait.hasPortrait) throw new Error("portrait flag not set");
  const png = await fetch(`${BASE}/api/characters/${vex.id}/portrait`);
  if (!png.ok) throw new Error(`portrait GET -> ${png.status}`);
  log(`   portrait PNG: ${png.headers.get("content-type")} ${(png.size ?? 0)} bytes`);

  // ---------- 3) Consistency sheet ----------
  log("3) Consistency sheet (3 poses via image-edit)…");
  const tPose = Date.now();
  const sStart = await jfetch(`/api/characters/${vex.id}/poses`, { method: "POST" });
  log(`   POST /poses -> ${sStart.status} in ${Date.now() - tPose}ms`);
  const withPoses = await pollCharacter(vex.id, (c) => !c.generating.poses, 10 * 60_000);
  log(`   poses done in ${((Date.now() - tPose) / 1000).toFixed(1)}s, poseCount=${withPoses.poseCount}`);
  if (withPoses.poseCount < 3) throw new Error(`expected 3 poses, got ${withPoses.poseCount}`);
  for (const p of withPoses.poseUrls) {
    const r = await fetch(BASE + p.url);
    if (!r.ok) throw new Error(`pose ${p.pose} GET -> ${r.status}`);
    log(`   pose ${p.pose}: ${r.status} ok`);
  }

  // ---------- 4) Video with cast -> thumbnail stamped with identity ----------
  log("4) Create video cast to Professor Vex…");
  const vid = await jfetch("/api/videos", {
    method: "POST",
    body: JSON.stringify({
      topic: "The lost library of Alexandria — what actually burned",
      niche: "History",
      tone: "mysterious",
      length: "short",
      voice: vex.voice,
      characterId: vex.id,
    }),
  });
  const video = vid.data.video;
  log(`   video ${video.id} status=${video.status} characterName=${video.characterName}`);
  if (video.characterName !== "Professor Vex") throw new Error("character not attached");

  // wait for script to finish (POST /videos is synchronous through script stage)
  let cur = video;
  for (let i = 0; i < 40; i++) {
    if (cur.status !== "draft") break;
    await sleep(2000);
    cur = (await jfetch(`/api/videos/${video.id}`)).data.video;
  }
  log(`   script stage -> status=${cur.status} title="${cur.title}"`);
  if (!cur.title) throw new Error("script did not complete");

  // thumbnail with cast identity
  log("   generating cast-stamped thumbnail…");
  const tThumb = Date.now();
  const th = await jfetch(`/api/videos/${video.id}/thumbnail`, { method: "POST" });
  log(`   POST /thumbnail -> ${th.status} in ${Date.now() - tThumb}ms`);
  const deadline = Date.now() + 6 * 60_000;
  for (;;) {
    const v = (await jfetch(`/api/videos/${video.id}`)).data.video;
    if (v.error) throw new Error(`thumbnail error: ${v.error}`);
    if (v.hasThumbnail) { log(`   thumbnail done in ${((Date.now() - tThumb) / 1000).toFixed(1)}s`); break; }
    if (Date.now() > deadline) throw new Error("thumbnail timeout");
    await sleep(3000);
  }
  const thumbRes = await fetch(`${BASE}/api/videos/${video.id}/thumbnail`);
  log(`   thumbnail GET: ${thumbRes.status}, ${thumbRes.headers.get("content-type")}`);

  log(`\nE2E COMPLETE in ${((Date.now() - t0) / 1000).toFixed(0)}s — video ${video.id} kept as demo`);
}

main().catch((e) => {
  console.error("E2E FAILED:", e.message);
  process.exit(1);
});
