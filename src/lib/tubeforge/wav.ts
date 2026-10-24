// WAV utilities: parse and merge multiple WAV buffers produced by TTS chunks.
// TTS outputs 24kHz 16-bit mono WAV — all chunks share the same format.

interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm: Buffer;
}

/** Parse a standard RIFF/WAVE buffer, locating the fmt and data chunks. */
export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 44) throw new Error("WAV buffer too small");
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("Not a RIFF file");
  if (buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAVE file");

  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  const pcmParts: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = Math.min(dataStart + chunkSize, buf.length);

    if (chunkId === "fmt ") {
      fmt = {
        channels: buf.readUInt16LE(dataStart + 2),
        sampleRate: buf.readUInt32LE(dataStart + 4),
        bitsPerSample: buf.readUInt16LE(dataStart + 14),
      };
    } else if (chunkId === "data") {
      pcmParts.push(buf.subarray(dataStart, dataEnd));
    }
    offset = dataStart + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }

  if (!fmt) throw new Error("WAV missing fmt chunk");
  if (pcmParts.length === 0) throw new Error("WAV missing data chunk");

  return { ...fmt, pcm: Buffer.concat(pcmParts) };
}

/** Merge N same-format WAV buffers into one continuous WAV buffer. */
export function mergeWavs(buffers: Buffer[]): { buffer: Buffer; durationSec: number } {
  if (buffers.length === 0) throw new Error("No buffers to merge");
  const infos = buffers.map(parseWav);
  const first = infos[0];

  // Validate consistent format across chunks
  for (const info of infos) {
    if (
      info.sampleRate !== first.sampleRate ||
      info.channels !== first.channels ||
      info.bitsPerSample !== first.bitsPerSample
    ) {
      throw new Error("WAV chunk format mismatch");
    }
  }

  const pcm = Buffer.concat(infos.map((i) => i.pcm));

  // Build 44-byte canonical header
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(first.channels, 22);
  header.writeUInt32LE(first.sampleRate, 24);
  header.writeUInt32LE(
    (first.sampleRate * first.channels * first.bitsPerSample) / 8,
    28
  ); // byte rate
  header.writeUInt16LE((first.channels * first.bitsPerSample) / 8, 32); // block align
  header.writeUInt16LE(first.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  const bytesPerSec = (first.sampleRate * first.channels * first.bitsPerSample) / 8;
  const durationSec = pcm.length / bytesPerSec;

  return { buffer: Buffer.concat([header, pcm]), durationSec };
}
