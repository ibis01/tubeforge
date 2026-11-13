// Functional check for the 413 fix in visual-consistency.ts.
// Builds a large synthetic PNG (like a painted storyboard frame), runs it
// through encodeSceneForVlm, and prints the before/after byte sizes so we
// can confirm the VLM request body shrinks well under typical 413 caps.
import sharp from "sharp";
import { encodeSceneForVlm } from "../src/lib/tubeforge/visual-consistency";

async function main() {
  // Synthesize a 1280x720 PNG filled with a gradient (close to a real
  // storyboard frame's dimensions and compressed size).
  const rawPng = await sharp({
    create: {
      width: 1280,
      height: 720,
      channels: 3,
      background: { r: 180, g: 90, b: 40 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          Array.from({ length: 1280 * 720 * 3 }, (_, i) => (i * 7) % 256)
        ),
        raw: { width: 1280, height: 720, channels: 3 },
        blend: "over",
      },
    ])
    .png()
    .toBuffer();

  const part = await encodeSceneForVlm(rawPng);
  const url = part.image_url.url;
  const comma = url.indexOf(",");
  const b64 = url.slice(comma + 1);
  const jpgBytes = Math.ceil((b64.length * 3) / 4);

  console.log("part.type            :", part.type);
  console.log("mime                 :", url.slice(0, url.indexOf(";")));
  console.log("raw PNG bytes        :", rawPng.length);
  console.log("encoded JPEG bytes   :", jpgBytes);
  console.log("shrink ratio         :", (jpgBytes / rawPng.length).toFixed(3));
  console.log("6-image batch est    :", (jpgBytes * 6).toLocaleString(), "bytes");

  // Decode the returned JPEG to prove it's a real, valid image.
  const meta = await sharp(Buffer.from(b64, "base64")).metadata();
  console.log("decoded JPEG meta    :", `${meta.width}x${meta.height} ${meta.format}`);

  // Simulated full 12-scene VLM body (2 batches of 6) — well under a 1 MB
  // proxy cap, the threshold that produced the 413 in the screenshot.
  const batchBody = 6 * jpgBytes;
  console.log("\nverdict              :", batchBody < 1_000_000 ? "PASS — under 1 MB/batch" : "REVIEW");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
