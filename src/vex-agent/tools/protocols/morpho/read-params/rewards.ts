/**
 * Input contract for `morpho.rewards.get`.
 *
 * ONE WALLET PER CALL, and it is a privacy decision rather than a technical
 * bound - the same one `positions.ts` makes and for the same reason. A tool that
 * accepted a list of addresses invites an agent to build a comparison of other
 * people's balances from a single prompt.
 *
 * `chainIds` IS A FAN-OUT, NOT A FILTER, and the parser bounds it because of
 * what the provider does rather than what it says. Merkl requires exactly one
 * `chainId` per request and silently ignores a repeated one (live-probed
 * 2026-08-14: `?chainId=8453&chainId=1` returned Base alone), so every chain the
 * caller names costs its own request plus the attribution lookups underneath it.
 * An unbounded list is therefore an unbounded burst against a keyless shared
 * endpoint, and the bound is refused BY NAME rather than trimmed.
 */

import {
  ADDRESS_PATTERN,
  readChains,
  readOptionalBool,
  readOptionalString,
  reject,
  type MorphoParams,
} from "./_primitives.js";
import { MORPHO_SUPPORTED_CHAIN_IDS, morphoChainSlug } from "@tools/morpho/chains.js";

/** Most chains one rewards answer will fan out across. Refused, never trimmed. */
export const MORPHO_REWARDS_MAX_CHAINS = 4;

export interface MorphoRewardsQuery {
  walletAddress: string;
  chainIds: number[];
  morphoOnly: boolean;
  echo: Record<string, unknown>;
}

export function parseMorphoRewardsParams(params: Record<string, unknown>): MorphoParams<MorphoRewardsQuery> {
  const wallet = readOptionalString(params["walletAddress"]);
  if (wallet === undefined) {
    return reject("walletAddress", "`walletAddress` is required: rewards are always read for one named account.");
  }
  if (!ADDRESS_PATTERN.test(wallet)) {
    return reject("walletAddress", `\`walletAddress\` must be a 0x-prefixed 40-hex EVM address. Received "${wallet}".`);
  }

  const chains = readChains(params["chainIds"], "chainIds");
  if (!chains.ok) return chains;
  // Absent means every supported chain, which is what "what can I claim" means
  // when the user named no chain. The fan-out bound below still applies.
  const chainIds = chains.value ?? [...MORPHO_SUPPORTED_CHAIN_IDS];
  if (chainIds.length > MORPHO_REWARDS_MAX_CHAINS) {
    return reject(
      "chainIds",
      `\`chainIds\` names ${chainIds.length} chains, but one rewards answer reads at most ${MORPHO_REWARDS_MAX_CHAINS}. `
      + "Merkl answers one chain per request, so each extra chain is another round trip plus its campaign lookups. "
      + "Name the chains you care about - Vex refuses the list rather than silently reading part of it.",
    );
  }

  const morphoOnly = readOptionalBool(params["morphoOnly"], "morphoOnly");
  if (!morphoOnly.ok) return morphoOnly;

  return {
    ok: true,
    value: {
      walletAddress: wallet.toLowerCase(),
      chainIds,
      // Default false: a claim takes a whole reward token row whatever campaign
      // produced it, so hiding the non-Morpho rows by default would describe a
      // transaction that delivers more than the answer admitted.
      morphoOnly: morphoOnly.value ?? false,
      echo: {
        walletAddress: wallet.toLowerCase(),
        chainIds: chainIds.map((id) => morphoChainSlug(id) ?? String(id)),
        morphoOnly: morphoOnly.value ?? false,
      },
    },
  };
}
