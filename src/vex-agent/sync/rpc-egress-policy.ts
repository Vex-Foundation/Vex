/**
 * The egress policy for PROVIDER-SUPPLIED RPC URLs: where a verification
 * request is allowed to end up, decided at CONNECT time and pinned for the
 * socket.
 *
 * WHY THIS MODULE EXISTS (external review of PR #142, blocker 1). The previous
 * control was syntactic only: `isSsrfSafeRpcUrl` classified an IP LITERAL and
 * accepted every DNS name on its face, so a provider registry could name
 * `rpc.example.com`, have it resolve to `127.0.0.1` or `169.254.169.254`, and
 * the request reached that target. The `eth_chainId` / genesis echo prevents
 * BELIEVING the answer; it does not prevent the request. A local service that
 * acts on a POST body has already been reached by then.
 *
 * WHAT IS ENFORCED, and where. `createPinnedPublicEgressDispatcher` builds an
 * undici `Agent` whose `connect.lookup` runs before any socket exists:
 *
 *   1. resolve the hostname to ALL its addresses (`all: true`);
 *   2. refuse the connection outright if ANY of them is non-public
 *      (`isPublicIpAddress` below is the closed table, fail-closed on anything
 *      it cannot parse) - refusing on ANY, not on the first, is what removes
 *      the "resolver returns a public and a private address" split;
 *   3. hand exactly ONE validated address back, so the socket connects to the
 *      address we checked. A second resolution between check and connect (the
 *      DNS-rebinding window) cannot happen because there is no second
 *      resolution.
 *
 * TLS IDENTITY IS UNCHANGED BY THE PIN. undici's connector calls
 * `tls.connect({ ...options, servername, host: hostname })` (verified in
 * `node_modules/undici/lib/core/connect.js`, undici 7.25.0): `servername` stays
 * the ORIGINAL hostname, so SNI and certificate verification still run against
 * the name the provider gave us, while `lookup` decides the address. Pinning
 * therefore costs nothing in TLS strength.
 *
 * REDIRECTS ARE NOT FOLLOWED. Every caller pins `redirect: "error"`; a 3xx to a
 * re-pointed host is refused rather than re-validated. These are credential-free
 * reads, so there is nothing a redirect could buy us that is worth the second
 * egress decision.
 *
 * NOT APPLIED TO CURATED URLS. The user's own RPC overrides and the local chain
 * registry are the app's own configuration - a self-hosted archive node on
 * `127.0.0.1` is a supported setup (`@config/chain-rpc-overrides.js`). This
 * policy guards the UNTRUSTED bucket: the Khalani, Relay and viem-bundled
 * registries.
 */

import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";
import type { Dispatcher } from "undici";

/**
 * The refusal an egress decision produces. It travels out of `fetch` as the
 * `cause` of a `TypeError: fetch failed` (measured against undici 7.25.0), so
 * callers classify it with {@link isEgressRefusal}, which walks the cause chain
 * and matches the stable `name` - never message text.
 */
export class RpcEgressRefusedError extends Error {
  /** Stable across bundling and across the cause chain; the classifier matches on it. */
  override readonly name = "RpcEgressRefusedError";
  readonly hostname: string;
  /** The address class that caused the refusal, or the resolver's own failure. */
  readonly refusal: EgressRefusal;

  constructor(hostname: string, refusal: EgressRefusal) {
    super(`rpc egress refused for ${hostname}: ${refusal}`);
    this.hostname = hostname;
    this.refusal = refusal;
  }
}

/**
 * `RequestInit` plus undici's `dispatcher`, which Node's global `fetch` honours
 * at runtime (measured: Node 24.15.0 + undici 7.25.0) while the global DOM-style
 * `RequestInit` type does not declare it. Named here rather than asserted away
 * at each call site.
 */
export interface DispatchableRequestInit extends RequestInit {
  readonly dispatcher?: Dispatcher | undefined;
}

