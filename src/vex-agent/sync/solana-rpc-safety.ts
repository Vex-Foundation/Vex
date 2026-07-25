/**
 * Solana RPC safety primitives — SSRF-safe URL selection + genesis-hash
 * cluster verification + a minimal raw JSON-RPC POST helper.
 *
 * EXTRACTED from `bridge-activity-repair.ts` (Phase-2 W4) so the W5 Solana
 * activity sweep (`solana-activity-repair.ts`, design `w5-design.md` §4/R3)
 * can reuse the SAME genesis-verified, SSRF-hardened RPC access pattern
 * instead of duplicating it (R3: "reuse/extract bridge-activity-repair's
 * genesis-check + SSRF-safe RPC module"). `bridge-activity-repair.ts`
 * re-exports every name below unchanged so its own existing tests
 * (`bridge-activity-repair-verification.test.ts`) keep importing from the
 * same module path — this is a MOVE, not a behavior change.
 *
 * SSRF (Blocker 10, Phase-2 W4): a provider-supplied RPC URL is untrusted
 * input. `isSsrfSafeRpcUrl` rejects (fail-closed): non-HTTPS schemes,
 * credentials embedded in the URL, and loopback/private/link-local/
 * unique-local/unspecified hosts. It is SYNTACTIC ONLY — no DNS resolution,
 * no redirect re-validation — so every caller must ALSO pin
 * `redirect: "error"` on the actual fetch (closes DNS-rebinding /
 * redirect-to-private-host) and verify the endpoint's cluster identity via
 * the genesis-hash echo below (closes "wrong/malicious cluster").
 *
 * GENESIS VERIFICATION: the Solana analog of an EVM `eth_chainId` echo —
 * before trusting an RPC's answer (a signature status, a transaction, a
 * block height) for anything that can TERMINALIZE an `agent_activity` row,
 * confirm the endpoint actually serves mainnet-beta. A misconfigured or
 * re-pointed endpoint cannot fake this echo.
 */

import logger from "@utils/logger.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";

/**
 * Solana mainnet-beta genesis hash — an immutable cluster identity constant.
 */
export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/**
 * True iff `rawUrl` is a public HTTPS endpoint safe to use for provider-registry
 * RPC verification. Rejects (fail-closed): non-HTTPS schemes, credentials in the
 * URL, and loopback / private / link-local / unique-local / unspecified hosts
 * (the SSRF surface — a provider registry is untrusted input). Curated/local RPCs
 * bypass this (they are trusted), so this guards ONLY the provider-registry
 * fallback.
 *
 * NAMED LIMITATION (Blocker 10): this check is SYNTACTIC. It does NOT resolve DNS
 * and does NOT re-validate on HTTP redirects — a public-looking DNS name that
 * resolves to a private address (DNS rebinding), or a 3xx that re-points at a
 * private host, is NOT caught here. Two compensating controls close the gap: (a)
 * every verification fetch pins `redirect: "error"`/`fetchOptions.redirect:"error"`
 * so a redirect to a private host is refused, not followed; and (b) the
 * `eth_chainId` (EVM) / genesis-hash (Solana) echo means a re-pointed endpoint
 * cannot fake a confirmation for the expected chain.
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
 * public (allowed). Pure, NO DNS resolution (see `isSsrfSafeRpcUrl`'s named
 * limitation): an IP literal is classified exactly; a DNS name is accepted on its
 * face and defended downstream by redirect-off fetches + the chain-id echo.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  // Strip an IPv6 literal's brackets if a caller passed them through.
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (h === "localhost" || h.endsWith(".localhost")) return true;

  const ipv4 = parseIpv4(h);
  if (ipv4) return isPrivateIpv4(ipv4);

  if (h.includes(":")) return isPrivateIpv6(h);

  // A public DNS name (not an IP literal) — allowed on its face. No resolution is
  // performed here; DNS-rebinding to a private address is out of scope for this
  // syntactic check and is compensated by redirect-off fetches + the chain echo.
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

function isPrivateIpv4(octets: readonly number[]): boolean {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // unspecified / this-network
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fe80")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded v4.
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped?.[1]) {
    const v4 = parseIpv4(mapped[1]);
    return v4 ? isPrivateIpv4(v4) : true;
  }
  // WHATWG URL NORMALIZES mapped addresses to the HEX form before we ever see
  // them (`[::ffff:127.0.0.1]` → hostname `[::ffff:7f00:1]`), so the dotted
  // regex above never fires for URL-sourced hosts — decode the embedded v4
  // from the last two 16-bit groups.
  const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1]!, 16);
    const lo = Number.parseInt(hexMapped[2]!, 16);
    return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  // Any other ::ffff:-prefixed shape (or the deprecated ::ffff:0:a.b.c.d SIIT
  // form) — fail closed rather than risk a mis-parse reaching a local target.
  if (h.startsWith("::ffff:")) return true;
  return false;
}

/**
 * Choose the ordered RPC endpoints to verify against: curated/local
 * registry URLs FIRST (trusted, never SSRF-filtered), then provider-registry URLs
 * that pass {@link isSsrfSafeRpcUrl}. De-duplicated, order preserved. An empty
 * result means "no safe RPC" — the caller reports unverifiable and the row
 * stays pending (fail-closed).
 */
export function selectVerificationRpcUrls(input: {
  readonly curated: readonly string[];
  readonly providerRegistry: readonly string[];
}): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (url: string): void => {
    const trimmed = url.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };
  for (const url of input.curated) push(url);
  for (const url of input.providerRegistry) if (isSsrfSafeRpcUrl(url)) push(url);
  return ordered;
}

/** Minimal JSON-RPC POST for Solana verification: redirect OFF (SSRF), 15s timeout, no auth headers. Returns `result`. */
export async function solanaRpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`solana rpc ${method}: http ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error !== null && body.error !== undefined) throw new Error(`solana rpc ${method}: rpc error`);
  return body.result;
}

/**
 * The genesis-hash cluster echo (the Solana analog of an EVM `eth_chainId`
 * check): `true` only when `rpcUrl` actually serves mainnet-beta. `false` on
 * any mismatch, transient error, or malformed response — callers must treat
 * `false` as "cannot trust this endpoint" (fail-closed), never as evidence
 * about the thing being verified.
 */
export async function confirmSolanaMainnetGenesis(rpcUrl: string): Promise<boolean> {
  try {
    const genesis = await solanaRpcCall(rpcUrl, "getGenesisHash", []);
    return typeof genesis === "string" && genesis === SOLANA_MAINNET_GENESIS;
  } catch (err) {
    logger.debug("solana.rpc_safety.genesis_check_failed", {
      error: summarizeProtocolError(err).message,
    });
    return false;
  }
}
