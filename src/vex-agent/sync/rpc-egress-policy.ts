/**
 * The egress policy for PROVIDER-SUPPLIED RPC URLs: where a verification
 * request is allowed to end up, decided at CONNECT time and pinned for the
 * socket.
 *
 * WHY THIS MODULE EXISTS (review finding, 2026-09-04). The previous
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
 * THE ADDRESS TABLE, as CIDR blocks rather than string prefixes.
 *
 * WHY CIDR AND NOT `startsWith` (external review of PR #142 round 2): the
 * previous IPv6 classifier matched `fe80` as TEXT, but link-local is
 * `fe80::/10`, which runs through `febf:ffff:...`, so `fe90::1` was classified
 * public (and `fec0::1`, deprecated site-local, was never considered at all). A
 * prefix expressed in BITS cannot drift from the range it names, so every block
 * below is written as its RFC CIDR and matched numerically against the parsed
 * address.
 *
 * IPv4, refused (RFC 1122, 1918, 2544, 5735, 5737, 6598, 6890):
 * "this network", loopback, CGNAT, link-local (which is where the cloud
 * metadata address lives), the three private ranges, the IETF protocol
 * assignments, the three documentation ranges, benchmarking, multicast,
 * reserved, and broadcast.
 */
export const NON_PUBLIC_IPV4_CIDRS = [
  "0.0.0.0/8", // "this network" / unspecified
  "10.0.0.0/8", // RFC 1918 private
  "100.64.0.0/10", // RFC 6598 CGNAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, incl. 169.254.169.254 cloud metadata
  "172.16.0.0/12", // RFC 1918 private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1 documentation
  "192.168.0.0/16", // RFC 1918 private
  "198.18.0.0/15", // RFC 2544 benchmarking
  "198.51.100.0/24", // TEST-NET-2 documentation
  "203.0.113.0/24", // TEST-NET-3 documentation
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved
  "255.255.255.255/32", // limited broadcast (inside 240/4, named for the table's own sake)
] as const;

/**
 * IPv6, refused outright (RFC 4193, 4291, 6666, 3849, 4380, 8215).
 *
 * `2001::/32` (Teredo) and `64:ff9b:1::/48` (RFC 8215 local-use translation)
 * are refused WHOLE rather than decoded: Teredo tunnels an arbitrary IPv4
 * destination inside the address, and the local-use NAT64 prefix splits its
 * embedded IPv4 around the reserved u-octet at /48. Neither is a destination a
 * provider registry has any honest reason to name, so the conservative
 * classification costs us nothing and guessing at the embedded address could
 * cost us a socket into private space.
 */
export const NON_PUBLIC_IPV6_CIDRS = [
  "::/128", // unspecified
  "::1/128", // loopback
  "64:ff9b:1::/48", // RFC 8215 local-use IPv4/IPv6 translation
  "100::/64", // RFC 6666 discard-only
  "2001::/32", // Teredo
  "2001:db8::/32", // documentation
  "fc00::/7", // unique-local
  "fe80::/10", // link-local (through febf:ffff:...)
  "fec0::/10", // deprecated site-local (RFC 3879), still routed by some stacks
  "ff00::/8", // multicast
] as const;

/**
 * IPv6 blocks that CARRY an IPv4 address: the verdict is the verdict on the
 * embedded IPv4, because that is where the packet ends up. `::ffff:1.1.1.1` is
 * a public destination; `::ffff:127.0.0.1` is loopback wearing a v6 costume,
 * which is the classic bypass this table exists to close.
 *
 * `embeddedAt` is the byte offset of the IPv4 address inside the 16-byte form.
 */
export const EMBEDDED_IPV4_IPV6_CIDRS = [
  { cidr: "::ffff:0:0/96", embeddedAt: 12 }, // IPv4-mapped
  { cidr: "64:ff9b::/96", embeddedAt: 12 }, // RFC 6052 well-known NAT64
  { cidr: "2002::/16", embeddedAt: 2 }, // RFC 3056 6to4
] as const;

/** A CIDR block compiled once into the bytes and bit-length the matcher needs. */
interface AddressBlock {
  readonly cidr: string;
  readonly bytes: readonly number[];
  readonly prefixBits: number;
}

/**
 * Compile a CIDR constant. A malformed constant is a programming error in the
 * table above, not runtime input, so it throws at module load rather than
 * silently classifying nothing.
 */
function compileCidr(cidr: string): AddressBlock {
  const [network, prefix] = cidr.split("/");
  const prefixBits = Number(prefix);
  const bytes = network === undefined ? null : (parseIpv4(network) ?? parseIpv6(network));
  if (!bytes || !Number.isInteger(prefixBits) || prefixBits < 0 || prefixBits > bytes.length * 8) {
    throw new Error(`malformed egress CIDR constant: ${cidr}`);
  }
  return { cidr, bytes, prefixBits };
}

const IPV4_BLOCKS: readonly AddressBlock[] = NON_PUBLIC_IPV4_CIDRS.map(compileCidr);
const IPV6_BLOCKS: readonly AddressBlock[] = NON_PUBLIC_IPV6_CIDRS.map(compileCidr);
const EMBEDDED_BLOCKS: readonly { readonly block: AddressBlock; readonly embeddedAt: number }[] =
  EMBEDDED_IPV4_IPV6_CIDRS.map((entry) => ({ block: compileCidr(entry.cidr), embeddedAt: entry.embeddedAt }));