/** Why an egress decision refused. Named so a log line says which control fired. */
export type EgressRefusal = "non_public_address" | "no_address";

/** How far down an error's `cause` chain the egress classifier looks. undici nests one level; four is slack. */
const EGRESS_CAUSE_MAX_DEPTH = 4;

/**
 * True iff this failure is OUR egress refusal rather than an ordinary transport
 * error. Matched by class name through the cause chain, because `fetch` wraps it
 * in a bare `TypeError` whose message is always "fetch failed".
 */
export function isEgressRefusal(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < EGRESS_CAUSE_MAX_DEPTH && node instanceof Error; depth += 1) {
    if (node.name === "RpcEgressRefusedError") return true;
    node = node.cause;
  }
  return false;
}

/**
 * A dispatcher for `fetch` (viem's `fetchOptions.dispatcher`, and our own raw
 * Solana POST) that can only reach PUBLIC addresses, at the address it checked.
 *
 * OWNERSHIP: the caller owns the returned dispatcher and MUST `close()` it when
 * its verification finishes - it holds keep-alive sockets. `lookup` is injected
 * only by tests (the DNS-rebinding transport test scripts it); production uses
 * `node:dns`.
 *
 * `connectTimeoutMs` bounds the connect phase alone; the per-call deadline the
 * caller owns still bounds the whole request.
 */
export function createPinnedPublicEgressDispatcher(options?: {
  readonly lookup?: LookupFunction;
  readonly connectTimeoutMs?: number;
}): Dispatcher {
  const resolve = options?.lookup ?? dnsLookup;
  return new Agent({
    connect: {
      timeout: options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      lookup: pinPublicAddress(resolve),
    },
  });
}

/** Connect-phase bound. Shorter than any per-call deadline so a black-holed address fails fast. */
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * The lookup that decides and pins. Exported for the transport test, which
 * drives it directly for the positive control (a public address is admitted and
 * exactly one address is returned).
 */
export function pinPublicAddress(resolve: LookupFunction): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    resolve(hostname, { ...lookupOptions, all: true }, (err, resolved) => {
      if (err) {
        callback(err, "", undefined);
        return;
      }
      const addresses = toLookupAddresses(resolved);
      if (addresses.length === 0) {
        callback(new RpcEgressRefusedError(hostname, "no_address"), "", undefined);
        return;
      }
      for (const entry of addresses) {
        if (!isPublicIpAddress(entry.address)) {
          callback(new RpcEgressRefusedError(hostname, "non_public_address"), "", undefined);
          return;
        }
      }
      // PIN: one validated address, so the socket goes exactly where the check
      // ran. `options.all` is `true` for every undici call (measured), but the
      // single-address shape is honoured too rather than assumed away.
      const pinned = addresses[0];
      if (!pinned) {
        callback(new RpcEgressRefusedError(hostname, "no_address"), "", undefined);
        return;
      }
      if (lookupOptions.all === true) {
        callback(null, [pinned]);
        return;
      }
      callback(null, pinned.address, pinned.family);
    });
  };
}

/** Normalize both `dns.lookup` shapes into one list, dropping entries we cannot read. */
function toLookupAddresses(resolved: string | readonly LookupAddress[]): LookupAddress[] {
  if (typeof resolved === "string") {
    return resolved.length > 0 ? [{ address: resolved, family: resolved.includes(":") ? 6 : 4 }] : [];
  }
  return resolved.filter((entry): entry is LookupAddress => typeof entry?.address === "string");
}

