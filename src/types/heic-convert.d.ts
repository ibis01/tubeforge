// Ambient declaration for heic-convert (S43) — the package ships no types.
// Only the surface replaceSceneImage uses is declared. NOTE (v2.1.0): the
// promise resolves to the encoded image Buffer DIRECTLY — there is no
// {buffer} wrapper (reaching for `.buffer` grabs the Buffer-pool
// ArrayBuffer behind it, which is unrelated memory).
declare module "heic-convert" {
  export interface HeicConvertOptions {
    buffer: Buffer;
    format: "JPEG" | "PNG";
    quality?: number;
  }
  export default function convert(options: HeicConvertOptions): Promise<Buffer>;
}
