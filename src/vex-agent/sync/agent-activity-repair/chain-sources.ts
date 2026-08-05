/**
 * WHERE A READ-ONLY RPC COMES FROM, and the production observation dep built on
 * it — the sweep's WIRING, split out from its POLICY.
 *
 * A different reason to change from `../agent-activity-repair.js`: that file
 * decides what an observation MEANS for a money row; this one decides which
 * client can answer at all. Chain registries change when Vex adds a chain; the
 * terminality rules change when the money contract changes. Keeping them in one
 * file is what pushed it past the 550-line limit.
 *
 * LOOKUP-ONLY BY CONSTRUCTION: nothing here holds a signer, and no
 * send/broadcast/sign capability is importable from any of the three sources.
 */

import {
  asJsonRpcClient,
  observeEvmTransaction,
  type EvmObservation,
} from "./observation.js";
import type { RepairDeps } from "../agent-activity-repair.js";

/**
 * Production `observeTransaction` — a read-only client per chain, reached
 * through its EIP-1193 `request` under ONE deadline. Never holds a
 * signer/wallet client.
 *
 * WHY `request` AND NOT THE viem ACTION: `client.getTransactionReceipt` takes
 * `{ hash }` only and forwards no caller signal, so wrapping it in an
 * `AbortController` cancels nothing — it would inherit only the transport's own
 * 30 s timeout with 2 retries, whose worst case EXCEEDS the claim lease the
 * observation must fit inside. `observation.ts` holds the full contract.
 *
 * PER-RUN CLIENT MEMO: the resolved client is cached per `chainId` for the
 * lifetime of ONE run (this closure), so chain discovery costs at most one round
 * trip per distinct chain per run rather than one per candidate row. A new run
 * builds new deps and re-resolves, so a chain-list change is picked up on the
 * next tick.
 *
 * A chain no source knows yields `rpc_error` — "we could not look" — which is
 * the truth, and is emphatically NOT an inclusion conclusion: an unresolvable
 * chain must never start the A6 clock.
 */
export function buildProductionRepairDeps(): RepairDeps {
  const clientsByChainId = new Map<number, Promise<unknown>>();
  const resolveClient = (chainId: number): Promise<unknown> => {
    let cached = clientsByChainId.get(chainId);
    if (!cached) {
      cached = resolveReadOnlyReceiptClient(chainId);
      clientsByChainId.set(chainId, cached);
    }
    return cached;
  };

  return {
    observeTransaction: async (input): Promise<EvmObservation> => {
      const client = asJsonRpcClient(await resolveClient(input.chainId));
      if (!client) {
        return { kind: "rpc_error", reason: `no read-only RPC is configured for chain ${input.chainId}` };
      }
      return await observeEvmTransaction(client, input);
    },
  };
}

/**
 * THREE CHAIN SOURCES, ONE POSTURE. Each is a CHAIN SOURCE — a way to obtain a
 * read-only RPC for a chain id — never per-protocol verification; the sweep's
 * behavior is identical whichever one answers.
 *
 *   1. Khalani's live chain list (the bridge venue's own registry) answers first.
 *   2. The LOCAL `evm-chains` registry — chains Vex operates on directly without
 *      Khalani. Robinhood Chain (4663) lives ONLY here, which is why the stuck
 *      row that motivated this change could not even get a client before.
 *   3. The Pendle registry, for the chains neither of the above carries. Pendle
 *      executes on 11 chains, some of which Khalani has never heard of (Monad,
 *      143) — without this source those rows could never be repaired at all.
 *
 * `null` when no source knows the chain. Only the chain SOURCE widens here: an
 * actual RPC failure is still an observation, not an answer.
 *
 * The return type is `unknown` deliberately: these three factories return viem
 * clients whose surface is far wider than an observation needs, and
 * `asJsonRpcClient` validates the one method used at the boundary rather than
 * asserting someone else's type through an `as`.
 */
export async function resolveReadOnlyReceiptClient(chainId: number): Promise<unknown> {
  try {
    const { getKhalaniClient } = await import("@tools/khalani/client.js");
    const { getChain } = await import("@tools/khalani/chains.js");
    const { createDynamicPublicClient } = await import("@tools/khalani/evm-client.js");
    const chains = await getKhalaniClient().getChains();
    const chain = getChain(chainId, chains);
    return createDynamicPublicClient(chain, chains);
  } catch {
    // Khalani does not carry this chain (or its chain list is unavailable) —
    // fall through to the next chain source rather than reporting "no answer".
  }
  try {
    const { getLocalChain } = await import("@tools/evm-chains/registry.js");
    const local = getLocalChain(chainId);
    if (local) {
      const { getLocalPublicClient } = await import("@tools/evm-chains/evm-client.js");
      return getLocalPublicClient(local);
    }
  } catch {
    // Same posture — try the last source.
  }
  try {
    const { getPendleChain } = await import("@tools/pendle/chains.js");
    if (!getPendleChain(chainId)) return null;
    const { getPendlePublicClient } = await import("@tools/pendle/evm-client.js");
    return getPendlePublicClient(chainId);
  } catch {
    return null;
  }
}
