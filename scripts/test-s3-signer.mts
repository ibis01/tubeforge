// The s3 signer battery — node-compatible (node:http + fetch), zero deps.
//
//   npm run test:s3-signer
//
// Guards the two signer invariants that production depended on:
//   1. THE SERVER-SIDE LAW — every signed request (object GET and the
//      bucket-level ListObjectsV2 with its EMPTY-key canonical URI) must
//      verify THE WAY S3 ACTUALLY VALIDATES: the fake server rebuilds the
//      canonical request from the bytes it received and compares signatures.
//      A trailing slash on the LIST canonical URI, an unsorted query, or a
//      mismatched signed-header set all fail here — exactly as AWS/R2 would.
//   2. THE PARITY LAW — object-GET paths and presigned URLs keep their
//      pre-2026-11 shapes (RFC3986-encoded keys, path-style addressing).
// Plus s3List() behavior: continuation-token rounds, URL-decoded keys, and
// a 403 that surfaces the bucket's XML error code.
//
// Run under bun too (bun handles node:http):  bun run scripts/test-s3-signer.mts

import http from "node:http";
import { createHash, createHmac } from "node:crypto";

const sha256Hex = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

let failed = false;
function ok(cond: unknown, msg: string): asserts cond {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failed = true;
    console.error(`  ✗ ${msg}`);
  }
}

/** Freeze Date so the module's amzDate is deterministic (2013-05-24T00:00:00Z). */
function freezeClock(): void {
  const FIXED_MS = 1369353600000;
  class FixedDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(FIXED_MS);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static now(): number {
      return FIXED_MS;
    }
  }
  (globalThis as { Date: unknown }).Date = FixedDate;
}

