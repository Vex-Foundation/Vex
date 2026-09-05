/**
 * Relay-registry EVM client construction for RELAY-ONLY origin chains
 * (Wave-3 W3b / FIX-B blocker 5).
 *
 * A Relay bridge can be REVEALED and QUOTED for a route whose ORIGIN chain lives
 * in Relay's `/chains` registry yet is absent from BOTH the local registry
 * (Robinhood 4663) and the Khalani dynamic registry — R9 reveals Relay precisely
 * when a nonlocal endpoint is not Khalani-serviceable. The origin approve/deposit
 * still has to be signed, so `resolveRelayStepClients` (execute.ts) needs viem
 * clients for that chain. Without this fallback the resolver throws and EVERY
 * Relay-only origin deterministically fails right before signing.
 *
 * This module builds those clients from the UNTRUSTED Relay `/chains` entry,
 * fail-closed:
 *   - the chain must be `vmType:"evm"` (this phase signs only EVM steps);
 *   - the entry's `httpRpcUrl` must be a credential-free PUBLIC HTTPS endpoint —
 *     the registry is untrusted input and the RPC is an SSRF sink, so non-HTTPS,
 *     embedded credentials, or a loopback/private/link-local host are rejected;
 *   - a missing or unsafe RPC THROWS (there is no safe way to sign) rather than
 *     silently falling back to something unvalidated.
 *
 * Relay stays KEYLESS: the private key only signs locally through viem; it is
 * never sent to the registry or attached to the RPC URL as a credential.
 *
 * NOTE (duplication, flagged for consolidation): the SSRF host classifier below
 * mirrors `isSsrfSafeRpcUrl` / `isPrivateOrLoopbackHost` in
 * `vex-agent/sync/bridge-activity-repair.ts` (W4/FIX-C). That module lives in the
 * `vex-agent` layer, which `src/tools/**` must not import (one-way layering), so
 * it cannot be reused here. A future PR can lift a single copy into a shared
 * `src/tools/net` helper that BOTH layers import; kept behaviour-identical here so
 * that dedup is mechanical.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { VexError, ErrorCodes } from "../../errors.js";
import { buildEvmTransport, buildPinnedEvmTransport } from "../evm-chains/rpc-transport.js";
import type { RelayChain } from "./types.js";
import type { RelayStepClients } from "./execute.js";

/** The RPC-relevant subfields Relay's `/chains` entry carries on the passthrough schema. */
const RelayChainRpcSchema = z
  .object({
    httpRpcUrl: z.string().optional(),
    vmType: z.string().optional(),
  })
  .passthrough();

/**
 * True iff `rawUrl` is a credential-free PUBLIC HTTPS endpoint safe to sign
 * against. Rejects (fail-closed): non-HTTPS schemes, URL-embedded credentials,
 * and loopback / private / link-local / unique-local / unspecified hosts.
 */
export function isSsrfSafePublicHttpsUrl(rawUrl: string): boolean {
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

/** Classify a hostname / IP literal as private/loopback/link-local (blocked) vs public (allowed). Pure, no DNS. */
function isPrivateOrLoopbackHost(host: string): boolean {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (h === "localhost" || h.endsWith(".localhost")) return true;

  const ipv4 = parseIpv4(h);
  if (ipv4) return isPrivateIpv4(ipv4);
  if (h.includes(":")) return isPrivateIpv6(h);

  // A public DNS name (not an IP literal) — allowed. DNS-rebinding is out of
  // scope here; the chain-id echo at broadcast time is the second line of defence.
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
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped?.[1]) {
    const v4 = parseIpv4(mapped[1]);
    return v4 ? isPrivateIpv4(v4) : true;
  }
  // WHATWG URL normalizes mapped addresses to the hex form (`::ffff:7f00:1`).
  const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1]!, 16);
    const lo = Number.parseInt(hexMapped[2]!, 16);
    return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  return false;
}

