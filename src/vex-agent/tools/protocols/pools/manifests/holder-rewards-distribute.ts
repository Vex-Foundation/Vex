/**
 * `pools.holder_rewards_distribute` - the permissionless push.
 *
 * The description leads with WHOSE MONEY MOVES, because that is the one fact an
 * agent can get wrong here in a way that costs the user: this transaction pays
 * the token's HOLDERS, and the wallet that signs it pays gas. The caller bounty
 * exists on one of the two live distributor runtimes and is stated as a rule
 * with its condition, never as an amount anybody is owed.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { POOLS_HOLDER_REWARDS_DISCOVERY } from "../../embeddings/pools/holder-rewards.js";
import { POOLS_HOLDER_REWARDS_MUTATION_REJECTED_PARAMS } from "./holder-rewards-claim.js";

export const POOLS_HOLDER_REWARDS_DISTRIBUTE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pools.holder_rewards_distribute",
    publicName: "pools__holder_rewards_distribute",
    namespace: "pools",
    lifecycle: "active",
    description:
      "Push a pools.fun token's accrued fees into its holder-reward stream, on Robinhood Chain (4663). THIS IS NOT A CLAIM AND IT DOES NOT PAY YOU: distribute() is permissionless, it pulls the fees the locker has collected for a fees-to-holders token, converts them where that distributor is configured to, and starts them streaming to everyone who HOLDS the token. The wallet that signs it spends gas so that holders can earn. Use it when a token's rewards have stalled and its distributor has work waiting, or when a holder wants their earned figure to start moving before they claim. "
      + "THE CALLER BOUNTY IS A RULE WITH A CONDITION, not an amount you are owed. Newer distributors carry a CALLER_BOUNTY_BPS constant, 50 basis points (0.5 percent) on every one measured, taken out of the BUYBACK and paid to whoever calls distribute; older distributors have no such constant at all and pay the caller nothing. Even where the constant exists, a distribute whose buyback bought nothing pays nothing, and only the transaction receipt's own CallerBounty event proves what was actually paid. The reply states which of these applies before you sign, and the gas can exceed the bounty. The launchpad's paysCallerBounty field is an echo and has been measured reading false on a distributor whose on-chain constant is 50, so the contract is the authority. "
      + "VEX CHARGES NOTHING here. There is no Vex fee and no fee, recipient, distributor or target parameter; a caller-supplied one is refused by name. The distributor is the one the suite's own HolderRewardsDeployer emitted for this token, bound to that suite by its token(), factory() and locker() before it is addressed, and the launchpad's own prepared calldata is compared byte for byte against the calldata Vex builds from the distributor's verified ABI, with a disagreement refusing by name. "
      + "Use dryRun: true first: it SIMULATES distribute() from your wallet and reports whether it would succeed, what the distributor would move, the launchpad's pendingFees and hasWorkToDistribute for context, the bounty rule, and a gas ceiling - signing nothing. simulateOnly: true runs the whole path including the real gas estimate over the exact bytes and then stops with executed: false, opening no key and recording nothing. "
      + "RETURNS the bound distributor group (its address, the reward mode and where it was read from, the suite and its HolderRewardsDeployer, the paired asset and the caller-bounty basis points), the block everything was read at, what the simulated distribute would move, the bountyRule in words, the launchpad's hasWorkToDistribute and pendingFees for context, gasLimitBound, vexFee (always null) and the crossCheck group. A real distribute also returns txHash, status and the bounty the receipt's own CallerBounty event proved, or null when it declared none. "
      + "OUTCOMES. nothing_to_distribute means the distributor itself says it has nothing to push right now, which changes on its own as the pool trades and as the buyback interval elapses; nothing is signed. no_holder_rewards means the token never opted in and never can. unsupported_on_this_suite means the token is on the first contract suite, which has no holder rewards. After a real distribute: confirmed with whatever bounty the receipt proved, reverted when it landed and failed - most often because another caller distributed first, which is the ordinary outcome of a permissionless race - or pending when the outcome is UNKNOWN, already recorded, and must NOT be retried. "
      + "It is recorded as a reward_distribution rather than a claim, and the row carries no payout leg, because the money went to the holders. Claiming YOUR share as a holder is pools__holder_rewards_claim; reading the state is pools__holder_rewards_get.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    rejectedParams: POOLS_HOLDER_REWARDS_MUTATION_REJECTED_PARAMS,
    params: [
      {
        key: "tokenAddress",
        type: "string",
        required: true,
        description:
          "The pools.fun token's contract ADDRESS whose distributor to push. Find fees-to-holders tokens with "
          + "pools__tokens_discover using holderRewards: true, and check whether one has work waiting with "
          + "pools__holder_rewards_get.",
      },
      {
        key: "dryRun",
        type: "boolean",
        description:
          "true simulates the distribute and reports whether it would succeed, what the distributor would move, "
          + "the bounty rule and a gas ceiling, without signing anything. Omit it to actually distribute.",
      },
      {
        key: "simulateOnly",
        type: "boolean",
        description:
          "true runs every check a real distribute runs, including the gas estimate over the exact bytes, and "
          + "then stops without opening a key or recording anything. Returns the would-be transaction with "
          + "executed: false.",
      },
    ],
    exampleParams: { tokenAddress: "0x3d7341a260a2ee460c9d68e302c2e0c883487039", dryRun: true },
    discovery: POOLS_HOLDER_REWARDS_DISCOVERY["pools.holder_rewards_distribute"],
  },
];
