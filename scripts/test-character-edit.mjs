// Verify zai.images.generations.edit works: portrait -> same identity, new expression.
import fs from "fs";
import ZAI from "z-ai-web-dev-sdk";

const OUT = "/home/z/my-project/uploads/_charlab";
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const zai = await ZAI.create();

  // 1) Generate a reference portrait (1024x1024)
  console.time("portrait");
  const gen = await zai.images.generations.create({
    prompt:
      "Character reference portrait of a 35-year-old male history narrator with short dark hair, neat beard, round glasses, wearing a deep burgundy cardigan over a charcoal shirt. Warm confident smile, studio lighting, plain dark teal background, semi-realistic digital illustration style, head and shoulders, facing camera. No text.",
    size: "1024x1024",
  });
  const b64 = gen.data[0]?.base64;
  if (!b64) throw new Error("no image data");
  const portrait = Buffer.from(b64, "base64");
  fs.writeFileSync(`${OUT}/ref-portrait.png`, portrait);
  console.log("portrait saved:", portrait.length, "bytes", Date.now() - 0, "ms");
  console.timeEnd("portrait");

  // 2) Edit: same identity, different pose/expression (identity consistency test)
  console.time("edit");
  const edit = await zai.images.generations.edit({
    prompt:
      "Same character, same face, same glasses and burgundy cardigan, now gesturing with one hand raised as if explaining, slight open-mouth excited expression, waist-up shot, identical art style and lighting. No text.",
    images: [{ url: `data:image/png;base64,${portrait.toString("base64")}` }],
    size: "1024x1024",
  });
  const eb64 = edit.data[0]?.base64;
  if (!eb64) throw new Error("no edit data");
  const edited = Buffer.from(eb64, "base64");
  fs.writeFileSync(`${OUT}/edit-gesture.png`, edited);
  console.timeEnd("edit");
  console.log("edit saved:", edited.length, "bytes");
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
