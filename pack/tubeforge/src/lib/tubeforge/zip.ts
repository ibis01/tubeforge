// Minimal, dependency-free ZIP writer (DEFLATE via Node zlib).
// Supports enough of the ZIP spec for file archives: local headers, central
// directory, and end-of-central-directory record.

import { deflateRawSync } from "zlib";

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
