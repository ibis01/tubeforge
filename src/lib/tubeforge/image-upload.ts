// Uploaded-image byte inspection — the S43 format catalog (PNG / JPEG /
// WebP / HEIC incl. iPhone collection brands) and the WASM HEIC decode.
// Lives BELOW the story/characters graph so every upload seam (Scene
// Studio, S51 reference photos) shares one sniffer without import cycles.

/** The ftyp box carries the brand: bytes 4-8 "ftyp", brand at 8-12 —
 * heic/heix/hevc (photos), mif1/msf1 (image collections iPhone photos also
 * use), heim/heis (media collections). Decoding is NOT ffmpeg's job here —
 * stock builds ship without libheif — but the WASM heic-convert pass in
 * decodeHeicPng. */
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"]);

export function sniffImageFormat(buf: Buffer): "png" | "jpeg" | "webp" | "heic" | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length > 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "webp";
  if (
    buf.length > 12 &&
    buf.subarray(4, 8).toString("ascii") === "ftyp" &&
    HEIF_BRANDS.has(buf.subarray(8, 12).toString("ascii"))
  )
    return "heic";
  return null;
}

/** Decode HEIC/HEIF bytes to PNG via the WASM libheif build (heic-convert).
 * Stock ffmpeg ships without libheif on most distros (including the CI
 * image), so the decode rides a pure-WASM pass instead — same output
 * everywhere, no native dependency. Returns PNG bytes.
 *
 * API note (v2.1.0): convert() resolves to the encoded image Buffer
 * DIRECTLY — there is no {buffer} wrapper. Reaching for `.buffer` on it
 * grabs the Buffer-pool ArrayBuffer behind it (64 KB of unrelated memory),
 * which once aliased the input HEIC and produced a "PNG" that was still
 * HEIC bytes. */
export async function decodeHeicPng(upload: Buffer): Promise<Buffer> {
  // Lazy import: the WASM module only enters the process graph when a HEIC
  // actually arrives (cold start stays free for everyone else).
  const convert = (await import("heic-convert")).default;
  const out = await convert({ buffer: upload, format: "PNG" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}
