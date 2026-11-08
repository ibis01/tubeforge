// Minimal, dependency-free ZIP writer (DEFLATE via Node zlib).
// Supports enough of the ZIP spec for file archives: local headers, central
// directory, and end-of-central-directory record.
//
// Stage 3 (T-3.6, D-24): two builders —
//   * buildZip(files)       — in-memory, for small bundles (unchanged);
//   * streamZip(entries)    — constant-memory web ReadableStream using the
//     spec's streaming extension (flag bit 3 + data descriptors): the local
//     header goes out with zeroed crc/sizes, the real values follow in a
//     descriptor after the data, and the central directory carries the truth.
//     The export route streams a whole video package through ~2MB of memory
//     instead of buffering every asset at once.

import { createDeflateRaw, deflateRawSync } from "zlib";
import { Readable } from "stream";

/** CRC-32 (IEEE 802.3), table-driven. */
function crc32(buf: Buffer): number {
  let c;
  const table = crcTable();
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Incremental CRC-32 — fold a chunk into the RUNNING state (start 0xffffffff). */
function crc32Fold(buf: Buffer, state: number): number {
  const table = crcTable();
  let acc = state;
  for (let i = 0; i < buf.length; i++) {
    acc = table[(acc ^ buf[i]) & 0xff] ^ (acc >>> 8);
  }
  return acc >>> 0;
}

/** Finalize a running CRC state (XOR out). */
function crc32Finish(state: number): number {
  return (state ^ 0xffffffff) >>> 0;
}

let CRC_TABLE: number[] | null = null;
function crcTable(): number[] {
  if (CRC_TABLE) return CRC_TABLE;
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

interface ZipEntry {
  name: Buffer;
  crc: number;
  compressed: Buffer;
  uncompressedSize: number;
  offset: number;
  method: number;
  modTime: number;
  modDate: number;
}

/** DOS date/time for the current moment. */
function dosDateTime(): { time: number; date: number } {
  const now = new Date();
  const time =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date =
    ((now.getFullYear() - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();
  return { time, date };
}

/**
 * Build a ZIP archive from a list of files.
 * Small files (<64B) are stored raw; larger files are deflated.
 */
export function buildZip(
  files: { name: string; data: Buffer }[]
): Buffer {
  const { time, date } = dosDateTime();
  const chunks: Buffer[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const useDeflate = file.data.length > 64;
    let compressed = file.data;
    let method = 0; // store
    if (useDeflate) {
      const deflated = deflateRawSync(file.data, { level: 9 });
      if (deflated.length < file.data.length) {
        compressed = deflated;
        method = 8; // deflate
      }
    }

    // Local file header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    chunks.push(local, name, compressed);
    entries.push({
      name,
      crc,
      compressed,
      uncompressedSize: file.data.length,
      offset,
      method,
      modTime: time,
      modDate: date,
    });
    offset += local.length + name.length + compressed.length;
  }

  // Central directory
  const cdStart = offset;
  for (const e of entries) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4); // made by: unix, version 30
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8); // flags: UTF-8
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(e.modTime, 12);
    cd.writeUInt16LE(e.modDate, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.compressed.length, 20);
    cd.writeUInt32LE(e.uncompressedSize, 24);
    cd.writeUInt16LE(e.name.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: -rw-r--r--
    cd.writeUInt32LE(e.offset, 42);
    chunks.push(cd, e.name);
    offset += cd.length + e.name.length;
  }
  const cdSize = offset - cdStart;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // cd disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20); // comment len
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

/** Sanitize a string for use inside a ZIP path (no ../, no absolute, no weird chars). */
export function safeZipName(name: string): string {
  return name
    .replace(/[\\/\0-\x1f]/g, " ")
    .replace(/[<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// ---------------------------------------------------------------------------
// Streaming builder (Stage 3, T-3.6 — closes D-24)

export interface StreamZipEntry {
  name: string;
  /** Open the entry's bytes (called once, consumed fully, then dropped). */
  stream: () => NodeJS.ReadableStream | AsyncIterable<Buffer>;
  /**
   * 0 = store (pre-compressed media: mp4/png/jpg/zip/wav-over-64MB…),
   * 8 = deflate (default — text, srt, json, wav). With streaming the method
   * must be chosen BEFORE the data flows (no try-both size comparison).
   */
  method?: 0 | 8;
}

interface StreamedEntry {
  name: Buffer;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  method: number;
  modTime: number;
  modDate: number;
}

async function* toBufferChunks(
  source: NodeJS.ReadableStream | AsyncIterable<Buffer>
): AsyncGenerator<Buffer> {
  if (Symbol.asyncIterator in (source as AsyncIterable<Buffer>)) {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      if (Buffer.isBuffer(chunk) && chunk.length) yield chunk;
      else if (chunk instanceof Uint8Array && chunk.byteLength) yield Buffer.from(chunk);
    }
    return;
  }
  // Node stream → async iteration.
  yield* Readable.from(source as NodeJS.ReadableStream as AsyncIterable<Buffer>);
}

/**
 * Compose a ZIP archive as a web ReadableStream. Emits per entry:
 *   local header (flag bit 3, crc/sizes zeroed)
 *   data chunks (deflated on the fly when method 8; CRC folded over RAW bytes)
 *   data descriptor (signature + crc + sizes — the spec's streaming layout)
 * then the central directory + EOCD with the true values.
 *
 * Peak memory ≈ STREAM_CHUNK + one deflate window — a full video package
 * (final.mp4 + voiceover.wav + storyboard art) flows through a few MB.
 */
export function streamZip(entries: StreamZipEntry[]): ReadableStream<Uint8Array> {
  const { time, date } = dosDateTime();

  const generated = (async function* (): AsyncGenerator<Buffer> {
    const central: StreamedEntry[] = [];
    let offset = 0;

    const emit = function* (buf: Buffer): Generator<Buffer> {
      offset += buf.length;
      yield buf;
    };

    for (const entry of entries) {
      const name = Buffer.from(entry.name, "utf8");
      const method = entry.method ?? 8;

      // Local file header — flag bit 3 set, crc/sizes zero (descriptor after).
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0800 | 0x0008, 6); // UTF-8 names + data descriptor
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(0, 14); // crc — in the descriptor
      local.writeUInt32LE(0, 18); // compressed size — in the descriptor
      local.writeUInt32LE(0, 22); // uncompressed size — in the descriptor
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      yield* emit(local);
      yield* emit(name);

      // Pipe the source: CRC over RAW bytes; deflate when method 8.
      let crcState = 0xffffffff;
      let uncompressed = 0;
      let compressed = 0;

      const source = toBufferChunks(entry.stream());
      if (method === 0) {
        for await (const chunk of source) {
          crcState = crc32Fold(chunk, crcState);
          uncompressed += chunk.length;
          compressed += chunk.length;
          yield* emit(chunk);
        }
      } else {
        // Deflate path: raw chunks are CRC'd, written into the transform,
        // and its output is forwarded as it arrives. The generator's natural
        // pull-based backpressure flows all the way down to the file read.
        const deflate = createDeflateRaw({ level: 6 });
        const ready: Buffer[] = [];
        let finished = false;
        let failure: Error | null = null;
        let wake: (() => void) | null = null;
        const signal = () => {
          wake?.();
          wake = null;
        };
        deflate.on("data", (c: Buffer) => {
          ready.push(c);
          signal();
        });
        deflate.on("end", () => {
          finished = true;
          signal();
        });
        deflate.on("error", (err: Error) => {
          failure = err;
          finished = true;
          signal();
        });

        const drainReady = function* (): Generator<Buffer> {
          // splice(0) takes everything currently queued, in order — the
          // length-checked shift() needed a non-null assertion to say the
          // same thing (S58/T-58.1).
          for (const c of ready.splice(0)) {
            compressed += c.length;
            yield* emit(c);
          }
        };

        let writeFailed = false;
        try {
          for await (const chunk of source) {
            crcState = crc32Fold(chunk, crcState);
            uncompressed += chunk.length;
            yield* drainReady();
            if (!deflate.write(chunk)) {
              await new Promise<void>((resolve) => deflate.once("drain", resolve));
            }
          }
          deflate.end();
        } catch (err) {
          writeFailed = true;
          failure = err instanceof Error ? err : new Error(String(err));
          finished = true;
        }

        while (!finished || ready.length) {
          yield* drainReady();
          if (!finished) await new Promise<void>((resolve) => { wake = resolve; });
        }
        if (failure) throw failure;
        if (writeFailed) throw new Error(`zip stream source failed for ${entry.name}`);
      }

      const crc = crc32Finish(crcState);

      // Data descriptor — signature + crc + both sizes.
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed, 8);
      descriptor.writeUInt32LE(uncompressed, 12);
      yield* emit(descriptor);

      central.push({
        name,
        crc,
        compressedSize: compressed,
        uncompressedSize: uncompressed,
        offset: offset - (compressed + name.length + 30 + 16),
        method,
        modTime: time,
        modDate: date,
      });
    }

    // Central directory (real values — readers reconcile descriptors with it).
    const cdStart = offset;
    for (const e of central) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(0x031e, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0808, 8); // UTF-8 + descriptor flag
      cd.writeUInt16LE(e.method, 10);
      cd.writeUInt16LE(e.modTime, 12);
      cd.writeUInt16LE(e.modDate, 14);
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.compressedSize, 20);
      cd.writeUInt32LE(e.uncompressedSize, 24);
      cd.writeUInt16LE(e.name.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      cd.writeUInt32LE(e.offset, 42);
      yield* emit(cd);
      yield* emit(e.name);
    }
    const cdSize = offset - cdStart;

    // End of central directory.
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    yield* emit(eocd);
  })();

  return Readable.toWeb(Readable.from(generated)) as unknown as ReadableStream<Uint8Array>;
}

/** Pick the ZIP method by file extension (streaming can't try both). */
export function zipMethodFor(fileName: string): 0 | 8 {
  return /\.(mp4|png|jpe?g|zip|mp3|webm|mov)$/i.test(fileName) ? 0 : 8;
}
