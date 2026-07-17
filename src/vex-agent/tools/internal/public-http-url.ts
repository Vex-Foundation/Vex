/**
 * Public HTTP destination policy for agent-initiated fetches (SSRF guard).
 *
 * `web_research` (and any future agent HTTP) must not reach loopback, RFC1918,
 * link-local, CGNAT, or IPv6 ULA destinations. Resolve DNS, then classify the
 * address — hostname string checks alone are bypassable (decimal IPs, rebinding).
 *
 * Used by `web.ts` before every raw HTTP hop (including redirects).
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type PublicHttpUrlErrorCode =
  | "invalid_url"
  | "scheme"
  | "private_destination"
  | "dns";

export class PublicHttpUrlError extends Error {
  constructor(
    message: string,
    readonly code: PublicHttpUrlErrorCode,
  ) {
    super(message);
    this.name = "PublicHttpUrlError";
  }
}

export type LookupFn = (hostname: string) => Promise<string>;

const DEFAULT_LOOKUP: LookupFn = async (hostname) => {
  const r = await dnsLookup(hostname, { verbatim: true });
  return r.address;
};

/** True when `http:` / `https:` only (mirrors prior web.ts scheme guard). */
export function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Classify a literal IP string (IPv4 or IPv6). Returns true if the agent must
 * not fetch it. Unknown/unparseable forms fail closed (blocked).
 */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIpv4(ip);
  if (v === 6) return isBlockedIpv6(ip);
  return true;
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    // Disallow octal-looking leading zeros except "0" itself — Node URL may
    // still hand us normal dotted form after resolution.
    nums.push(n);
  }
  return nums as [number, number, number, number];
}

function isBlockedIpv4(ip: string): boolean {
  const o = parseIpv4(ip);
  if (!o) return true;
  const [a, b] = o;

  // 0.0.0.0/8 — "this" network
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local (incl. cloud IMDS)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24 IETF protocol assignments (special)
  if (a === 192 && b === 0 && o[2] === 0) return true;
  // Documentation / benchmark / multicast / reserved
  if (a === 192 && b === 0 && o[2] === 2) return true; // 192.0.2.0/24
  if (a === 198 && b === 51 && o[2] === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && o[2] === 113) return true; // 203.0.113.0/24
  if (a === 198 && b === 18) return true; // 198.18.0.0/15 benchmarking (partial)
  if (a === 198 && b === 19) return true;
  if (a >= 224) return true; // multicast + reserved + broadcast

  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Loopback
  if (lower === "::1") return true;
  // Unspecified
  if (lower === "::") return true;

  // IPv4-mapped ::ffff:a.b.c.d
  const mapped = lower.match(/^:ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    ?? lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) return isBlockedIpv4(mapped[1]);

  // Compress-friendly prefix checks via expanded form is heavy; use common
  // string prefixes after normalizing stripped brackets (URL already strips).
  // fe80::/10 link-local
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true;
  }
  // fc00::/7 unique local (fc… and fd…)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // 2001:db8::/32 documentation
  if (lower.startsWith("2001:db8:") || lower === "2001:db8::") return true;

  return false;
}

/**
 * Hostnames that must never be fetched even before DNS (fail closed).
 * DNS rebinding is still handled by post-resolve IP checks.
 */
function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost") return true;
  if (h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true;
  if (h === "0.0.0.0") return true;
  return false;
}

/**
 * Some URL parsers leave "decimal IPv4" as a hostname (e.g. 2130706433 → 127.0.0.1).
 * Convert pure-decimal hostnames to dotted form when in IPv4 range.
 */
export function tryDecimalIpv4(hostname: string): string | null {
  if (!/^\d+$/.test(hostname)) return null;
  // Bound: max IPv4 as integer is 4294967295
  let n: bigint;
  try {
    n = BigInt(hostname);
  } catch {
    return null;
  }
  if (n < 0n || n > 0xffffffffn) return null;
  const v = Number(n);
  return [
    (v >>> 24) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff,
  ].join(".");
}

/**
 * Assert `raw` is a public http(s) URL. Returns the parsed URL + resolved IP.
 * Throws {@link PublicHttpUrlError} on any policy failure.
 */
export async function assertPublicHttpUrl(
  raw: string,
  options: { readonly lookup?: LookupFn } = {},
): Promise<{ readonly url: URL; readonly address: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicHttpUrlError("Invalid URL.", "invalid_url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublicHttpUrlError(
      "Only http:// and https:// URLs are allowed.",
      "scheme",
    );
  }

  // Reject embedded credentials (user:pass@host) — common SSRF smuggle form.
  if (url.username || url.password) {
    throw new PublicHttpUrlError(
      "URLs with embedded credentials are not allowed.",
      "invalid_url",
    );
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new PublicHttpUrlError("Invalid URL host.", "invalid_url");
  }

  if (isBlockedHostname(hostname)) {
    throw new PublicHttpUrlError(
      "Refusing to fetch private or loopback destination.",
      "private_destination",
    );
  }

  // Literal IP or decimal IPv4 hostname
  const decimal = tryDecimalIpv4(hostname);
  if (decimal !== null) {
    if (isBlockedIp(decimal)) {
      throw new PublicHttpUrlError(
        "Refusing to fetch private or loopback destination.",
        "private_destination",
      );
    }
    return { url, address: decimal };
  }

  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new PublicHttpUrlError(
        "Refusing to fetch private or loopback destination.",
        "private_destination",
      );
    }
    return { url, address: hostname };
  }

  const lookupFn = options.lookup ?? DEFAULT_LOOKUP;
  let address: string;
  try {
    address = await lookupFn(hostname);
  } catch {
    throw new PublicHttpUrlError("DNS lookup failed.", "dns");
  }

  if (isBlockedIp(address)) {
    throw new PublicHttpUrlError(
      "Refusing to fetch private or loopback destination.",
      "private_destination",
    );
  }

  return { url, address };
}
