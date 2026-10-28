// net-guard.ts — outbound-fetch hardening for TubeForge (server-side only).
//
// Every server-side fetch of a REMOTE url goes through safeFetch():
//   • http/https only
//   • DNS-resolves the host and REJECTS private / loopback / link-local /
//     reserved addresses (SSRF protection — cloud metadata, LAN services, …)
//   • follows redirects MANUALLY and re-validates every hop
//     (redirect: "follow" would happily hop from a public url to 169.254.169.254)
//   • enforces a total byte cap even when the server lies about content-length
//   • enforces a timeout via AbortSignal
//
// Local-first escape hatch: when TubeForge is intentionally pointed at a
// self-hosted AI server (Ollama, LM Studio, …) set
//   TUBEFORGE_ALLOW_PRIVATE_HOSTS=1
// in .env to permit private addresses for PROVIDER calls only. Voice imports
// and media downloads stay locked to public hosts regardless.

import dns from "node:dns/promises";
import net, { type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

// ---------------------------------------------------------------- IP ranges

const V4_BLOCKED: [number, number][] = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8         "this network"
  [0x0a000000, 0x0affffff], // 10.0.0.0/8        private
  [0x64400000, 0x647fffff], // 100.64.0.0/10     CGNAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8       loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16    link-local (cloud metadata!)
  [0xac100000, 0xac1fffff], // 172.16.0.0/12     private
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24      IETF protocol assignments
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24      TEST-NET-1
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16    private
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15     benchmarking
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24   TEST-NET-2
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24    TEST-NET-3
  [0xe0000000, 0xefffffff], // 224.0.0.0/4       multicast
  [0xf0000000, 0xffffffff], // 240.0.0.0/4       reserved + broadcast
];

function v4ToLong(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

function isBlockedV4(ip: string): boolean {
  const long = v4ToLong(ip);
  if (long === null) return true; // unparsable → treat as hostile
  return V4_BLOCKED.some(([lo, hi]) => long >= lo && long <= hi);
}

/** Expand an IPv6 string to its 8 hextets ("::" filled with zeros). */
function v6Hextets(ip: string): bigint[] | null {
  if (!ip.includes(":")) return null;
  // Strip zone id (fe80::1%eth0)
  const clean = ip.split("%")[0];
  const halves = clean.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string) =>
    side === "" ? [] : side.split(":").filter(Boolean);
  let head = parseSide(halves[0] ?? "");
  let tail = parseSide(halves[1] ?? "");

  // Embedded IPv4 (e.g. ::ffff:192.168.0.1) → convert the last 32 bits.
  const last = tail[tail.length - 1] ?? head[head.length - 1] ?? "";
  if (last.includes(".")) {
    const long = v4ToLong(last);
    if (long === null) return null;
    const hi = Math.floor(long / 0x10000);
    const lo = long % 0x10000;
    const v4Hextets = [hi.toString(16), lo.toString(16)];
    if (tail.length && tail[tail.length - 1].includes(".")) {
      tail = [...tail.slice(0, -1), ...v4Hextets];
    } else {
      head = [...head.slice(0, -1), ...v4Hextets];
    }
  }

  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;
  const full = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (full.length !== 8) return null;
  const out: bigint[] = [];
  for (const h of full) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
    out.push(BigInt(parseInt(h, 16)));
  }
  return out;
}

function isBlockedV6(ip: string): boolean {
  const h = v6Hextets(ip);
  if (!h) return true; // unparsable → hostile
  const asBig = h.reduce((acc, v) => (acc << 16n) | v, 0n);
  const top16 = h[0];
  if (asBig === 0n) return true; // :: unspecified
  if (asBig === 1n) return true; // ::1 loopback
  // IPv4-mapped ::ffff:0:0/96 → check the embedded v4
  if (h[0] === 0n && h[1] === 0n && h[2] === 0n && h[3] === 0n && h[4] === 0n && h[5] === 0xffffn)
    return isBlockedV4(`${h[6] >> 8n}.${(h[6] & 0xffn) >> 0n}.${h[7] >> 8n}.${h[7] & 0xffn}`);
  // NAT64 64:ff9b::/96 → embedded v4
  if (h[0] === 0x64n && h[1] === 0xff9bn && h[2] === 0n && h[3] === 0n && h[4] === 0n && h[5] === 0n)
    return isBlockedV4(`${h[6] >> 8n}.${h[6] & 0xffn}.${h[7] >> 8n}.${h[7] & 0xffn}`);
  if ((top16 & 0xfe00n) === 0xfc00n) return true; // fc00::/7 unique-local
  if ((top16 & 0xffc0n) === 0xfe80n) return true; // fe80::/10 link-local
  if ((top16 & 0xff00n) === 0xff00n) return true; // ff00::/8 multicast
  if (top16 === 0x2001n && h[1] === 0xdb8n) return true; // documentation
  if (top16 === 0x100n) return true; // 100::/64 discard-only
  return false;
}

