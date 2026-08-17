/**
 * `morpho.vault.quote` - price one vault operation without performing it.
 *
 * THE HANDLER OWNS EXACTLY THREE THINGS and delegates everything else.
 *
 *  1. The product default for slippage, resolved in `read-params/quote.ts` from
 *     `slippage-policy.ts` and passed DOWN explicitly. `src/tools/morpho` holds
 *     no tolerance of its own by construction, so the value the guard is built
 *     from is always one this layer chose.
 *
 *  2. The governance read, which the on-chain preview cannot perform. The
 *     preview reads the vault CONTRACT and therefore knows the share price and
 *     the decimals; it does not know whether a gate can refuse a withdrawal.
 *     Recommending a deposit without that is the hazard `morpho.vault.get`'s own
 *     doctrine already names, so the preview lane must carry it too.
 *
 *  3. Failure separation. The two reads fail INDEPENDENTLY and are reported
 *     that way. A failed preview is a failed call: there is no number to
 *     report and nothing is invented. A failed governance read is NOT, because
 *     the priced operation is still fully known; it degrades to an explicit
 *     `unavailable` that says gating is unknown rather than absent. Collapsing
 *     the second into "no gates" would be the reassuring answer and the wrong
 *     one, and collapsing it into a whole-call failure would throw away a
 *     correct quote over an advisory read.
 *
 * ORDER MATTERS AND IT IS DELIBERATE: the preview runs FIRST. If the operation
 * cannot be built, decoded and bounded at all, no governance read is spent on
 * it. Nothing here signs, sends, approves or broadcasts, and there is no path
 * in this file that could.
 */

import { getMorphoClient } from "@tools/morpho/client.js";
import { previewMorphoVaultOperation } from "@tools/morpho/mutations.js";
import type { Address } from "viem";

import { ok, fail } from "../../handler-helpers.js";
import { parseMorphoVaultQuoteParams } from "../read-params.js";
import {
  MORPHO_QUOTE_GAS_NOTE,
  MORPHO_QUOTE_PREVIEW_NOTE,
  projectQuoteGovernance,
  summariseQuote,
  type MorphoQuoteGovernance,
} from "../projectors.js";
import { morphoFailureDetail } from "./shared.js";

export async function morphoVaultQuote(
  params: Record<string, unknown>,
  context?: { abortSignal?: AbortSignal },
): Promise<ReturnType<typeof ok>> {
  const parsed = parseMorphoVaultQuoteParams(params);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;

  let quote;
  try {
    quote = await previewMorphoVaultOperation({
      chainId: q.chainId,
      vaultAddress: q.vaultAddress as Address,
      direction: q.direction,
      amountRaw: q.amountRaw,
      slippageBps: q.slippageBps,
      ...(q.walletAddress === undefined ? {} : { walletAddress: q.walletAddress as Address }),
    });
  } catch (err) {
    return fail(`morpho.vault.quote failed ${morphoFailureDetail(err)}`);
  }

  const governance = await readGovernance(q.vaultAddress, q.chainId, context?.abortSignal);
  const projectedGovernance = projectQuoteGovernance(governance);

  return ok({
    summary: summariseQuote(quote, projectedGovernance),
    asOf: new Date().toISOString(),
    filtersApplied: q.echo,
    chain: q.chainSlug,
    quote,
    governance: projectedGovernance,
    notes: {
      preview: MORPHO_QUOTE_PREVIEW_NOTE,
      gas: MORPHO_QUOTE_GAS_NOTE,
      scales:
        "`input` and `expectedShares` are in DIFFERENT units and each carries its own `decimals`. Vault shares are "
        + "typically 18 decimals while the asset may be 6, so the two `raw` figures must never be compared, "
        + "subtracted or presented as one quantity.",
      wallet: quote.walletAddressWasSupplied
        ? "`requirements` reflect the wallet you named, so a step already satisfied by an existing approval is "
          + "absent from the list rather than repeated."
        : "No `walletAddress` was supplied, so this preview ran against a stand-in address and `requirements` are "
          + "what a FRESH wallet would face. A wallet that already holds the one-time Permit2 approval would face "
          + "fewer steps. Re-run with `walletAddress` to see the real ones.",
      shape: quote.direction === "deposit"
        ? "A deposit is a Bundler3 multicall and its legs are listed in `bundle.legs`, each decoded and checked "
          + "against Vex's allowlist of permitted contracts and selectors."
        : "A withdrawal is a DIRECT call on the vault itself rather than a bundle, on both vault generations. That "
          + "is why it has no bundle legs, no on-chain share-price guard and usually no requirements. None of those "
          + "absences is a defect or a missing step.",
      simulation: quote.preflight.explanation,
    },
    nextStep:
      "Vex has no Morpho mutating tools, so this preview cannot be turned into a transaction here. Report the "
      + "shares, the requirements and any gating plainly, and say the user would have to perform the approval and "
      + "the deposit themselves.",
  });
}

/**
 * Morpho's own vault read, for the governance facts the on-chain preview cannot
 * see. Advisory: its failure degrades the reply, never fails the call, and the
 * cause travels with it so the agent can say what did not answer.
 */
async function readGovernance(
  vaultAddress: string,
  chainId: number,
  abortSignal: AbortSignal | undefined,
): Promise<MorphoQuoteGovernance> {
  try {
    const detail = await getMorphoClient().getVault(
      { vaultAddress, chainId, includeAllocations: false, includeHistory: false },
      abortSignal,
    );
    return { status: "read", detail };
  } catch (err) {
    return { status: "unavailable", reason: morphoFailureDetail(err) };
  }
}