/** True iff `address` (4 or 16 bytes) falls inside `block`, compared bit by bit. */
function withinBlock(address: readonly number[], block: AddressBlock): boolean {
  if (address.length !== block.bytes.length) return false;
  const wholeBytes = block.prefixBits >> 3;
  for (let i = 0; i < wholeBytes; i += 1) {
    if (address[i] !== block.bytes[i]) return false;
  }
  const remainingBits = block.prefixBits & 7;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((address[wholeBytes] ?? 0) & mask) === ((block.bytes[wholeBytes] ?? 0) & mask);
}

/**
 * THE CLASSIFIER. `true` only for an address that PARSES and falls outside every
 * block above; anything unparsable is refused, because an address we cannot
 * classify is an address we cannot clear.
 */
export function isPublicIpAddress(address: string): boolean {
  const bare = bareHost(address);
  const ipv4 = parseIpv4(bare);
  if (ipv4) return !isNonPublicIpv4(ipv4);
  const ipv6 = parseIpv6(bare);
  if (ipv6) return !isNonPublicIpv6(ipv6);
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
 *
 * AN ADDRESS-SHAPED HOST THAT DOES NOT PARSE IS REFUSED, not passed on as a
 * name. `010.0.0.1`, `0x7f.1` and `2130706433` are all loopback to `getaddrinfo`
 * and none of them is a hostname anybody registers, so they fail closed here
 * instead of being handed to the resolver as if they were DNS names.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  const h = bareHost(host).toLowerCase();

  if (h === "localhost" || h.endsWith(".localhost")) return true;

  const ipv4 = parseIpv4(h);
  if (ipv4) return isNonPublicIpv4(ipv4);

  const ipv6 = parseIpv6(h);
  if (ipv6) return isNonPublicIpv6(ipv6);

  if (h.includes(":") || isNumericHostShape(h)) return true; // address-shaped and unparsable: fail closed.

  // A public DNS name (not an IP literal): allowed on its face by this
  // syntactic pass, and resolved + pinned before any socket is opened.
  return false;
}

/** Strip an IPv6 URL bracket pair and a zone id (`[fe80::1%eth0]`), leaving the address itself. */
function bareHost(host: string): string {
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return unbracketed.split("%")[0] ?? "";
}

/** A host whose every label is decimal, octal or hex digits: an address form, never a registrable name. */
function isNumericHostShape(host: string): boolean {
  if (host.length === 0) return false;
  return host.split(".").every((label) => /^(?:0x[0-9a-f]+|\d+)$/i.test(label));
}

/** Strict dotted quad: four decimal octets, no leading zeros (octal ambiguity), each 0-255. */
function parseIpv4(host: string): readonly number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Parse an IPv6 literal into its 16 bytes, or `null` when it is not one.
 *
 * Handles the whole textual form RFC 4291 defines - full, `::`-compressed, and
 * the dotted-quad tail (`::ffff:127.0.0.1`) - because the classifier has to see
 * the same address the kernel will connect to. A single `::` is allowed once and
 * must stand for at least one group, group values are 1-4 hex digits, and
 * anything else returns `null` so the caller can fail closed.
 */
function parseIpv6(host: string): readonly number[] | null {
  if (!host.includes(":")) return null;
  let text = host.toLowerCase();

  // A dotted-quad tail becomes the two hex groups it stands for, so the rest of
  // the parse deals with one notation only.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const embedded = parseIpv4(tail);
    if (!embedded) return null;
    const hi = ((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0);
    const lo = ((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const sides = text.split("::");
  if (sides.length > 2) return null;
  const head = sides[0] ?? "";
  const tailSide = sides.length === 2 ? (sides[1] ?? "") : "";
  const headGroups = head.length > 0 ? head.split(":") : [];
  const tailGroups = tailSide.length > 0 ? tailSide.split(":") : [];

  let groups: string[];
  if (sides.length === 1) {
    if (headGroups.length !== 8) return null;
    groups = headGroups;
  } else {
    // `::` stands for AT LEAST one zero group, so a compressed address can carry
    // at most seven written groups.
    if (headGroups.length + tailGroups.length > 7) return null;
    const zeros = Array.from({ length: 8 - headGroups.length - tailGroups.length }, () => "0");
    groups = [...headGroups, ...zeros, ...tailGroups];
  }

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function isNonPublicIpv4(octets: readonly number[]): boolean {
  return IPV4_BLOCKS.some((block) => withinBlock(octets, block));
}

function isNonPublicIpv6(bytes: readonly number[]): boolean {
  for (const { block, embeddedAt } of EMBEDDED_BLOCKS) {
    if (!withinBlock(bytes, block)) continue;
    // The packet ends up at the embedded IPv4, so that address is the verdict.
    return isNonPublicIpv4(bytes.slice(embeddedAt, embeddedAt + 4));
  }
  return IPV6_BLOCKS.some((block) => withinBlock(bytes, block));
}
