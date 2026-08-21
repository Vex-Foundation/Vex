/**
 * The `chain` param of the four single-chain DexScreener tools — one manifest
 * definition and one reader, shared by `handlers/core.ts` and `handlers/orders.ts`.
 *
 * WHY ITS OWN MODULE. `orders` is deliberately not a pair-list handler and must
 * not reach into `./handlers/core.ts`; a second copy of the chain rule is how
 * the two would drift into two different accepted value sets. The manifest side
 * has the same problem: `manifests/core.ts` and `manifests/orders.ts` would
 * otherwise each carry their own sentence about what a chain is.
 *
 * WHY THE PARAM IS CALLED `chain` (W6a). It was `chainId` on all four tools
 * while the value it carried was a SLUG — the key said "Id" and the value said
 * "ethereum". The old spelling is NOT aliased: `runtime/params.ts` rejects it as
 * an unknown key and names `chain` in the allowed list, which is correctable in
 * one turn. A duplicate key is measurably worse than a rejection —
 * `pair-list/list-query.ts` records that a second spelling of the same filter
 * degraded lexical tool retrieval enough to push `khalani.tokens.search` out of
 * the golden top-3.
 *
 * WHY A NUMERIC CHAIN ID IS ACCEPTED. `TokenFind` hands the agent a NUMERIC
 * chain id, so the convention (`conventions.ts` → CANONICAL_CHAIN_SENTENCE)
 * promises every chain-valued param takes either spelling. DexScreener's URL
 * path needs the slug, so the translation happens HERE, in the adapter seam —
 * never in the manifest, which advertises the canonical grammar like every other
 * namespace.
 */

import { chainIdToSlug } from "@tools/kyberswap/chains.js";
import { CANONICAL_CHAIN_SENTENCE } from "../conventions.js";
import type { ProtocolParamDef } from "../types.js";

/** The shared manifest definition — identical on all four single-chain tools. */
export const DEXSCREENER_CHAIN_PARAM: ProtocolParamDef = {
  key: "chain",
  type: "string",
  required: true,
  description:
    "The chain this pool/token lives on, as a DexScreener chain slug (e.g. ethereum, base, "
    + `solana, bsc, arbitrum, robinhood). ${CANONICAL_CHAIN_SENTENCE}`,
};

export type DexScreenerChainRead =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly reason: string };

const DECIMAL_CHAIN_ID = /^\d+$/;

/**
 * Resolve whatever the agent wrote into the slug DexScreener's URL path needs.
 *
 * A slug is passed through with its casing intact — the value sent UPSTREAM is
 * left as the caller wrote it, because normalising the request would change what
 * we ask DexScreener, and DexScreener is the authority on its own slug table.
 * Only the numeric spelling is translated, and an unregistered number is refused
 * by name rather than forwarded to produce an opaque provider 404.
 */
export function resolveDexScreenerChain(raw: string): DexScreenerChainRead {
  const trimmed = raw.trim();
  if (!DECIMAL_CHAIN_ID.test(trimmed)) return { ok: true, slug: trimmed };

  const slug = chainIdToSlug(Number(trimmed));
  if (slug === undefined) {
    return {
      ok: false,
      reason:
        `"chain" was the numeric chain id ${trimmed}, which is not in the chain registry. `
        + "Send a DexScreener chain slug instead (e.g. ethereum, base, solana), or check the id "
        + "with TokenFind.",
    };
  }
  return { ok: true, slug };
}
