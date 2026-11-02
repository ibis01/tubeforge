// E2E: shared-voice-server cloning flow through the app's own API.
import fs from "fs";

const BASE = "http://localhost:3000";
let cookie = "";

async function call(method, path, body, isForm = false) {
  const headers = { Cookie: cookie };
  let payload;
  if (body && !isForm) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  } else if (body) {
    payload = body; // FormData
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

const stamp = Date.now().toString(36);
const email = `voice-e2e-${stamp}@example.com`;
const password = "VoiceE2e!2345";

// 1) register + login
let res = await call("POST", "/api/auth/register", { email, password });
console.log("register:", res.status);
res = await call("POST", "/api/auth/login", { email, password });
console.log("login:", res.status);

// 2) clone-provider state — expect shared-server ready
res = await call("GET", "/api/voices/clone-providers");
const providers = await res.json();
console.log("clone-providers:", JSON.stringify(providers.pick));

// 3) clone from the sample file
const form = new FormData();
form.append("name", "E2E Probe Voice");
form.append(
  "file",
  new Blob([new Uint8Array(fs.readFileSync("/tmp/clone-sample.wav"))]),
  "probe-sample.wav"
);
res = await call("POST", "/api/voices/clone", form, true);
const clone = await res.json();
console.log("clone:", res.status, JSON.stringify(clone).slice(0, 300));
if (!clone.ok) process.exit(1);
const voiceId = clone.profile.providerVoiceId;
const profileId = clone.profile.id;

// 4) audition WAV (clone-time cached preview)
res = await call("GET", `/api/voices/${profileId}/audition`);
const audition = Buffer.from(await res.arrayBuffer());
console.log("audition:", res.status, `${audition.length} bytes, RIFF=${audition.slice(0, 4).toString() === "RIFF"}`);
if (res.ok && audition.length > 44) fs.writeFileSync("/tmp/e2e-audition.wav", audition);

// 5) ▶ preview synthesis through the shared server (fresh, not cached)
res = await call("POST", "/api/settings/voices/preview", { voice: voiceId });
const preview = Buffer.from(await res.arrayBuffer());
console.log("preview:", res.status, `${preview.length} bytes, RIFF=${preview.slice(0, 4).toString() === "RIFF"}`);
if (res.ok && preview.length > 44) fs.writeFileSync("/tmp/e2e-preview.wav", preview);

// 6) voice list includes the clone
res = await call("GET", "/api/voices");
const voices = await res.json();
console.log("voice list:", res.status, "clones:", voices.voices.map((v) => v.label).join(" | "));

console.log("E2E DONE");
