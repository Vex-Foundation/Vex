/**
 * `khalani.bridge` staging CAS hooks (split out in 0R.4, refactor-only).
 * Shared by the bridge leg loop and the Vex fee leg: both must persist the
 * hash BEFORE the payload reaches the network, and both must refuse to
 * broadcast an untracked transaction on a CAS miss.
 */

import type { KhalaniStageHandles, KhalaniStageHooks } from "@tools/khalani/bridge-executor.js";
import {
  markActivityBroadcast,
  reserveActivityEvmNonce,
  markActivitySolanaBroadcast,
  markBroadcastAccepted,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

export function khalaniStageHooksFor(rowId: number): KhalaniStageHooks {
  return {
    onNonceReserved: (request) => reserveActivityEvmNonce(rowId, request),
    onHashStaged: async (h: KhalaniStageHandles) => {
      // Nonce-less staging is Solana-only: the dedicated CAS's
      // `chain_family='solana'` predicate makes a nonce-less EVM leg a
      // CAS miss (abort below), never a wrongly-shaped stage. A `null`
      // nonce always carries the blockhash evidence (W5 §2/R2b) - see
      // `KhalaniStageHandles`'s discriminated-union doc.
      const res = h.nonce === null
        ? await markActivitySolanaBroadcast(rowId, {
            txHash: h.txHash, fromAddress: h.fromAddress,
            recentBlockhash: h.recentBlockhash, lastValidBlockHeight: h.lastValidBlockHeight,
          })
        : await markActivityBroadcast(rowId, { txHash: h.txHash, fromAddress: h.fromAddress, nonce: h.nonce });
      if (!res.applied) {
        throw new Error(`agent_activity: staging CAS miss for event ${rowId} - refusing to broadcast untracked`);
      }
    },
    onAccepted: async () => {
      const r = await markBroadcastAccepted(rowId);
      if (!r.applied) logger.warn("khalani.bridge.broadcast_accept_miss", { id: rowId });
    },
  };
}
