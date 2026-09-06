/**
 * `pools.holder_rewards_claim` - the holder's claim.
 *
 * ONE TOOL, and `dryRun` is the preview: the runtime treats a `dryRun` call as
 * read-only, so the same tool answers "what would I get" without an approval and
 * "claim it" behind the ordinary approval gate. `simulateOnly` is the third
 * stop - the whole money path with no key opened - and is deliberately NOT a
 * `dryRun` synonym: `dryRun` answers a question, `simulateOnly` proves the
 * transaction.
 *
 * The description states the reward modes, the legs, the units, that Vex charges
 * NOTHING, and every refusal, because an agent choosing between this and
 * `pools__fees_claim` is choosing between two different people's money.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { POOLS_HOLDER_REWARDS_DISCOVERY } from "../../embeddings/pools/holder-rewards.js";

/**
 * Parameters that name money and are REFUSED BY NAME rather than ignored.
 *
 * `claim()` pays `msg.sender`; there is no recipient, no fee and no target to
 * choose, so a caller supplying one is either confused or attempting a
 * redirection, and rule 90 requires the field be rejected by name with the
 * address the claim will actually pay. `validateProtocolParams` reads this map
 * before the handler is ever entered, which is what makes the explanation
 * reachable at all.
 */
export const POOLS_HOLDER_REWARDS_MUTATION_REJECTED_PARAMS: Readonly<Record<string, string>> = {
  recipient:
    "There is no recipient to choose. The distributor's claim() pays whoever signs the transaction, which is "
    + "always your own selected wallet, and Vex will not accept a parameter that reads as if funds could be "
    + "sent elsewhere. To move rewards after claiming them, claim first and then send.",
  to:
    "The target is not a parameter. It is the distributor the suite's HolderRewardsDeployer emitted for this "
    + "token, read from that event at execution time; a caller-supplied address would be an unverified contract.",
  distributor:
    "The distributor is not a parameter. It comes from the DistributorDeployed event of the suite that holds "
    + "this token, and is checked against the distributor's own token(), factory() and locker() before anything "
    + "is signed. Read it with pools__holder_rewards_get.",
  feeRecipient:
    "There is no fee on a holder-reward claim, so there is nothing for a fee recipient to receive. Vex charges "
    + "nothing here; the only cost is network gas.",
  fee:
    "There is no fee on a holder-reward claim. Vex charges nothing, and the amount the distributor pays is "
    + "decided by the contract, not by a parameter.",
  vexFee:
    "There is no Vex fee on a holder-reward claim and no parameter can create one.",
  account:
    "Use walletAddress, and only with dryRun: true, to READ what another holder is owed. A real claim always "
    + "pays the signing wallet.",
  claimFor:
    "Vex never calls claimFor on the agent path. A claim here pays the wallet that signs it, and nothing else.",
  chain:
    "pools.fun holder rewards exist on Robinhood Chain (4663) only. The chain is not a parameter.",
  chainId:
    "pools.fun holder rewards exist on Robinhood Chain (4663) only. The chain is not a parameter.",
};

