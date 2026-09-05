/**
 * The launchpad's own calldata, compared BYTE FOR BYTE against ours.
 *
 * WHAT THIS IS FOR, and what it is emphatically not. Vex builds a holder-reward
 * claim and a distribute itself: the target is the distributor the suite's
 * `HolderRewardsDeployer` named in its `DistributorDeployed` event, and the
 * calldata comes from the distributor's verified ABI. The provider's
 * `POST /pools-fun/holder-rewards/prepare` returns its own `{to, data, value}`
 * for the same action, and this module asks ONE question of it: does it agree?
 *
 * A disagreement is a REFUSAL, not a merge and not an override. Two honest
 * parties describing the same transaction should produce identical bytes; when
 * they do not, one of them is describing a different transaction, and on a money
 * path Vex signs neither. The provider is never allowed to move the target: a
 * `to` taken from a provider response is exactly the redirection vector rule 90
 * forbids.
 *
 * FOUR OUTCOMES, because collapsing them would make an outage look like fraud
 * and a decline look like agreement:
 *
 *   `agrees`   the provider returned the same target, the same calldata and no
 *              value. The strongest state, and the ordinary one.
 *   `disagrees` the provider returned something else. The operation is refused
 *              and every differing field is named.
 *   `declined` the provider had no calldata to give and said why - measured:
 *              HTTP 400 `Nothing to claim` for a wallet owed nothing. It is NOT
 *              a disagreement about bytes and never refuses on its own; the
 *              on-chain simulation is what decides whether there is anything to
 *              claim.
 *   `unavailable` the endpoint did not answer. Nothing was learned either way,
 *              and the cross-check is reported as missing rather than passed.
 *
 * ONLY `disagrees` STOPS THE OPERATION. Making an unreachable third-party
 * endpoint able to block a self-custodial claim would hand the launchpad a veto
 * over the user's own funds; the chain is the authority, and this is corroboration.
 */

import type { Address, Hex } from "viem";

import { ErrorCodes, VexError } from "../../../errors.js";
import { describeFailureForLog } from "../../../utils/error-summary.js";
import { getPoolsFunClient } from "../client.js";

export type PoolsPrepareCrossCheck =
  | {
      readonly status: "agrees";
      readonly providerTo: string;
      readonly providerData: string;
    }
  | {
      readonly status: "disagrees";
      /** Every field that differs, each in its own sentence. */
      readonly differences: readonly string[];
      readonly providerTo: string;
      readonly providerData: string;
    }
  | { readonly status: "declined"; readonly detail: string }
  | { readonly status: "unavailable"; readonly detail: string };

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether a provider `value` field means zero.
 *
 * `"0x0"` is what the endpoint actually answered; `"0"`, `""` and an absent
 * field are accepted as the same statement. ANYTHING ELSE IS A DISAGREEMENT:
 * these two calls are non-payable, so a provider proposing to attach native
 * value to one is describing a transaction that would revert at best and move
 * the user's ETH at worst.
 */
function meansZeroValue(value: string | null): boolean {
  if (value === null || value.trim() === "") return true;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "0") return true;
  if (!trimmed.startsWith("0x")) return false;
  return /^0x0*$/.test(trimmed);
}

/**
 * Ask the launchpad to prepare the SAME action and compare its answer with ours.
 *
 * `ours.to` is the distributor from the deployer's event and `ours.data` is the
 * calldata built from the verified ABI. Neither is derived from anything this
 * function receives back.
 */
export async function crossCheckPoolsHolderRewardsPrepare(input: {
  readonly tokenAddress: string;
  readonly walletAddress: string;
  readonly action: "claim" | "distribute";
  readonly ours: { readonly to: Address; readonly data: Hex };
  readonly signal?: AbortSignal | undefined;
}): Promise<PoolsPrepareCrossCheck> {
  let provider;
  try {
    provider = await getPoolsFunClient().holderRewardsPrepare(
      {
        tokenAddress: input.tokenAddress,
        walletAddress: input.walletAddress,
        action: input.action,
      },
      input.signal === undefined ? {} : { signal: input.signal },
    );
  } catch (err) {
    // WHICH OUTCOME IS DECIDED BY THE ERROR CODE, NOT BY THE PROVIDER'S PROSE.
    // `POOLS_INVALID_REQUEST` (HTTP 400) and `POOLS_NOT_FOUND` (a JSON 404, or
    // the named 502 for an unknown pool) are the provider ANSWERING: it had no
    // calldata for this request and said so. Everything else - a timeout, a 5xx,
    // a body that did not parse - established nothing at all. Matching on the
    // wording instead would make the difference between "you are owed nothing"
    // and "we learned nothing" depend on a sentence the provider can reword.
    const detail = describeFailureForLog(err);
    const declined = err instanceof VexError
      && (err.code === ErrorCodes.POOLS_INVALID_REQUEST || err.code === ErrorCodes.POOLS_NOT_FOUND);
    return declined ? { status: "declined", detail } : { status: "unavailable", detail };
  }

  const differences: string[] = [];
  if (!sameHex(provider.to, input.ours.to)) {
    differences.push(
      `the launchpad would send this ${input.action} to ${provider.to}, while the suite's HolderRewardsDeployer `
        + `named ${input.ours.to} as this token's distributor`,
    );
  }
  if (!sameHex(provider.data, input.ours.data)) {
    differences.push(
      `the launchpad's calldata is ${provider.data}, while ${input.ours.data} is what the distributor's verified `
        + `ABI encodes for ${input.action === "claim" ? "claim()" : "distribute()"}`,
    );
  }
  if (!meansZeroValue(provider.value)) {
    differences.push(
      `the launchpad proposes attaching ${provider.value} of native value to a call that takes none`,
    );
  }
  if (provider.action !== null && provider.action.toLowerCase() !== input.action) {
    differences.push(
      `the launchpad says it prepared "${provider.action}" while the request asked for "${input.action}"`,
    );
  }

  return differences.length === 0
    ? { status: "agrees", providerTo: provider.to, providerData: provider.data }
    : { status: "disagrees", differences, providerTo: provider.to, providerData: provider.data };
}