/** viem {@link Chain} for a Relay-only EVM chain — id + rpc + native currency are the load-bearing fields. */
function buildRelayViemChain(chain: RelayChain, rpcUrl: string): Chain {
  const currency = chain.currency;
  return defineChain({
    id: chain.id,
    name: chain.displayName ?? chain.name,
    nativeCurrency: {
      name: currency?.name ?? currency?.symbol ?? "Ether",
      symbol: currency?.symbol ?? "ETH",
      decimals: currency?.decimals ?? 18,
    },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function resolveRelayOnlyChain(
  chainId: number,
  relayChains: readonly RelayChain[],
): { readonly chain: RelayChain; readonly viemChain: Chain; readonly rpcUrl: string } {
  const chain = relayChains.find((candidate) => candidate.id === chainId);
  if (!chain) {
    throw new VexError(
      ErrorCodes.RELAY_UNSUPPORTED_CHAIN,
      `Relay chain ${chainId} is not in the Relay registry - cannot resolve a public client.`,
    );
  }
  const parsed = RelayChainRpcSchema.safeParse(chain);
  const vmType = parsed.success ? parsed.data.vmType : chain.vmType;
  if (vmType !== "evm") {
    throw new VexError(
      ErrorCodes.RELAY_UNSUPPORTED_CHAIN,
      `Relay chain ${chainId} is not an EVM chain - Relay signing is EVM-only this phase.`,
    );
  }
  const rpcUrl = parsed.success ? parsed.data.httpRpcUrl?.trim() : undefined;
  if (!rpcUrl || !isSsrfSafePublicHttpsUrl(rpcUrl)) {
    throw new VexError(
      ErrorCodes.RELAY_UNSUPPORTED_CHAIN,
      `Relay chain ${chainId} exposes no safe public HTTPS RPC - refusing to read against an untrusted or private endpoint.`,
    );
  }
  return { chain, viemChain: buildRelayViemChain(chain, rpcUrl), rpcUrl };
}

/** Public-only client for approval-time contract identity reads on Relay-only EVM chains. */
export function resolveRelayOnlyPublicClient(
  chainId: number,
  relayChains: readonly RelayChain[],
): PublicClient<Transport, Chain> {
  const resolved = resolveRelayOnlyChain(chainId, relayChains);
  // The Relay url goes in as a PROVIDER-tier entry, so the user's own endpoint
  // for this chain (if they configured one) and any bundled entry the table
  // carries come first, and Relay's registry is the tail rather than the only
  // opinion. The SSRF gate above still owns whether the provider url is
  // admissible at all - that check is what makes it safe to consult a registry
  // Vex does not run.
  return createPublicClient({
    chain: resolved.viemChain,
    transport: buildEvmTransport(chainId, { providerUrls: [resolved.rpcUrl] }),
  }) as PublicClient<Transport, Chain>;
}

/**
 * Build origin-chain viem clients for a RELAY-ONLY EVM chain from its untrusted
 * `/chains` registry entry. Throws a `VexError` (fail-closed) when the chain is
 * not in the registry, is not EVM, or exposes no SSRF-safe public HTTPS RPC - the
 * handler records that as a pre-sign failure, never a stranded pending plan.
 */
export function resolveRelayOnlyStepClients(
  chainId: number,
  relayChains: readonly RelayChain[],
  privateKey: Hex,
): RelayStepClients {
  const resolved = resolveRelayOnlyChain(chainId, relayChains);
  // ONE pinned transport for both clients: the approve, the deposit, the nonce
  // and the broadcast all land on the same node.
  const transport = buildPinnedEvmTransport(chainId, { providerUrls: [resolved.rpcUrl] });
  const publicClient = createPublicClient({
    chain: resolved.viemChain,
    transport,
  }) as PublicClient<Transport, Chain>;
  const walletClient = createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: resolved.viemChain,
    transport,
  }) as WalletClient<Transport, Chain, Account>;
  return { publicClient, walletClient };
}