/** True when the string is an IP literal (v4 or v6, brackets stripped). */
export function isIpLiteral(host: string): boolean {
  if (net.isIP(host)) return true;
  return host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

/** Static check: does this hostname look like a private/reserved address? */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!isIpLiteral(host)) return false;
  return host.includes(":") ? isBlockedV6(host) : isBlockedV4(host);
}

// ------------------------------------------------------------ URL validation

export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlGuardError";
  }
}

function friendlyBlockReason(host: string): string {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h.startsWith("127.") || h === "::1") return "loopback (this machine)";
  if (h.startsWith("169.254.")) return "link-local (cloud metadata)";
  if (h.startsWith("10.") || h.startsWith("192.168.")) return "private network";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return "private network";
  return "a private or reserved address range";
}

export interface GuardOptions {
  /** Allow private/loopback targets (self-hosted AI endpoints). */
  allowPrivateHosts?: boolean;
}

/**
 * Validate a destination BEFORE connecting: protocol, port and — after DNS
 * resolution — every resolved address must be public.
 */
export async function assertSafeRemoteUrl(
  rawUrl: string | URL,
  opts: GuardOptions = {}
): Promise<URL> {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
  } catch {
    throw new UrlGuardError("That is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new UrlGuardError(
      `Blocked protocol "${url.protocol.replace(":", "")}" — only http(s) links are allowed`
    );
  if (!url.hostname) throw new UrlGuardError("The URL has no host");

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const standardPort = port === 80 || port === 443;
  if (!standardPort && !opts.allowPrivateHosts)
    throw new UrlGuardError(
      `Blocked non-standard port ${port} — only 80/443 are allowed`
    );

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIpLiteral(host)) {
    if (!opts.allowPrivateHosts && isPrivateHostname(host))
      throw new UrlGuardError(
        `Blocked — ${host} is ${friendlyBlockReason(host)}`
      );
    return url;
  }

  // Real hostname: resolve it and check EVERY address (A + AAAA).
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UrlGuardError(`Could not resolve the host "${host}" — check the link`);
  }
  if (addresses.length === 0)
    throw new UrlGuardError(`Could not resolve the host "${host}"`);
  if (!opts.allowPrivateHosts) {
    for (const { address } of addresses) {
      if (isPrivateHostname(address))
        throw new UrlGuardError(
          `Blocked — "${host}" resolves to ${address}, ${friendlyBlockReason(address)}`
        );
      if (address.includes(":") ? isBlockedV6(address) : isBlockedV4(address))
        throw new UrlGuardError(
          `Blocked — "${host}" resolves to ${address}, ${friendlyBlockReason(address)}`
        );
    }
  }
  return url;
}

// ----------------------------------------------------------------- safeFetch

export interface SafeFetchOptions extends GuardOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: BodyInit;
  /** Hard timeout for the whole operation (default 120s). */
  timeoutMs?: number;
  /** Maximum response body size (default 100 MB). */
  maxBytes?: number;
  /** Maximum redirect hops, each re-validated (default 5). */
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ------------------------------------------------------- DNS-rebinding pinning
//
// Pre-flight DNS checks alone leave a TOCTOU gap: fetch() resolves the
// hostname a SECOND time, so a hostile DNS server can answer public for the
// guard and private for the actual connection (classic DNS rebinding). The
// fix is to pin: a custom `lookup` hook on the undici dispatcher validates
// EVERY resolved address and hands the socket exactly one vetted IP — the
// connection has no chance to resolve anywhere else. TLS SNI/certificate
// verification still uses the hostname, so https stays fully verified.

