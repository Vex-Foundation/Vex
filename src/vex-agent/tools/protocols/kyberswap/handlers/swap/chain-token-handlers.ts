/**
 * The read-only chain and token lookups of the KyberSwap namespace —
 * `kyberswap.chains`, `kyberswap.tokens.check`. No wallet, no signing, no
 * session state.
 */

import { getKyberChains } from "@tools/kyberswap/chains.js";
import { getKyberCommonClient } from "@tools/kyberswap/common/client.js";
import type { KyberChainInfo } from "@tools/kyberswap/types.js";
import { getKyberTokenApiClient } from "@tools/kyberswap/token-api/client.js";
import { resolveChainWithId } from "@tools/kyberswap/helpers.js";
import { describeFailureForAgent } from "../../../runtime/errors.js";
import type { ProtocolHandler } from "../../../types.js";
import { bool, str, ok, fail } from "../../../handler-helpers.js";

/** Why a row carries no live `state`. A null state always names one of these. */
const STATE_NOT_REQUESTED = "liveStatus was not set, so no live read was made";
const STATE_NOT_IN_LIVE_LIST = "KyberSwap Common Service did not carry this chain in its live list";

export const CHAIN_TOKEN_HANDLERS: Record<string, ProtocolHandler> = {
  // The registry is the spine: it owns `slug`, the one field every other
  // kyberswap call needs, and it cannot fail on a provider outage. The Common
  // Service's live per-chain state is JOINED onto it by chainId when
  // `liveStatus` asks for it - the merge of what used to be two tools one
  // suffix apart.
  //
  // C23 (Codex final-review finding 8) survives the merge as the join
  // DIRECTION: rows are the registry's, so a provider chain we do not execute
  // (Scroll/zkSync, or a brand-new one we have not onboarded) is still never
  // re-advertised as Vex-supported. The join can add a state, never a chain.
  //
  // A Common Service failure degrades to `state: null` plus the sanitized cause
  // in `stateReason` rather than failing the call: the registry half is the
  // half the next call depends on, and dropping it because a status endpoint is
  // down is a strictly worse answer than an honestly-null field.
  "kyberswap.chains": async (p) => {
    const wantsLive = bool(p, "liveStatus") === true;

    let liveByChainId: Map<number, KyberChainInfo> | null = null;
    let liveFailureReason: string | null = null;
    if (wantsLive) {
      try {
        const supported = await getKyberCommonClient().getSupportedChains();
        liveByChainId = new Map(supported.map((c) => [c.chainId, c]));
      } catch (err) {
        liveFailureReason = `KyberSwap Common Service unavailable (${describeFailureForAgent(err)})`;
      }
    }

    const chains = getKyberChains().map((chain) => {
      const live = liveByChainId?.get(chain.chainId) ?? null;
      return {
        ...chain,
        state: live?.state ?? null,
        stateReason: live !== null
          ? null
          : wantsLive
            ? liveFailureReason ?? STATE_NOT_IN_LIVE_LIST
            : STATE_NOT_REQUESTED,
        chainName: live?.chainName ?? null,
        displayName: live?.displayName ?? null,
      };
    });

    return ok({
      liveStatus: wantsLive,
      // `null` when no live read was asked for - "not attempted" is a different
      // answer from "attempted and failed".
      liveStatusAvailable: wantsLive ? liveFailureReason === null : null,
      count: chains.length,
      chains,
    });
  },

  "kyberswap.tokens.check": async (p) => {
    // `tokenAddress`, never the retired `address` — the fleet convention key.
    // The runtime rejects an unknown param by name before this runs, so a call
    // still spelling it `address` is refused rather than silently read here.
    const chain = str(p, "chain"), tokenAddress = str(p, "tokenAddress");
    if (!chain || !tokenAddress) return fail("Missing required: chain, tokenAddress");
    const { chainId } = resolveChainWithId(chain);
    const info = await getKyberTokenApiClient().getHoneypotFotInfo(chainId, tokenAddress);
    return ok({ chain, chainId, tokenAddress, ...info });
  },
};
