#!/usr/bin/env node
// Measure the real boot payload of the TubeForge root page in dev mode:
// fetch the HTML, extract every asset it references, download each,
// and report total bytes (raw + gzipped as the wire would carry them).
const BASE = process.env.TF_BASE || "http://localhost:3000/";

const html = await (await fetch(BASE, { headers: { "Accept-Encoding": "identity" } })).text();

const urls = new Set();
for (const m of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
  const u = m[1];
  if (u.startsWith("/_next") || u.startsWith("/api") === false && u.endsWith(".css") || u.includes("chunks")) {
    urls.add(u.startsWith("http") ? u : BASE.replace(/\/$/, "") + u);
  }
}

let raw = 0, wire = 0, count = 0, biggest = { url: "", bytes: 0 };
const rows = [];
await Promise.all([...urls].map(async (u) => {
  try {
    const r = await fetch(u, { headers: { "Accept-Encoding": "gzip" } });
    const buf = Buffer.from(await r.arrayBuffer());
    const enc = r.headers.get("content-encoding") || "identity";
    raw += Number(r.headers.get("content-length") || buf.length);
    wire += buf.length;
    count++;
    if (buf.length > biggest.bytes) biggest = { url: u.slice(-70), bytes: buf.length };
    rows.push({ u: u.slice(-60), wire: buf.length, enc });
  } catch (e) { /* skip */ }
}));

rows.sort((a, b) => b.wire - a.wire);
const mb = (n) => (n / 1048576).toFixed(2);
console.log(`assets: ${count}`);
console.log(`wire total (as downloaded): ${mb(wire)} MB`);
console.log(`raw total (decompressed): ${mb(raw)} MB`);
console.log(`biggest chunk: ${biggest.bytes} bytes -> ${biggest.url}`);
console.log("top 10 by wire size:");
rows.slice(0, 10).forEach(r => console.log(`  ${(r.wire/1024).toFixed(0).padStart(6)} KB  ${r.enc.padEnd(5)}  ${r.u}`));
for (const kbps of [24, 250, 1000, 5000]) {
  const sec = (wire * 8) / kbps;
  console.log(`@ ${String(kbps).padStart(4)} kbps → ~${sec < 90 ? Math.round(sec) + " s" : (sec / 60).toFixed(1) + " min"} (HTML+API excluded)`);
}