const pinnedLookup: LookupFunction = (hostname, _options, callback) => {
  const host = String(hostname)
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .split("%")[0]; // strip IPv6 zone id
  dns
    .lookup(host, { all: true, verbatim: true })
    .then((addrs) => {
      if (addrs.length === 0) {
        callback(new Error(`DNS rebinding guard: no addresses for "${host}"`), "", 0);
        return;
      }
      for (const { address } of addrs) {
        if (isPrivateHostname(address)) {
          callback(
            new Error(
              `DNS rebinding guard: "${host}" resolves to ${address}, a private or reserved address — blocked`
            ),
            "",
            0
          );
          return;
        }
      }
      // Deterministic dial: first public IPv4, else the first address.
      const pick = addrs.find((a) => a.family === 4) ?? addrs[0];
      callback(null, pick.address, pick.family);
    })
    .catch((err: Error) => callback(err, "", 0));
};

let validatingAgent: Agent | undefined;
function validatingDispatcher(): Agent {
  // autoSelectFamily:false keeps lookups single-address — the pinned,
  // validated IP is exactly what gets dialed (no per-family re-resolution).
  validatingAgent ??= new Agent({
    connect: {
      autoSelectFamily: false,
      lookup: pinnedLookup,
    } as never,
  });
  return validatingAgent;
}

/**
 * Hardened fetch: validated destination, DNS-PINNED connection (no rebinding
 * gap), manual + re-validated redirects, total-timeout and a byte cap that
 * holds even without a content-length header. Returns a Response whose body
 * errors out if it exceeds maxBytes; `response.url` carries the final URL.
 */
export async function safeFetch(
  rawUrl: string | URL,
  opts: SafeFetchOptions = {}
): Promise<Response> {
  const {
    timeoutMs = 120_000,
    maxBytes = 100 * 1024 * 1024,
    maxRedirects = 5,
    allowPrivateHosts = false,
    headers,
  } = opts;

  let current = await assertSafeRemoteUrl(rawUrl, { allowPrivateHosts });
  let method = opts.method;
  let body = opts.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const init: UndiciRequestInit = {
      method,
      headers,
      body: body as UndiciRequestInit["body"],
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    };
    const res = await (allowPrivateHosts
      ? undiciFetch(current, init) // self-hosted endpoints: no pinning needed
      : undiciFetch(current, { ...init, dispatcher: validatingDispatcher() }));

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get("location");
      if (!location) return res as unknown as Response; // 3xx without a target
      if (hop === maxRedirects)
        throw new UrlGuardError(`Too many redirects (>${maxRedirects})`);
      res.body?.cancel().catch(() => {});
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new UrlGuardError("The server sent a malformed redirect target");
      }
      // 303 (and 301/302 on POST) switch to GET with no body per the spec.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      // Re-validate EVERY hop — redirects must never reach private space.
      current = await assertSafeRemoteUrl(next, { allowPrivateHosts });
      continue;
    }

    // Size enforcement: header pre-check + streaming cap.
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes)
      throw new UrlGuardError(
        `Response is ${(declared / 1024 / 1024).toFixed(0)} MB — the limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MB`
      );

    const finish = (stream: ReadableStream<Uint8Array> | null): Response => {
      const out = new Response(stream, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers as unknown as Headers,
      });
      // Constructed Responses report url "" — expose the real final URL so
      // callers (voice import filename, error messages) see where we landed.
      try {
        Object.defineProperty(out, "url", { value: current.toString(), configurable: true });
      } catch {
        /* cosmetic only */
      }
      return out;
    };

    if (!res.body) return finish(null);
    let received = 0;
    const source = res.body as unknown as ReadableStream<Uint8Array>;
    const capped = source.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > maxBytes) {
            controller.error(
              new UrlGuardError(
                `Download exceeded the ${(maxBytes / 1024 / 1024).toFixed(0)} MB limit`
              )
            );
            return;
          }
          controller.enqueue(chunk);
        },
      })
    );
    return finish(capped);
  }
  throw new UrlGuardError(`Too many redirects (>${maxRedirects})`);
}

/** Read a safeFetch response fully, with the byte cap already enforced. */
export async function safeFetchBuffer(url: string | URL, opts: SafeFetchOptions = {}) {
  const res = await safeFetch(url, opts);
  if (!res.ok)
    throw new UrlGuardError(`The site answered ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}