/** INDEPENDENT server-side SigV4 verification — how AWS/R2 validate requests. */
function serverVerify(req: http.IncomingMessage, rawUrl: string, secret: string, keyId: string) {
  const auth = String(req.headers["authorization"] ?? "");
  const cred = /Credential=([^,]+),/.exec(auth)?.[1] ?? "";
  const signedHeaders = /SignedHeaders=([^,]+),/.exec(auth)?.[1] ?? "";
  const gotSig = /Signature=([0-9a-f]{64})$/.exec(auth)?.[1] ?? "";
  const [first, ...rest] = cred.split("/");
  const scope = rest.join("/");
  if (first !== keyId) return { ok: false, why: `credential key ${first}` };
  if (!gotSig) return { ok: false, why: "no Authorization signature" };

  const canonHeaders: string[] = [];
  for (const name of signedHeaders.split(";")) {
    const v = req.headers[name];
    if (v === undefined) return { ok: false, why: `signed header "${name}" missing from request` };
    canonHeaders.push(`${name}:${String(v).trim()}\n`);
  }
  const [path, search = ""] = rawUrl.split("?");
  const pairs = search
    .split("&")
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`);
  const payloadHash = String(req.headers["x-amz-content-sha256"] ?? sha256Hex(""));
  const canonical = [req.method, path, pairs.join("&"), canonHeaders.join(""), signedHeaders, payloadHash].join("\n");
  const dateStamp = scope.split("/")[0];
  const region = scope.split("/")[1];
  const sts = [
    "AWS4-HMAC-SHA256",
    String(req.headers["x-amz-date"] ?? ""),
    `${dateStamp}/${region}/s3/aws4_request`,
    sha256Hex(canonical),
  ].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), "s3"), "aws4_request");
  const expected = createHmac("sha256", kSigning).update(sts).digest("hex");
  return gotSig === expected ? { ok: true, why: "signature verified" } : { ok: false, why: `signature ${gotSig.slice(0, 12)}… != expected ${expected.slice(0, 12)}…` };
}

async function main(): Promise<void> {
  console.log("◆ s3 signer battery — server-side SigV4 verification + s3List behavior");

  freezeClock();
  const { s3Fetch, s3Presign, s3List } = await import("../src/lib/tubeforge/storage-s3");

  const keyId = "TESTKEYIDEXAMPLE01";
  const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const baseCfg = {
    bucket: "testbucket",
    region: "us-east-1",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    accessKeyId: keyId,
    secretAccessKey: secret,
  };

  // 1. THE SERVER-SIDE LAW — bucket-level LIST (empty-key canonical URI).
  {
    const seen: { rawUrl: string; verify: { ok: boolean; why: string } } = { rawUrl: "", verify: { ok: false, why: "not called" } };
    const server = http.createServer((req, res) => {
      seen.rawUrl = req.url ?? "";
      seen.verify = serverVerify(req, seen.rawUrl, secret, keyId);
      res.end(`<ListBucketResult><IsTruncated>false</IsTruncated><Key>videos/a.png</Key></ListBucketResult>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const res = await s3Fetch("GET", "", { ...baseCfg, endpoint: `http://127.0.0.1:${port}` }, undefined, {
      "list-type": "2",
      prefix: "videos/",
      "max-keys": "1000",
    });
    await res.text();
    server.close();
    ok(seen.verify.ok, `the bucket ACCEPTS the signed LIST (${seen.verify.why})`);
    ok(seen.rawUrl.startsWith("/testbucket?"), `canonical URI "/testbucket" — no trailing slash on the empty-key LIST (${seen.rawUrl.split("?")[0]})`);
    ok(seen.rawUrl.includes("list-type=2&max-keys=1000&prefix=videos%2F"), "query sorted + encoded exactly as signed");
  }

  // 2. THE SERVER-SIDE LAW — object GET (spaces in the key, RFC3986).
  {
    const seen: { rawUrl: string; verify: { ok: boolean; why: string } } = { rawUrl: "", verify: { ok: false, why: "not called" } };
    const server = http.createServer((req, res) => {
      seen.rawUrl = req.url ?? "";
      seen.verify = serverVerify(req, seen.rawUrl, secret, keyId);
      res.end("bytes");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const res = await s3Fetch("GET", "a b/c.png", { ...baseCfg, endpoint: `http://127.0.0.1:${port}` });
    ok((await res.text()) === "bytes", "object GET round-trips");
    server.close();
    ok(seen.rawUrl.startsWith("/testbucket/a%20b/c.png"), `object path preserved + space RFC3986-encoded (${seen.rawUrl.split("?")[0]})`);
    ok(seen.verify.ok, `object GET signature verifies server-side (${seen.verify.why})`);
  }

  // 3. Presign shape unchanged (host-only signed headers, UNSIGNED-PAYLOAD).
  {
    const pre = s3Presign(baseCfg, "a b/c.png", 300);
    ok(pre.startsWith(`${baseCfg.endpoint}/testbucket/a%20b/c.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&`) && pre.includes("&X-Amz-Signature="), "presign URL shape unchanged");
  }

  // 4. s3List — 2 pages, continuation-token round, URL-decoded keys.
  {
    const pages: string[] = [];
    const server = http.createServer((req, res) => {
      const raw = req.url ?? "";
      pages.push(raw);
      const token = /continuation-token=([^&]+)/.exec(raw)?.[1];
      if (!token) {
        res.end(`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>Tok%2B1%2FA%3D</NextContinuationToken><Key>videos/a%20b.png</Key><Key>videos/c%2Fd.webp</Key></ListBucketResult>`);
        return;
      }
      // The token round-trips raw + encoded once — the pre-rewrite facade behavior.
      if (token !== "Tok%252B1%252FA%253D") {
        res.statusCode = 500;
        res.end(`bad token: ${token}`);
        return;
      }
      res.end(`<ListBucketResult><IsTruncated>false</IsTruncated><Key>videos/%D0%B0bc.svg</Key></ListBucketResult>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const keys = await s3List({ ...baseCfg, endpoint: `http://127.0.0.1:${port}` }, "videos/");
    server.close();
    ok(pages.length === 2, `exactly 2 pages fetched (${pages.length})`);
    ok(JSON.stringify(keys) === JSON.stringify(["videos/a b.png", "videos/c/d.webp", "videos/аbc.svg"]), "keys URL-decoded exactly like the list() contract");
  }

  // 5. LIST failure surfaces the bucket's XML error code (self-diagnosing).
  {
    const server = http.createServer((_req, res) => {
      res.statusCode = 403;
      res.end(`<?xml><Error><Code>SignatureDoesNotMatch</Code><Message>bad</Message></Error>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    let thrown = "";
    try {
      await s3List({ ...baseCfg, endpoint: `http://127.0.0.1:${port}` }, "x/");
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
    server.close();
    ok(thrown.includes("→ 403") && thrown.includes("SignatureDoesNotMatch"), `LIST failure carries status + provider code (${thrown.slice(0, 60)}…)`);
  }

  if (failed) process.exit(1);
  console.log("  ✓ signer battery green");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
