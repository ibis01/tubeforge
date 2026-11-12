// S102 / P0.4 — the trusted-proxy IP law. PURE and dependency-free: this
// module is imported by the EDGE middleware's rate-limit.ts, so it must
// never touch the DB or node-only runtime (the S98 build lesson — a
// server-only import dragged into a client/edge bundle breaks the build).
//
// THE SPOOF IT CLOSES: both old IP resolvers took x-forwarded-for's FIRST
// value — the entry the CLIENT typed. Any attacker could rotate fake IPs to
// evade the per-IP gates, or WORSE, name a victim's IP and have the victim's
// bucket flooded (clientIp keys the S46 login lockout — a lockout poison).
// The law: walk the chain RIGHT to LEFT (the closest proxy appends the
// rightmost entry), skip TRUSTED proxies, and the first untrusted entry is
// the client. A spoofed leftmost value is ignored whenever a real proxy
// appended a public IP — which is every supported topology.

/** Loopback (v4/v6) — always trusted. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "0.0.0.0", "::"]);

/** Configured extra trusted proxies (CIDRs / exact IPs), read per call so tests can flip it. */
function extraTrusted(): string[] {
  return (process.env.TUBEFORGE_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isPrivateIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n > 255)) return false;
  const [a, b] = octets;
  return (
    a === 10 || // 10/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 169 && b === 254) || // 169.254/16 link-local (platform metadata ranges)
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT / Tailscale
    a === 127 // the rest of loopback
  );
}

/** True when `ip` may be a reverse proxy WE trust (never a client we count). */
export function isTrustedProxyIp(ip: string): boolean {
  const candidate = ip.trim();
  if (LOOPBACK.has(candidate) || isPrivateIpv4(candidate)) return true;
  // IPv6 link-local (fe80::/10) and unique-local (fc00::/7) prefixes.
  const low = candidate.toLowerCase();
  if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
  // Configured extras — exact IP or IPv4 CIDR.
  for (const entry of extraTrusted()) {
    if (entry === candidate) return true;
    const cidr = entry.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
    if (cidr) {
      const toInt = (dotted: string) =>
        dotted.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
      const candidateInt = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3})$/);
      if (!candidateInt) continue;
      const bits = Number(cidr[2]);
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((toInt(candidateInt[1]) & mask) === (toInt(cidr[1]) & mask)) return true;
    }
  }
  return false;
}

/**
 * The client IP behind a (possibly chained) reverse proxy. Right-to-left
 * walk, trusted entries skipped — the first untrusted entry wins; an
 * all-trusted chain falls back to its leftmost entry. No XFF → x-real-ip
 * (also proxy-set) → "local". Pure and clock-free — unit-pinned for the
 * spoofing law.
 */
export function trustedClientIp(headers: { get(name: string): string | null }): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const entries = xff
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (!isTrustedProxyIp(entries[i])) return entries[i];
    }
    return entries[0] ?? "local"; // every entry trusted — direct private traffic
  }
  return headers.get("x-real-ip")?.trim() || "local";
}
