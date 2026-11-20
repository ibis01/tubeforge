#!/usr/bin/env node
/**
 * The AI-provider friendliness battery — the pins behind the settings
 * overhaul (affordable catalog + setup guides + leveled Z.ai).
 *
 *   node --import tsx scripts/test-provider-registry.mts
 *
 * The pins:
 *   1. CATALOG INTEGRITY — unique provider ids per capability; every
 *      key-requiring provider carries an https keyUrl; the local rows
 *      (requiresKey: false) are exactly the loopback family.
 *   2. FRIENDLY LAYER — every registry entry carries tier + pricing +
 *      setup (a new row without one FAILS — the UI can never show a
 *      blank setup panel); every setup has >= 2 real steps + https links;
 *      tiers are from the closed set; the zai rows are the free tier.
 *   3. AFFORDABILITY SHAPE — the $0 lanes exist per capability (chat:
 *      zai/groq/gemini; tts: zai/heygen + the local family; asr: zai/groq
 *      + voicestudio; image: the five free lanes; video: agnes/nvidia/
 *      magichour) and imageTestFreeLane still agrees with the registry.
 *   4. GROQ ASR — the openai-compatible adapter rides it and the word-
 *      timestamp table answers true (the detailed ladder stays honest).
 *   5. Z.AI LEVELED — the video lane's zai-only wall is GONE (render.ts
 *      source pin: the generic imageToVideo dispatch is imported, the
 *      "only supports Z.ai" refusal no longer exists); the default video
 *      provider is zai with the cogvideox-3 model (settings.ts pins).
 *   6. CONFIG DEDUPE — providers/config.ts is a barrel over zai-config.ts
 *      (ONE syncZaiConfigFile — the ProviderCredential fallback rides for
 *      every importer).
 *   7. CAPABILITY LANGUAGE — the five labels speak the operator's words
 *      (Script writing / Voiceover / Transcription / Artwork / Scene
 *      animation), asr IS in the routes' capability lists.
 */

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  CAPABILITY_META,
  IMAGE_PROVIDERS,
  PROVIDERS_BY_CAPABILITY,
  imageTestFreeLane,
  type CapabilityId,
} from "../src/lib/tubeforge/providers/registry";
import { ASR_WORD_TIMESTAMP_SUPPORT } from "../src/lib/tubeforge/providers/asr";

let pass = 0;
let fail = 0;
const fails: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    fail++;
    const msg = e instanceof Error ? e.message : String(e);
    fails.push(`${name}: ${msg.split("\n")[0].slice(0, 220)}`);
    console.log(`  FAIL ${name} — ${msg.split("\n")[0].slice(0, 220)}`);
  }
}

const CAPS: CapabilityId[] = ["chat", "tts", "asr", "image", "video"];

console.log("\n== 1. CATALOG INTEGRITY ==");
check("every capability list has unique provider ids", () => {
  for (const cap of CAPS) {
    const ids = PROVIDERS_BY_CAPABILITY[cap].map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, `${cap}: ${ids.join(",")}`);
  }
});
check("key-requiring providers carry https keyUrls; local rows exempt", () => {
  for (const cap of CAPS) {
    for (const p of PROVIDERS_BY_CAPABILITY[cap]) {
      if (p.requiresKey === false) continue;
      assert.ok(p.keyUrl.startsWith("https://"), `${cap}/${p.id} keyUrl: ${p.keyUrl}`);
    }
  }
});
check("the requiresKey:false rows are exactly the keyless family", () => {
  const keyless = CAPS.flatMap((c) =>
    PROVIDERS_BY_CAPABILITY[c].filter((p) => p.requiresKey === false).map((p) => `${c}:${p.id}`)
  ).sort();
  assert.deepEqual(keyless, [
    "chat:lmstudio",
    "chat:ollama",
    "image:pollinations",
    "tts:kokoro",
  ]);
});

console.log("\n== 2. FRIENDLY LAYER ==");
check("EVERY entry carries tier + pricing + setup (no blank panels)", () => {
  for (const cap of CAPS) {
    for (const p of PROVIDERS_BY_CAPABILITY[cap]) {
      assert.ok(p.tier, `${cap}/${p.id} tier`);
      assert.ok(p.pricing && p.pricing.length > 8, `${cap}/${p.id} pricing`);
      assert.ok(p.setup, `${cap}/${p.id} setup`);
      assert.ok(p.setup.steps.length >= 2, `${cap}/${p.id} steps`);
      for (const [i, s] of p.setup.steps.entries()) {
        assert.ok(s.trim().length > 8, `${cap}/${p.id} step ${i + 1}`);
      }
      for (const url of [p.setup.consoleUrl, p.setup.docsUrl, p.setup.pricingUrl]) {
        if (url) assert.ok(url.startsWith("https://"), `${cap}/${p.id} url ${url}`);
      }
    }
  }
});
check("tiers are from the closed set; zai rows are the free tier", () => {
  const TIERS = new Set(["free", "local", "budget", "premium"]);
  for (const cap of CAPS) {
    for (const p of PROVIDERS_BY_CAPABILITY[cap]) {
      assert.ok(TIERS.has(p.tier as string), `${cap}/${p.id} tier ${p.tier}`);
    }
  }
  for (const cap of CAPS) {
    const zai = PROVIDERS_BY_CAPABILITY[cap].find((p) => p.id === "zai");
    assert.ok(zai, `${cap}/zai exists`);
    // video/zai is honestly "budget" (CogVideoX bills per clip — the free
    // lane there is Ken Burns mode, which needs no AI video at all).
    if (cap !== "video") assert.equal(zai.tier, "free", `${cap}/zai tier`);
  }
});
check("every provider mentions a key format or is keyless", () => {
  for (const cap of CAPS) {
    for (const p of PROVIDERS_BY_CAPABILITY[cap]) {
      if (p.requiresKey === false) continue;
      assert.ok(p.setup.keyFormat, `${cap}/${p.id} keyFormat`);
    }
  }
});

