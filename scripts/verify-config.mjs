// Verify your .z-ai-config BEFORE starting TubeForge.
//
// Usage:
//   node scripts/verify-config.mjs         # checks the config file + one tiny chat call
//   node scripts/verify-config.mjs --all   # also tests TTS, image generation and video task creation (uses a little quota)
//
// Exit codes: 0 = everything tested passed, 1 = config problem, 2 = some stage failed.

import fs from "fs";
import path from "path";
import ZAI from "z-ai-web-dev-sdk";

const args = new Set(process.argv.slice(2));
const PLACEHOLDER = /REPLACE_WITH|PASTE_|YOUR_KEY|YOUR_API|YOUR_ZAI/i;

// 1) Locate the config — same search order the SDK uses.
const home = process.env.HOME || process.env.USERPROFILE || "";
const candidates = [
  path.join(process.cwd(), ".z-ai-config"),
  path.join(home, ".z-ai-config"),
  "/etc/.z-ai-config",
];

let cfgPath = null;
let cfg = null;
for (const p of candidates) {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (parsed && parsed.baseUrl && parsed.apiKey) {
      cfgPath = p;
      cfg = parsed;
      break;
    }
    console.log(`✗ ${p} — exists but is missing "baseUrl" or "apiKey"`);
  } catch {
    /* not here, or not valid JSON — keep looking */
  }
}

if (!cfg) {
  console.error(`\n✗ No usable .z-ai-config found. Searched:\n  ${candidates.join("\n  ")}`);
  console.error(`\nFix:  cp .z-ai-config.example .z-ai-config   then fill in baseUrl + apiKey.\n`);
  process.exit(1);
}

console.log(`✓ Config found: ${cfgPath}`);
if (PLACEHOLDER.test(cfg.baseUrl) || PLACEHOLDER.test(cfg.apiKey)) {
  console.error("✗ baseUrl / apiKey still contain template placeholders — paste your real values first.");
  process.exit(1);
}
console.log(`  baseUrl: ${cfg.baseUrl}`);
console.log(`  apiKey:  ${String(cfg.apiKey).slice(0, 6)}…${String(cfg.apiKey).slice(-4)}`);
for (const k of ["chatId", "userId", "token"]) {
  if (cfg[k]) console.log(`  ${k}: set (optional — only sent as an extra X-${k} header)`);
}

const ok = [];
const fail = [];

// 2) Chat — required by script, storyboard, captions, Topic Radar, narration analysis.
let zai;
try {
  zai = await ZAI.create();
} catch (e) {
  console.error(`✗ SDK failed to initialise: ${e.message}`);
  process.exit(1);
}

try {
  const r = await zai.chat.completions.create({
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
  });
  const txt = r?.choices?.[0]?.message?.content?.trim() || "(empty reply)";
  console.log(`✓ chat  — model replied: ${txt.slice(0, 60)}`);
  ok.push("chat");
} catch (e) {
  console.error(`✗ chat  — ${String(e.message).slice(0, 220)}`);
  fail.push("chat");
}

if (args.has("--all")) {
  // 3) TTS — required by the voiceover stage.
  try {
    const r = await zai.audio.tts.create({ input: "Testing.", voice: "tongtong", response_format: "wav" });
    const buf = Buffer.from(new Uint8Array(await r.arrayBuffer()));
    if (buf.length < 1000) throw new Error(`suspiciously small audio (${buf.length} bytes)`);
    console.log(`✓ tts   — got ${(buf.length / 1024).toFixed(0)} KB of audio`);
    ok.push("tts");
  } catch (e) {
    console.error(`✗ tts   — ${String(e.message).slice(0, 220)}`);
    fail.push("tts");
  }

  // 4) Image — required by thumbnails and storyboard keyframes.
  try {
    const r = await zai.images.generations.create({ prompt: "a single red apple on a white table", size: "1024x1024" });
    const b64 = r?.data?.[0]?.base64 || "";
    if (b64.length < 1000) throw new Error("no image data returned");
    console.log(`✓ image — got ${Math.round((b64.length * 3) / 4 / 1024)} KB image`);
    ok.push("image");
  } catch (e) {
    console.error(`✗ image — ${String(e.message).slice(0, 220)}`);
    fail.push("image");
  }

  // 5) Video — only creates the task (no polling); needed for full AI animation renders.
  try {
    const t = await zai.video.generations.create({
      prompt: "a single red apple slowly rotating on a white table",
      quality: "speed",
      size: "1920x1080",
      fps: 30,
      duration: 5,
    });
    console.log(`✓ video — task accepted (id ${t?.id ?? "?"}). Poll later with: npx z-ai async-result --id ${t?.id}`);
    ok.push("video");
  } catch (e) {
    console.error(`✗ video — ${String(e.message).slice(0, 220)}`);
    fail.push("video");
  }
}

console.log("");
if (ok.length) console.log(`OK: ${ok.join(", ")}`);
if (fail.length) {
  console.log(`FAILED: ${fail.join(", ")}`);
  console.log("\ncheat-sheet: chat = scripts/storyboards · tts = voiceover · image = thumbnails · video = animated renders");
  console.log("A 404 on a stage means your endpoint doesn't serve that route — you need a Z.ai-compatible gateway that covers it.");
  process.exit(2);
}
console.log("\nAll good — start the app with:  npm run dev");
