/**
 * Inclusive chain resolver with capability provenance (LOCKED correction #2).
 *
 * Two resolvers exist in the codebase, with a hard capability boundary:
 *
 * - STRICT (Khalani-only): `resolveChainId` in `tools/khalani/chains.ts`. Khalani
 *   quote/bridge code paths MUST keep using it so a local-only chain (e.g. 4663)
 *   can never be treated as Khalani-supported.
 * - INCLUSIVE (this module): Khalani FIRST (a chain genuinely present in the
 *   Khalani dynamic registry wins), local registry as FALLBACK. Consumers that
 *   act on any chain Vex can reach — wallet send, direct-RPC balances, portfolio
 *   mapping, and later uniswap/relay — use this and branch on `source`.
 *
 * Khalani-first order also means that if Khalani later adds a chain we currently
 * treat as local, the dynamic registry wins automatically.
 */

import { VexError, ErrorCodes } from "../../errors.js";
import { getCachedKhalaniChains, resolveChainId } from "../khalani/chains.js";
import type { ChainFamily, KhalaniChain } from "../khalani/types.js";
import {
  getLocalChain,
  resolveLocalChainId,
  type LocalChainConfig,
  type LocalChainFamily,
} from "./registry.js";

export type ChainSource = "khalani" | "local";

export type InclusiveEvmChain =
  | {
      source: "khalani";
      chainId: number;
      family: ChainFamily;
      khalaniChain: KhalaniChain;
      /** Mutable copy for viem-chain builders that require `KhalaniChain[]`. */
      khalaniChains: KhalaniChain[];
    }
  | {
      source: "local";
      chainId: number;
      family: LocalChainFamily;
      config: LocalChainConfig;
    };

/**
 * Resolve a chain alias / name / numeric id to a chain Vex can reach, tagging
 * the provenance. Throws a `VexError` when the input matches neither the Khalani
 * registry nor the local registry.
 *
 * Note: Khalani's `resolveChainId` does a numeric passthrough for any positive
 * integer, so we require the resolved id to be genuinely present in the Khalani
 * registry before tagging it `khalani`; otherwise we fall through to local.
 */
export async function resolveInclusiveEvmChain(input: string): Promise<InclusiveEvmChain> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new VexError(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN, "Chain value cannot be empty.");
  }

  // ── Khalani FIRST — but only when genuinely registered. ──
  //
  // The registry FETCH is separated from the alias LOOKUP (SPEC §1.5) because
  // the two failures mean opposite things to the agent: a fetch failure is a
  // transient outage in which EVERY chain looks unknown, while a lookup miss is
  // a permanent verdict about this one alias. Collapsing both into
  // "Unsupported chain: base" told the agent to stop asking for a chain we
  // support.
  let khalaniChains: KhalaniChain[] = [];
  let registryFailure: unknown;
  try {
    khalaniChains = await getCachedKhalaniChains();
  } catch (err) {
    registryFailure = err;
  }
  try {
    const khalaniId = resolveChainId(trimmed, khalaniChains);
    const khalaniChain = khalaniChains.find((chain) => chain.id === khalaniId);
    if (khalaniChain) {
      return {
        source: "khalani",
        chainId: khalaniId,
        family: khalaniChain.type,
        khalaniChain,
        khalaniChains: [...khalaniChains],
      };
    }
    // resolveChainId returned a numeric passthrough that is not actually in the
    // registry — fall through to the local registry below.
  } catch {
    // Not a Khalani chain — try the local registry next.
  }

  // ── Local registry FALLBACK. ──
  const localId = resolveLocalChainId(trimmed);
  if (localId !== undefined) {
    const config = getLocalChain(localId);
    if (config) {
      return { source: "local", chainId: localId, family: config.family, config };
    }
  }

  if (registryFailure !== undefined) {
    const unreachable = new VexError(
      ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
      `Could not resolve chain "${input}": the Khalani chain registry is unreachable, so no chain outside the local registry can be recognised right now.`,
      "This is a registry outage, not an unknown chain — retry shortly, or use a chain in the local registry.",
    );
    unreachable.cause = registryFailure;
    unreachable.retryable = true;
    throw unreachable;
  }

  throw new VexError(
    ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
    `Unsupported chain: ${input}`,
    "The chain is not in the Khalani registry or the local chain registry.",
  );
}
