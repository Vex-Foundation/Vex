/**
 * The read-only chain and token lookups of the KyberSwap namespace —
 * `kyberswap.chains`, `kyberswap.chains.supported`, `kyberswap.tokens.check`.
 * No wallet, no signing, no session state.
 */

import { getKyberChains } from "@tools/kyberswap/chains.js";
import { getKyberCommonClient } from "@tools/kyberswap/common/client.js";
import { getKyberTokenApiClient } from "@tools/kyberswap/token-api/client.js";
import { resolveChainWithId } from "@tools/kyberswap/helpers.js";
import type { ProtocolHandler } from "../../../types.js";
import { str, ok, fail } from "../../../handler-helpers.js";

export const CHAIN_TOKEN_HANDLERS: Record<string, ProtocolHandler> = {
  "kyberswap.chains": async () => ok(getKyberChains()),
  // C23 (Codex final-review finding 8): intersect the provider's live list
  // with OUR registry so a chain we no longer execute (Scroll/zkSync) — or a
  // brand-new provider chain we haven't onboarded — is never re-advertised as
  // Vex-supported.
  "kyberswap.chains.supported": async () => {
    const supported = await getKyberCommonClient().getSupportedChains();
    const localChainIds = new Set<number>(getKyberChains().map((c) => c.chainId));
    return ok(supported.filter((c) => localChainIds.has(c.chainId)));
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