/**
 * THE ADDRESS TABLE. `true` only for an address that parses AND falls outside
 * every non-public range below; anything unparsable is refused, because an
 * address we cannot classify is an address we cannot clear.
 *
 * Refused: unspecified (`0.0.0.0`, `::`), loopback (`127/8`, `::1`), RFC 1918
 * private (`10/8`, `172.16/12`, `192.168/16`), link-local INCLUDING the cloud
 * metadata address (`169.254/16`, `fe80::/10`), CGNAT (`100.64/10`),
 * IETF protocol assignments (`192.0.0/24`), benchmarking (`198.18/15`),
 * multicast and every reserved range above it (`224/4`, `240/4`, `ff00::/8`),
 * IPv6 unique-local (`fc00::/7`), and the IPv4-mapped / NAT64-embedded forms of
 * all of the above.
 */
export function isPublicIpAddress(address: string): boolean {
  const host = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  // A scoped IPv6 literal (`fe80::1%eth0`) is classified by its address part.
  const bare = host.split("%")[0] ?? "";
  const ipv4 = parseIpv4(bare);
  if (ipv4) return !isNonPublicIpv4(ipv4);
  if (bare.includes(":")) return !isNonPublicIpv6(bare);
  return false; // not an IP literal at all: this function only clears addresses.
}

/**
 * True iff `rawUrl` is a public HTTPS endpoint safe to use for provider-registry
 * RPC verification. Rejects (fail-closed): non-HTTPS schemes, credentials in the
 * URL, and loopback / private / link-local / unique-local / unspecified hosts
 * (the SSRF surface - a provider registry is untrusted input). Curated/local RPCs
 * bypass this (they are trusted), so this guards ONLY the provider-registry
 * fallback.
 *
 * SYNTACTIC, AND NO LONGER ALONE. This is the cheap first pass: it settles IP
 * literals and obvious scheme/credential abuse before any resolver is asked. The
 * DNS name it cannot settle is settled at connect time by
 * {@link createPinnedPublicEgressDispatcher}, which is where the rebinding
 * window actually closes.
 */
export function isSsrfSafeRpcUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  const host = url.hostname.toLowerCase();
  if (host.length === 0) return false;
  return !isPrivateOrLoopbackHost(host);
}

/**
 * Classify a hostname/IP literal as private/loopback/link-local (blocked) vs
 * public (allowed). Pure, NO DNS resolution: an IP literal is classified exactly
 * by the table in {@link isPublicIpAddress}; a DNS name is accepted here and
 * decided at connect time by the pinning dispatcher.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (h === "localhost" || h.endsWith(".localhost")) return true;

  const ipv4 = parseIpv4(h);
  if (ipv4) return isNonPublicIpv4(ipv4);

  if (h.includes(":")) return isNonPublicIpv6(h);

  // A public DNS name (not an IP literal): allowed on its face by this
  // syntactic pass, and resolved + pinned before any socket is opened.
  return false;
}

function parseIpv4(host: string): readonly number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isNonPublicIpv4(octets: readonly number[]): boolean {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // unspecified / this-network
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && (octets[2] ?? 0) === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isNonPublicIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fe80")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
  if (h.startsWith("ff")) return true; // multicast ff00::/8
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): classify the embedded v4.
  const embedded = h.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded?.[1] && (h.startsWith("::ffff:") || h.startsWith("64:ff9b:"))) {
    const v4 = parseIpv4(embedded[1]);
    return v4 ? isNonPublicIpv4(v4) : true;
  }
  // WHATWG URL NORMALIZES mapped addresses to the HEX form before we ever see
  // them (`[::ffff:127.0.0.1]` becomes hostname `[::ffff:7f00:1]`), so the
  // dotted match above never fires for URL-sourced hosts - decode the embedded
  // v4 from the last two 16-bit groups.
  const hexMapped = h.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1] ?? "", 16);
    const lo = Number.parseInt(hexMapped[2] ?? "", 16);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return true;
    return isNonPublicIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  // Any other ::ffff:- or NAT64-prefixed shape (or the deprecated ::ffff:0:a.b.c.d
  // SIIT form) - fail closed rather than risk a mis-parse reaching a local target.
  if (h.startsWith("::ffff:") || h.startsWith("64:ff9b:")) return true;
  return false;
}
