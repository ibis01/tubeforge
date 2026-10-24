// VLM check: portrait identity across storyboard + rendered frames + caption presence.
import ZAI from "z-ai-web-dev-sdk";
import fs from "fs";

const zai = await ZAI.create();
const img = (p) => ({
  type: "image_url",
  image_url: { url: `data:image/png;base64,${fs.readFileSync(p).toString("base64")}` },
});

const ask = async (images, prompt) => {
  const r = await zai.chat.completions.createVision({
    messages: [
      { role: "user", content: [...images.map(img), { type: "text", text: prompt }] },
    ],
    thinking: { type: "disabled" },
  });
  return r.choices[0]?.message?.content ?? "";
};

console.log("=== Identity check: portrait vs storyboard scene 1 (host scene) ===");
console.log(
  await ask(
    ["/tmp/vex-portrait.png", "/tmp/scene1.png"],
    "Image 1 is a character reference portrait. Image 2 is a storyboard scene. Is the same character (same glasses, beard, outfit identity) clearly recognizable in image 2? Answer YES or NO plus one short sentence."
  )
);

console.log("\n=== Rendered frame check (5s, 55s, 138s) ===");
console.log(
  await ask(
    ["/tmp/frame-5s.png", "/tmp/frame-55s.png", "/tmp/frame-138s.png"],
    "These are 3 frames from an auto-generated YouTube video. For each frame answer: (a) is there a burned-in caption/subtitle text at the bottom? (b) does the image look like a complete, well-composed cinematic scene (not broken/glitched)? Be concise."
  )
);
