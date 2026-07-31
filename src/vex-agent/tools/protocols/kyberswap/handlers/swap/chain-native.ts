/**
 * Chain-slug and wrapped-native lookups the settlement decoding needs, in the
 * DECLINE-rather-than-throw form those call sites require: a swap that already
 * confirmed on-chain must never be routed to a failure branch because a local
 * registry lookup missed.
 */

import { getKyberChains } from "@tools/kyberswap/chains.js";
import { getKyberWrappedNativeAddress } from "@tools/kyberswap/wrapped-native.js";
import type { KyberChainSlug } from "@tools/kyberswap/types.js";

export function chainIdToSlugSafe(chainId: number): KyberChainSlug | undefined {
  const chains = getKyberChains();
  return chains.find((c) => c.chainId === chainId)?.slug;
}

export function tryGetWrappedNativeAddress(slug: KyberChainSlug): string | undefined {
  try {
    return getKyberWrappedNativeAddress(slug);
  } catch {
    return undefined;
  }
}
