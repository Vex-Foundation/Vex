/**
 * Production wiring for the Z500 allocation sync.
 *
 * This object IS the workflow's reachable surface: reads from Ansem and
 * Indexify, the ONE allocation mutation, venue-side token REGISTRATION
 * (the Indexify team's prescribed lever for the listings gate), the run
 * ledger, a key-presence probe, and a clock. `swap`, `retryOrder`, `sellAllPartial`, `createStack`
 * and every other client member are deliberately not bound here, and the
 * non-goals test pins the exact key set so a future edit that widens this
 * surface fails a test before it reaches review.
 */

import { getAnsemClient } from "@tools/ansem/client.js";
import { getIndexifyClient, hasIndexifyApiKey } from "@tools/indexify/client.js";
import type { IndexifyStack } from "@tools/indexify/types.js";
import { buildProductionRunRepo } from "./repo.js";
import type { CurrentStackState, Z500SyncDeps } from "./runner.js";

/** Project a live stack row onto the workflow's mint→weight view. */
export function stackToCurrentState(stack: IndexifyStack): CurrentStackState {
  const allocation: Record<string, number> = {};
  const tokens = stack.tokens ?? [];
  const weights = stack.token_weights ?? [];
  for (const [index, token] of tokens.entries()) {
    const weight = Number.parseInt(weights[index] ?? "", 10);
    // A row whose weights cannot be read must not silently compare equal to
    // anything — an impossible weight makes the comparison honestly unequal
    // and the mutation path re-establishes a clean allocation.
    allocation[token.address] = Number.isFinite(weight) ? weight : -1;
  }
  return {
    allocation,
    allocationVersion: stack.current_allocation_version ?? null,
    isClosed: stack.is_closed === true || stack.archived === true,
  };
}

export function buildProductionZ500Deps(): Z500SyncDeps {
  const ansem = getAnsemClient();
  const indexify = getIndexifyClient();
  return {
    fetchSnapshot: () => ansem.fetchSnapshot(),
    readStack: async (stackId) => {
      const stack = await indexify.fetchStack({ stackId });
      return stack === null ? null : stackToCurrentState(stack);
    },
    readVersionHistory: (stackId) => indexify.versionHistory(stackId),
    checkTradability: (mintAddress) => indexify.tradability(mintAddress),
    registerToken: (mintAddress) => indexify.registerToken(mintAddress),
    editAllocation: (stackId, allocation, creatorNote) =>
      indexify.editAllocation(stackId, allocation, creatorNote),
    repo: buildProductionRunRepo(),
    hasIndexifyApiKey,
    now: () => new Date(),
  };
}
