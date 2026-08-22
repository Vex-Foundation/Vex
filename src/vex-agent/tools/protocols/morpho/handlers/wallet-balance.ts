/**
 * `morpho.wallet.balance` - what a wallet holds on one chain, and which Morpho
 * contracts it has already approved to move it.
 *
 * WHY THIS LIVES IN THE MORPHO NAMESPACE rather than reusing a generic balance
 * read. The balance half is the cheap half; the answer this tool exists for is
 * the APPROVAL half, and that is Morpho-specific: the spender set is Morpho
 * Blue, Bundler3, GeneralAdapter1 and Permit2, pinned per chain from Morpho's
 * own registry. `WalletBalances` and `ChainRead erc20_balance` remain the right
 * tools for a plain "how much do I have" question, and the description says so.
 *
 * IT READS ANY ADDRESS. No key is touched, no vault is unlocked, nothing is
 * signed - every call is a `view`. That is what makes it usable as the read
 * before an action as well as an audit of somebody else's exposure.
 *
 * UNKNOWN IS NOT ZERO, end to end. The provider read keeps failed balances and
 * failed allowances in their own fields; this handler surfaces them in the
 * summary rather than letting a partial answer read as a complete one.
 */

import { readMorphoWalletSnapshot } from "@tools/morpho/wallet-reads.js";
import { ok, fail } from "../../handler-helpers.js";
import { parseMorphoWalletBalanceParams } from "../read-params.js";
import {
  MORPHO_ALLOWANCE_NOTE,
  MORPHO_BALANCE_FRESHNESS_NOTE,
  countUnlimitedApprovals,
  projectWalletSnapshot,
} from "../projectors.js";
import { morphoFailureDetail } from "./shared.js";

export async function morphoWalletBalance(
  params: Record<string, unknown>,
): Promise<ReturnType<typeof ok>> {
  const parsed = parseMorphoWalletBalanceParams(params);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;

  let snapshot;
  try {
    snapshot = await readMorphoWalletSnapshot(q.chainId, q.walletAddress, q.tokenAddresses);
  } catch (err) {
    return fail(`morpho__wallet_balance_get failed ${morphoFailureDetail(err)}`);
  }

  const wallet = projectWalletSnapshot(snapshot, q.chainSlug);
  const unlimited = countUnlimitedApprovals(wallet);
  const unreadable = wallet.tokensUnavailable.length;

  return ok({
    summary:
      `${wallet.tokens.length} token(s) read on ${q.chainSlug}`
      + (wallet.native === null
        ? ", and the native balance could NOT be read"
        : `, native balance ${wallet.native.human} ${wallet.native.symbol}`)
      + `. ${unlimited} unlimited Morpho approval(s) standing`
      + (unreadable > 0 ? `, ${unreadable} token(s) UNREADABLE rather than empty` : "")
      + ".",
    asOf: new Date().toISOString(),
    filtersApplied: q.echo,
    wallet,
    notes: {
      allowances: MORPHO_ALLOWANCE_NOTE,
      freshness: MORPHO_BALANCE_FRESHNESS_NOTE,
      unknowns:
        "Anything under `tokensUnavailable`, `allowancesUnavailable`, `spendersUnavailable` or `nativeUnavailable` "
        + "was NOT answered by the node or is not deployed on this chain. Those are unknowns, not zeroes, and must "
        + "never be reported as an absence of funds or of approvals.",
      gas:
        "The native balance is the gas budget. A wallet holding tokens with no native balance cannot send any "
        + "transaction on this chain at all, whatever its approvals say.",
    },
    nextStep:
      "This is a balance read only: nothing here is approved, spent or signed. Use morpho__positions_get for what "
      + "the wallet already holds inside Morpho. To PUT any of this balance to work, quote first with "
      + "morpho__vault_quote or morpho__market_quote and then execute that quote with the matching tool - the vault "
      + "and Blue market mutators do exist, and each one prices, gates and discloses its own approval before it "
      + "signs anything.",
  });
}
