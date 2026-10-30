// Perceptual hashing (dHash) for scene-art deduplication.
//
// Why: two scenes of the same video occasionally come out of the image model
// as near-identical frames (same latent, similar prompt). The viewer reads
// that as "the same image twice". A 64-bit dHash (9x8 grayscale, horizontal
// gradient) is enough to catch those duplicates — no AI cost, a single ffmpeg
// call per image.
//
// The bit math is pure and unit-tested; only imageHash() touches ffmpeg and
// it fails open (null) so hashing problems can never break a storyboard run.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * dHash from a 9x8 grayscale rawvideo frame (72 bytes, row-major, one byte
 * per pixel). Bit i = pixel(x+1,y) is brighter than pixel(x,y) with
 * x = i % 8, y = floor(i / 8). Returns a 16-char hex string (64 bits), or
 * null when the buffer isn't exactly 72 bytes.
 */
export function dHashFromGray9x8(bytes: Buffer): string | null {
  if (bytes.length !== 72) return null;
  let hex = "";
  for (let y = 0; y < 8; y++) {
    for (let xByte = 0; xByte < 8; xByte += 4) {
      let nibble = 0;
      for (let k = 0; k < 4; k++) {
        const x = xByte + k;
        const left = bytes[y * 9 + x];
        const right = bytes[y * 9 + x + 1];
        nibble = (nibble << 1) | (right > left ? 1 : 0);
      }
      hex += nibble.toString(16);
    }
  }
  return hex;
}

/** Popcount of XOR between two 16-char hex hashes. null on malformed input. */
export function hammingDistanceHex(a: string, b: string): number | null {
  if (!a || !b || a.length !== 16 || b.length !== 16) return null;
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    const na = parseInt(a[i], 16);
    const nb = parseInt(b[i], 16);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return null;
    let xor = na ^ nb;
    while (xor) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist;
}

/**
 * Distance from `hash` to the CLOSEST entry in `priors` (null when there are
 * no valid priors). `priors` maps scene index → hash.
 */
export function closestPriorDistance(hash: string, priors: Map<number, string>): number | null {
  let best: number | null = null;
  for (const prior of priors.values()) {
    const d = hammingDistanceHex(hash, prior);
    if (d != null && (best == null || d < best)) best = d;
  }
  return best;
}

/** dHash of an image file via ffmpeg (9x8 grayscale rawvideo). Fails open. */
export async function imageHash(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        filePath,
        "-frames:v",
        "1",
        "-vf",
        "scale=9:8,format=gray",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "buffer" }
    );
    return dHashFromGray9x8(stdout as unknown as Buffer);
  } catch {
    return null;
  }
}

/**
 * Hash every scene-XX.png already on disk in `dir` (best effort — unreadable
 * or corrupt images are skipped). Used to seed the dedupe set for a new
 * scene image.
 */
export async function sceneImageHashes(
  dir: string,
  opts?: { exclude?: number }
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!fs.existsSync(dir)) return out;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const m = /^scene-(\d{2})\.png$/.exec(name);
    if (!m) continue;
    const index = Number(m[1]);
    if (opts?.exclude === index) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).size < 1000) continue;
    } catch {
      continue;
    }
    const hash = await imageHash(full);
    if (hash) out.set(index, hash);
  }
  return out;
}