export const POOLS_HOLDER_REWARDS_CLAIM_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pools.holder_rewards_claim",
    publicName: "pools__holder_rewards_claim",
    namespace: "pools",
    lifecycle: "active",
    description:
      "Claim the fees a pools.fun token streams to the wallets that HOLD it, on Robinhood Chain (4663). Nothing is staked: a token launched with fees-to-holders sends its trading fees to a distributor contract, which streams them to holders over 24 hours, and this takes your share. Use dryRun: true first - it SIMULATES the distributor's own claim() from your wallet and reports exactly what it would pay right now. Without dryRun it SIGNS AND SPENDS GAS behind the normal approval gate. "
      + "WHAT IT PAYS depends on the reward mode the token was launched with, which is read from the DistributorDeployed event the suite's own HolderRewardsDeployer emitted for this token, never from the launchpad's row: token mode pays the launched token, paired mode pays the asset the pool is paired against, and both mode pays both. Every leg is reported separately with its RAW base-unit amount, its decimals and its asset address, plus a scaled figure where the asset answered decimals(); never add two legs together and never assume 18 decimals. Some distributors have no paired leg at all, and that is reported as the ABSENCE of a leg rather than a zero. Each leg also carries the distributor's own earned figure at the same block, which differs from the simulated payout by the seconds between the two reads because the reward streams continuously. "
      + "VEX CHARGES NOTHING on this claim. There is no Vex fee, no fee parameter, and no recipient parameter: the distributor's claim() pays whoever signs the transaction, so the rewards always land in your own selected wallet, and a recipient, fee, distributor or target parameter is refused by name. The only cost is network gas, which is reported as a ceiling before anything is signed. "
      + "TWO SAFETY CHECKS run every time and both can refuse. The distributor is bound to the suite by its own token(), factory() and locker() before it is addressed. The launchpad's own prepared calldata (POST /pools-fun/holder-rewards/prepare) is compared byte for byte against the calldata Vex builds from the distributor's verified ABI, and a disagreement refuses the claim by name rather than trusting either. If that endpoint is unreachable or declines, the claim still proceeds on the chain's own evidence, which is stated in the reply. "
      + "RETURNS the bound distributor group (its address, the reward mode and where that mode was read from, the suite and its HolderRewardsDeployer, the paired asset, the caller-bounty basis points and whether this wallet is excluded), the block everything was read at, a wouldPay array with one entry per leg carrying side, assetAddress, assetSymbol, decimals, amountRaw, a scaled amount where decimals() answered, and earnedRaw, plus gasLimitBound, vexFee (always null) and the crossCheck group. A real claim also returns txHash, status, a paid array shaped like wouldPay carrying the amounts the RECEIPT proved, paidNothing, and settlementDiscrepancy when the receipt paid less than the preview promised. "
      + "OUTCOMES, each a different fact. nothing_to_claim means the distributor owes this wallet nothing right now - a fact about the wallet, not a failure, and nothing is signed. wallet_excluded means the distributor has excluded this address from rewards, which is routine for contracts and pools. no_holder_rewards means the token never opted in and never can, because the choice is locked at launch. unsupported_on_this_suite means the token is on the first contract suite, which has no holder rewards at all. After a real claim the status carries the transaction hash: confirmed with the amounts the receipt PROVED, reverted when it landed and failed, confirmed_pending_amounts when it settled but the payout could not be decoded (never guessed), or pending when the outcome is UNKNOWN, already recorded, and must NOT be retried. A claim that pays zero is a real answer rather than a failure, and a confirmed claim that paid less than the preview promised is reported as a settlement discrepancy in words. "
      + "simulateOnly: true runs the entire path - suite detection, the deployer's event, the binding, the simulation, the calldata cross-check and a real gas estimate over the exact bytes - and then STOPS, returning the transaction that would have been signed with executed: false. No key is opened and nothing is recorded. Reading the state without any of this is pools__holder_rewards_get; claiming a token's CREATOR fees, which is a different person's money, is pools__fees_claim.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    rejectedParams: POOLS_HOLDER_REWARDS_MUTATION_REJECTED_PARAMS,
    params: [
      {
        key: "tokenAddress",
        type: "string",
        required: true,
        description:
          "The pools.fun token's contract ADDRESS. Symbols are not unique on this launchpad and copycats are "
          + "routinely live, so the address is the only identity that means one token. Find fees-to-holders "
          + "tokens with pools__tokens_discover using holderRewards: true.",
      },
      {
        key: "dryRun",
        type: "boolean",
        description:
          "true simulates the claim and reports what it would pay without signing anything. Omit it to actually "
          + "claim, which spends gas.",
      },
      {
        key: "simulateOnly",
        type: "boolean",
        description:
          "true runs every check a real claim runs, including the gas estimate over the exact bytes, and then "
          + "stops without opening a key or recording anything. Returns the would-be transaction with "
          + "executed: false. Use it to prove the path; use dryRun to ask what a claim would pay.",
      },
      {
        key: "walletAddress",
        type: "string",
        description:
          "ONLY valid with dryRun: true, where it reads what a DIFFERENT holder is owed - earned(account) and "
          + "claim() simulated from that address are public views over public chain state. On a real claim it is "
          + "refused by name, because the distributor pays whoever signs and there is no way to claim into "
          + "another address.",
      },
    ],
    exampleParams: { tokenAddress: "0x07801a668adf02e806ef8ef5a54804747afdfdf7", dryRun: true },
    discovery: POOLS_HOLDER_REWARDS_DISCOVERY["pools.holder_rewards_claim"],
  },
];