console.log("\n== 3. AFFORDABILITY SHAPE ==");
check("each capability keeps at least one $0 lane", () => {
  const free = (cap: CapabilityId): string[] =>
    PROVIDERS_BY_CAPABILITY[cap]
      .filter((p) => p.tier === "free" || p.tier === "local")
      .map((p) => p.id);
  assert.ok(free("chat").length >= 3, `chat free lanes: ${free("chat").join(",")}`);
  assert.ok(free("tts").length >= 3, `tts free lanes: ${free("tts").join(",")}`);
  assert.ok(free("asr").length >= 2, `asr free lanes: ${free("asr").join(",")}`);
  assert.ok(free("image").length >= 4, `image free lanes: ${free("image").join(",")}`);
  assert.ok(free("video").length >= 2, `video free lanes: ${free("video").join(",")}`);
});
check("imageTestFreeLane agrees with the free image lanes", () => {
  assert.equal(imageTestFreeLane("pollinations", ""), true);
  assert.equal(imageTestFreeLane("cloudflare", "anything"), true);
  assert.equal(imageTestFreeLane("huggingface", "x"), true);
  assert.equal(imageTestFreeLane("nvidia", "x"), true);
  assert.equal(imageTestFreeLane("together", "black-forest-labs/FLUX.1-schnell-Free"), true);
  assert.equal(imageTestFreeLane("together", "black-forest-labs/FLUX.1.1-pro"), false);
  assert.equal(imageTestFreeLane("openai", "gpt-image-1"), false);
});
check("the image registry backs the ideogram + recraft adapters", () => {
  const ids = IMAGE_PROVIDERS.map((p) => p.id);
  assert.ok(ids.includes("ideogram"), "ideogram row");
  assert.ok(ids.includes("recraft"), "recraft row");
});

console.log("\n== 4. GROQ ASR ==");
check("groq rides the OpenAI-compatible adapter with word timestamps", () => {
  const groq = PROVIDERS_BY_CAPABILITY.asr.find((p) => p.id === "groq");
  assert.ok(groq, "groq ASR row");
  assert.equal(groq.defaultBaseUrl, "https://api.groq.com/openai/v1");
  assert.equal(groq.tier, "free");
  assert.equal(ASR_WORD_TIMESTAMP_SUPPORT.groq, true);
  const src = fs.readFileSync("src/lib/tubeforge/providers/asr.ts", "utf8");
  assert.ok(src.includes('provider === "openai" || provider === "groq"'), "adapter dispatch");
});

console.log("\n== 5. Z.AI LEVELED ==");
check("the video lane's zai-only wall is gone (generic dispatch present)", () => {
  const src = fs.readFileSync("src/lib/tubeforge/render.ts", "utf8");
  assert.ok(!src.includes("only supports Z.ai CogVideoX"), "the old refusal is gone");
  assert.ok(src.includes('import { imageToVideo } from "./providers/video"'), "generic import");
  assert.ok(src.includes("await imageToVideo("), "non-zai dispatch site");
  assert.ok(src.includes("zaiVideoViaClient("), "zai fast path kept");
});
check("default video provider is zai + cogvideox-3", () => {
  const src = fs.readFileSync("src/lib/tubeforge/providers/settings.ts", "utf8");
  assert.ok(src.includes('VIDEO_DEFAULT_MODEL = "cogvideox-3"'), "model default");
  assert.ok(
    /case "video":[\s\S]{0,220}provider: "zai"/.test(src),
    "video defaultFor zai"
  );
});
check("the per-scene i2v readiness no longer demands zai", () => {
  const src = fs.readFileSync("src/lib/tubeforge/render.ts", "utf8");
  assert.ok(!src.includes('provider === "zai";\n      } catch'), "old readiness shape gone");
  assert.ok(src.includes("i2vReady = true"), "any-provider readiness");
});

console.log("\n== 6. CONFIG DEDUPE ==");
check("providers/config.ts is a barrel over zai-config.ts", () => {
  const src = fs.readFileSync("src/lib/tubeforge/providers/config.ts", "utf8");
  assert.ok(src.includes('from "../zai-config"'), "re-export");
  assert.ok(!src.includes("writeFileSync"), "no second implementation");
});

console.log("\n== 7. CAPABILITY LANGUAGE ==");
check("the five labels speak the operator's lanes", () => {
  assert.equal(CAPABILITY_META.chat.label, "Script writing");
  assert.equal(CAPABILITY_META.tts.label, "Voiceover");
  assert.equal(CAPABILITY_META.asr.label, "Transcription");
  assert.equal(CAPABILITY_META.image.label, "Artwork");
  assert.equal(CAPABILITY_META.video.label, "Scene animation");
});
check("the settings routes' capability lists include asr", () => {
  const a = fs.readFileSync("src/app/api/settings/route.ts", "utf8");
  const b = fs.readFileSync("src/app/api/settings/ai/score/route.ts", "utf8");
  assert.ok(a.includes('["chat", "tts", "asr", "image", "video"]'), "settings route");
  assert.ok(b.includes('["chat", "tts", "asr", "image", "video"]'), "score route");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("ALL CHECKS FAILED:\n" + fails.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("ALL CHECKS PASS");
