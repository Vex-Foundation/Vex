/**
 * pools.fun settlement decoding - the DUAL-EVENT launch, and the fee claim.
 *
 * THE RULE IS DECLINE, NEVER GUESS. A confirmed transaction whose events cannot
 * be proven to describe OUR launch leaves the row pending for the repair sweep
 * rather than confirming with an invented token address. A wrong address is
 * worse than a missing one, because the user acts on it.
 *
 * WHY A LAUNCH NEEDS TWO EVENTS. On the gateway path the factory's
 * `TokenLaunched` names the GATEWAY as creator and deployer - it has to, the
 * gateway is what called it - so that event alone can never attribute a launch
 * to a user. The gateway's own `GatewayLaunch` carries `launcher` (indexed),
 * which is the session wallet. Neither event is sufficient:
 *
 *   - `TokenLaunched` alone: proves a token was launched, not that it was OURS.
 *   - `GatewayLaunch` alone: proves our wallet launched something through the
 *     gateway, but its fields are the gateway's account of the launch rather
 *     than the factory's.
 *
 * So settlement requires EXACTLY ONE of each, from their PINNED emitters, and
 * cross-checks them field by field against each other and against the authorized
 * plan. Anything else declines with a named reason.
 *
 * EXACTLY ONE, not "the first one". A transaction containing two launches is not
 * a transaction we can attribute one of them from, and picking the first would
 * be a guess wearing a decoder's clothes.
 *
 * EMITTER PINNING, ACROSS THREE SUITES. Logs are filtered to a KNOWN gateway and
 * factory before anything is decoded: any contract can emit a same-signature
 * event, and trusting an unpinned emitter would let an unrelated address be
 * recorded as the user's token.
 *
 * The event topics are byte-identical on V1, V2 and V3 (verified: the three
 * Sourcify ABIs declare the same `TokenLaunched`, `GatewayLaunch` and `Claimed`
 * signatures), so the only thing that changes across suites is WHICH ADDRESS
 * emitted them. A decoder pinned to one suite's addresses therefore declines
 * every launch made by another - silently, and after the money has already
 * moved. So the emitters are the suite TABLE.
 *
 * AND THE TWO EVENTS MUST COME FROM THE SAME SUITE. Accepting a `GatewayLaunch`
 * from V3 beside a `TokenLaunched` from V1 would prove nothing about either:
 * the whole point of the dual-event rule is that ONE launch produced both, and a
 * launch is produced by one gateway calling its own factory. So a suite is
 * selected first - by the caller's authorized plan when it names a gateway, or
 * by finding the one suite that emitted both - and every later check is made
 * within it.
 */

import { decodeEventLog, getAddress, toEventSelector, type Address, type Hex } from "viem";

import {
  PARTY_FACTORY_TOKEN_LAUNCHED_ABI,
  PARTY_LOCKER_CLAIMED_EVENT_ABI,
  POOLS_GATEWAY_LAUNCH_EVENT_ABI,
} from "@tools/pools-fun/abi.js";
import {
  POOLS_SUITES,
  type PoolsContractSuite,
} from "@tools/pools-fun/constants.js";
import {
  POOLS_DISTRIBUTOR_DEPLOYED_EVENT_ABI,
  poolsHolderRewardModeFromWire,
  type PoolsHolderRewardMode,
} from "@tools/pools-fun/holder-rewards/read.js";

/** One receipt log, as the decoders read it. */
export interface PoolsSettlementLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

const GATEWAY_LAUNCH_TOPIC = toEventSelector(
  "GatewayLaunch(address,address,address,address,address,bytes32,uint256,uint256)",
);
const TOKEN_LAUNCHED_TOPIC = toEventSelector(
  "TokenLaunched(address,address,address,address,address,address,int24,string,uint256)",
);
const CLAIMED_TOPIC = toEventSelector("Claimed(address,address,uint256,uint256)");
/**
 * `DistributorDeployed(address,address,uint8)` - the ONLY authority on which
 * distributor a fees-to-holders launch actually created.
 *
 * Read from the Sourcify-verified HolderRewardsDeployer ABI, not spelled here
 * from convention; the ABI object it is derived from lives beside the holder-
 * rewards reader that owns this vocabulary.
 */
const DISTRIBUTOR_DEPLOYED_TOPIC = toEventSelector("DistributorDeployed(address,address,uint8)");

/** What the authorized plan said this launch would be. The decoder proves the receipt matches. */
export interface PoolsLaunchExpectation {
  readonly launcher: Address;
  readonly feeRecipient: Address;
  readonly pairedAsset: Address;
  readonly userSalt: Hex;
  /** The token address the user approved, from the verifier. */
  readonly predictedTokenAddress: Address;
  /**
   * THE HOLDER-REWARDS INTENT, when the launch had one - and the reason this
   * decoder cannot simply compare `feeRecipient` on such a launch.
   *
   * The verified V3 gateway RESOLVES the `FEES_TO_HOLDERS*` sentinel to the
   * distributor it has just deployed BEFORE it emits `GatewayLaunch`, so a
   * holders launch's receipt names the distributor and the signed tuple names
   * the sentinel. They are different addresses by construction, and neither is
   * wrong.
   *
   * So the proof changes shape rather than relaxing: the receipt's recipient
   * must be the distributor that THIS transaction's own
   * `DistributorDeployed(token, distributor, mode)` named, emitted by the suite's
   * pinned HolderRewardsDeployer, for THIS token, in the mode that was
   * authorized. Comparing against the sentinel would refuse every correct
   * holders launch; accepting any address would prove nothing at all.
   *
   * `null` for an ordinary launch, where the tuple's recipient is an address and
   * the receipt must carry exactly it.
   */
  readonly holderRewards?:
    | { readonly mode: PoolsHolderRewardMode; readonly sentinel: Address }
    | null
    | undefined;
}

/** A launch proven to be ours. */
export interface DecodedPoolsLaunch {
  readonly tokenAddress: Address;
  readonly poolAddress: Address;
  readonly pairedAsset: Address;
  /** Whatever the gateway emitted: an address on an ordinary launch, the DISTRIBUTOR on a holders launch. */
  readonly feeRecipient: Address;
  /**
   * The distributor this launch deployed, PROVEN from its own
   * `DistributorDeployed` event, and the mode that event declared.
   *
   * `null` on an ordinary launch. It is not merely a copy of `feeRecipient`: the
   * two are the same address only because the proof below established that they
   * must be, and recording where the value came from is what lets a later reader
   * tell a proven distributor from an unexamined recipient.
   */
  readonly holderRewards:
    | { readonly distributor: Address; readonly mode: PoolsHolderRewardMode }
    | null;
  readonly launcher: Address;
  readonly feePaidWei: bigint;
  readonly devBuyOut: bigint;
  readonly startTick: number;
  readonly metadataUri: string;
}

/** A claim proven to be ours. */
export interface DecodedPoolsClaim {
  readonly tokenAddress: Address;
  readonly account: Address;
  readonly tokenAmountRaw: bigint;
  readonly pairedAmountRaw: bigint;
}

/**
 * Either a proven decode, or a REFUSAL that says what could not be proven.
 *
 * The reason is not decoration: the repair sweep and the agent both read it, and
 * "could not decode" without a cause is indistinguishable from a bug.
 */
export type PoolsSettlementOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/** Logs from ONE pinned emitter carrying ONE topic. */
function logsFrom(
  logs: readonly PoolsSettlementLog[],
  emitter: string,
  topic: string,
): readonly PoolsSettlementLog[] {
  return logs.filter((log) => sameAddress(log.address, emitter) && log.topics[0] === topic);
}

/**
 * Decode a launch receipt, proving it is OURS.
 *
 * Every refusal names the specific fact that could not be established, because
 * "settlement failed" tells a later reader nothing about whether funds moved.
 */
export function decodePoolsLaunchSettlement(
  logs: readonly PoolsSettlementLog[],
  expected: PoolsLaunchExpectation,
  emitters: { readonly gateway?: string; readonly factory?: string } = {},
): PoolsSettlementOutcome<DecodedPoolsLaunch> {
  // ── WHICH SUITE EMITTED THIS LAUNCH ───────────────────────────────
  //
  // When the authorized plan names a gateway, that gateway selects the suite and
  // its factory comes with it: the plan is what the user authorized, so the
  // receipt is proven against the suite the launch was signed for rather than
  // against whichever suite happens to fit. An unknown gateway is refused by
  // name - not silently widened to "any suite".
  //
  // Only a sweep over an older row may arrive without a gateway (migration 082
  // added the column later). Then the suite is DISCOVERED, and discovery is the
  // strict version: exactly one suite must have emitted BOTH events.
  const selected = selectSuite(logs, emitters);
  if (!selected.ok) return selected;
  const { gateway, factory } = selected;

  const gatewayLogs = logsFrom(logs, gateway, GATEWAY_LAUNCH_TOPIC);
  const factoryLogs = logsFrom(logs, factory, TOKEN_LAUNCHED_TOPIC);

  if (gatewayLogs.length === 0) {
    return { ok: false, reason: `no GatewayLaunch event from the pinned gateway ${gateway} in this receipt` };
  }
  if (gatewayLogs.length > 1) {
    return {
      ok: false,
      reason:
        `${gatewayLogs.length} GatewayLaunch events from the pinned gateway in one receipt; a single launch `
        + "cannot be attributed from a transaction carrying several",
    };
  }
  if (factoryLogs.length === 0) {
    return { ok: false, reason: `no TokenLaunched event from the pinned factory ${factory} in this receipt` };
  }
  if (factoryLogs.length > 1) {
    return {
      ok: false,
      reason:
        `${factoryLogs.length} TokenLaunched events from the pinned factory in one receipt; a single launch `
        + "cannot be attributed from a transaction carrying several",
    };
  }

  let gatewayEvent;
  let factoryEvent;
  try {
    gatewayEvent = decodeEventLog({
      abi: POOLS_GATEWAY_LAUNCH_EVENT_ABI,
      data: gatewayLogs[0]!.data as Hex,
      topics: gatewayLogs[0]!.topics as [Hex, ...Hex[]],
    }).args;
    factoryEvent = decodeEventLog({
      abi: PARTY_FACTORY_TOKEN_LAUNCHED_ABI,
      data: factoryLogs[0]!.data as Hex,
      topics: factoryLogs[0]!.topics as [Hex, ...Hex[]],
    }).args;
  } catch (err) {
    return {
      ok: false,
      reason: `a pinned launch event did not decode against its verified ABI: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  // ── Identity: this launch is OURS ─────────────────────────────────
  //
  // `launcher` is the only field in either event that names the human. It is
  // indexed on GatewayLaunch, and it is the whole reason the gateway path is
  // attributable at all.
  if (!sameAddress(gatewayEvent.launcher, expected.launcher)) {
    return {
      ok: false,
      reason:
        `GatewayLaunch.launcher is ${gatewayEvent.launcher}, not this session's wallet `
        + `${expected.launcher}; this receipt describes somebody else's launch`,
    };
  }

  // On the GATEWAY path the factory necessarily credits the gateway. If it
  // credits anything else, this was not the gateway path and the plan that was
  // authorized does not describe what happened.
  if (!sameAddress(factoryEvent.creator, gateway) || !sameAddress(factoryEvent.deployer, gateway)) {
    return {
      ok: false,
      reason:
        `TokenLaunched credits creator=${factoryEvent.creator} deployer=${factoryEvent.deployer}, but a gateway `
        + `launch must credit the gateway ${gateway} for both`,
    };
  }

  // ── The two events must describe the SAME launch ──────────────────
  if (!sameAddress(gatewayEvent.token, factoryEvent.token)) {
    return {
      ok: false,
      reason:
        `the gateway reports token ${gatewayEvent.token} while the factory reports ${factoryEvent.token}; `
        + "the two events do not describe the same launch",
    };
  }
  if (!sameAddress(gatewayEvent.pool, factoryEvent.pool)) {
    return {
      ok: false,
      reason:
        `the gateway reports pool ${gatewayEvent.pool} while the factory reports ${factoryEvent.pool}; `
        + "the two events do not describe the same launch",
    };
  }
  if (!sameAddress(gatewayEvent.pairedAsset, factoryEvent.pairedAsset)) {
    return {
      ok: false,
      reason:
        `the gateway reports pairedAsset ${gatewayEvent.pairedAsset} while the factory reports `
        + `${factoryEvent.pairedAsset}`,
    };
  }
  if (!sameAddress(gatewayEvent.feeRecipient, factoryEvent.feeRecipient)) {
    return {
      ok: false,
      reason:
        `the gateway reports feeRecipient ${gatewayEvent.feeRecipient} while the factory reports `
        + `${factoryEvent.feeRecipient}`,
    };
  }

  // ── And the SAME launch the plan authorized ───────────────────────
  if (!sameAddress(gatewayEvent.token, expected.predictedTokenAddress)) {
    return {
      ok: false,
      reason:
        `the launched token is ${gatewayEvent.token} but the authorized plan approved `
        + `${expected.predictedTokenAddress}`,
    };
  }
  // ── WHERE THE FEE STREAM ACTUALLY WENT ────────────────────────────
  //
  // Two proofs, because the chain has two shapes. An ordinary launch must name
  // the exact address that was signed. A HOLDERS launch cannot: the gateway
  // resolved the sentinel before emitting, so the receipt names a distributor
  // that did not exist when the tuple was signed - and the only thing that can
  // prove it is the right one is this transaction's own DistributorDeployed.
  const holderRewards = expected.holderRewards ?? null;
  let provenHolderRewards: { readonly distributor: Address; readonly mode: PoolsHolderRewardMode } | null = null;
  if (holderRewards === null) {
    if (!sameAddress(gatewayEvent.feeRecipient, expected.feeRecipient)) {
      return {
        ok: false,
        reason:
          `the fee stream was set to ${gatewayEvent.feeRecipient} but the authorized plan set `
          + `${expected.feeRecipient}`,
      };
    }
  } else {
    const proven = proveHolderRewardsDistributor(logs, {
      suiteGateway: gateway,
      token: getAddress(gatewayEvent.token),
      emittedRecipient: getAddress(gatewayEvent.feeRecipient),
      intent: holderRewards,
    });
    if (!proven.ok) return proven;
    provenHolderRewards = proven.value;
  }
  if (!sameAddress(gatewayEvent.pairedAsset, expected.pairedAsset)) {
    return {
      ok: false,
      reason: `the pool pairs against ${gatewayEvent.pairedAsset}, not the authorized ${expected.pairedAsset}`,
    };
  }
  if (gatewayEvent.userSalt.toLowerCase() !== expected.userSalt.toLowerCase()) {
    return {
      ok: false,
      reason:
        `the launch used salt ${gatewayEvent.userSalt} but the authorized plan pinned ${expected.userSalt}; `
        + "a different salt is a different token address",
    };
  }

  return {
    ok: true,
    value: {
      tokenAddress: getAddress(gatewayEvent.token),
      poolAddress: getAddress(gatewayEvent.pool),
      pairedAsset: getAddress(gatewayEvent.pairedAsset),
      feeRecipient: getAddress(gatewayEvent.feeRecipient),
      holderRewards: provenHolderRewards,
      launcher: getAddress(gatewayEvent.launcher),
      feePaidWei: gatewayEvent.feePaidWei,
      devBuyOut: gatewayEvent.devBuyOut,
      startTick: factoryEvent.startTick,
      metadataUri: factoryEvent.metadataUri,
    },
  };
}

/**
 * PROVE which distributor a fees-to-holders launch created, from the launch's
 * own receipt.
 *
 * THE PROBLEM. On a holders launch the signed tuple carries a SENTINEL
 * (`FEES_TO_HOLDERS`, `_PAIRED` or `_BOTH`), and the gateway resolves it to the
 * distributor it deploys in the same transaction before emitting
 * `GatewayLaunch`. So the address in the receipt is one that did not exist when
 * the user approved the launch, and comparing it to anything the plan holds
 * would either refuse every correct launch (compare to the sentinel) or prove
 * nothing (accept whatever arrived).
 *
 * THE PROOF. The suite's own HolderRewardsDeployer emits
 * `DistributorDeployed(token, distributor, rewardMode)` in this same receipt.
 * Four facts must line up, and every one of them is a refusal:
 *
 *   1. EXACTLY ONE such event, from the PINNED deployer of the SAME suite the
 *      launch was signed against. Any contract can emit a same-signature event,
 *      and a deployer from another suite would prove a different launchpad's
 *      launch.
 *   2. Its `token` is the token this launch created. A distributor deployed for
 *      some other token in the same transaction is not this token's.
 *   3. Its `distributor` is EXACTLY the address the gateway emitted as the fee
 *      recipient. This is the join that makes the whole proof: it is what turns
 *      "a distributor was deployed" into "the fee stream goes to it".
 *   4. Its `rewardMode` is the mode that was AUTHORIZED. The user agreed to be
 *      paid in one asset, and a distributor in another mode pays a different
 *      stream for the life of the token.
 *
 * A suite with no known deployer refuses rather than skipping the proof: V1 and
 * V2 cannot deploy the paired or both modes at all, and a launch that claims to
 * have done so is a launch this build cannot account for.
 */
function proveHolderRewardsDistributor(
  logs: readonly PoolsSettlementLog[],
  input: {
    readonly suiteGateway: string;
    readonly token: Address;
    readonly emittedRecipient: Address;
    readonly intent: { readonly mode: PoolsHolderRewardMode; readonly sentinel: Address };
  },
): PoolsSettlementOutcome<{ readonly distributor: Address; readonly mode: PoolsHolderRewardMode }> {
  const suite = POOLS_SUITES.find((candidate) => sameAddress(candidate.gateway, input.suiteGateway));
  const deployer = suite?.holderRewardsDeployer;
  if (deployer === undefined) {
    return {
      ok: false,
      reason:
        `this launch set the fee stream to the holders sentinel ${input.intent.sentinel}, but the suite it was `
        + `signed against (gateway ${input.suiteGateway}) has no HolderRewardsDeployer Vex knows, so which `
        + "distributor now receives the fees cannot be proven from this receipt",
    };
  }

  const deployedLogs = logsFrom(logs, deployer, DISTRIBUTOR_DEPLOYED_TOPIC);
  if (deployedLogs.length === 0) {
    return {
      ok: false,
      reason:
        `this launch asked for fees to holders, but its receipt carries no DistributorDeployed event from the `
        + `pinned HolderRewardsDeployer ${deployer}; the address now receiving the fee stream `
        + `(${input.emittedRecipient}) is unproven`,
    };
  }
  if (deployedLogs.length > 1) {
    return {
      ok: false,
      reason:
        `${deployedLogs.length} DistributorDeployed events from the pinned deployer in one receipt; which of `
        + "them belongs to this launch cannot be established, and picking one would be a guess",
    };
  }

  let args;
  try {
    args = decodeEventLog({
      abi: [POOLS_DISTRIBUTOR_DEPLOYED_EVENT_ABI] as const,
      data: deployedLogs[0]!.data as Hex,
      topics: deployedLogs[0]!.topics as [Hex, ...Hex[]],
    }).args;
  } catch (err) {
    return {
      ok: false,
      reason:
        "the DistributorDeployed event did not decode against its verified ABI: "
        + `${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  if (!sameAddress(args.token, input.token)) {
    return {
      ok: false,
      reason:
        `the receipt's DistributorDeployed names token ${args.token}, but this launch created `
        + `${input.token}; that distributor belongs to a different token`,
    };
  }
  if (!sameAddress(args.distributor, input.emittedRecipient)) {
    return {
      ok: false,
      reason:
        `the gateway set the fee stream to ${input.emittedRecipient}, but the distributor this launch deployed `
        + `is ${args.distributor}; the fee stream does not go to the distributor this token created`,
    };
  }
  const mode = poolsHolderRewardModeFromWire(Number(args.rewardMode));
  if (mode === null) {
    return {
      ok: false,
      reason:
        `the distributor was deployed in reward mode ${args.rewardMode}, which this build has no name for, so `
        + "what the holders will be paid in cannot be stated",
    };
  }
  if (mode !== input.intent.mode) {
    return {
      ok: false,
      reason:
        `this launch was authorized to pay holders in "${input.intent.mode}" mode (sentinel `
        + `${input.intent.sentinel}), but the distributor it deployed runs in "${mode}" mode`,
    };
  }

  return { ok: true, value: { distributor: getAddress(args.distributor), mode } };
}

/**
 * Decode a claim receipt.
 *
 * Simpler than a launch because `Claimed` carries both the token and the paid
 * account as INDEXED fields, so one event from the pinned locker is sufficient
 * identity. The same "exactly one" rule applies: a receipt with two claims for
 * the same token cannot be attributed to one row.
 *
 * A claim of 0/0 is a legitimate outcome, not a decode failure - the pool had
 * nothing to pay. It decodes successfully and the caller reports the zeroes.
 */
export function decodePoolsClaimSettlement(
  logs: readonly PoolsSettlementLog[],
  expected: { readonly account: Address; readonly tokenAddress: Address },
  emitters: { readonly locker?: string } = {},
): PoolsSettlementOutcome<DecodedPoolsClaim> {
  // A claim names its locker, because the CALLER knows which suite it claimed
  // from - it simulated and broadcast against that exact address. Without one,
  // every known suite's locker is accepted, which is what an older row (or a
  // repair sweep) needs; the `account` and `token` filters below still make the
  // attribution exact.
  //
  // A NAMED LOCKER MUST BE ONE OF THE TABLE'S. The caller's hint selects among
  // the suites; it never adds an emitter, because a locker outside the table
  // would let a forged `Claimed` from an arbitrary contract decode as a payout.
  if (emitters.locker !== undefined) {
    const named = emitters.locker;
    const suite = POOLS_SUITES.find((candidate) => sameAddress(candidate.locker, named));
    if (suite === undefined) {
      return {
        ok: false,
        reason:
          `the claim names locker ${named}, which is not one of the pools.fun suites Vex knows `
          + `(${POOLS_SUITES.map((s) => `V${s.version} ${s.locker}`).join(", ")}); this receipt cannot be `
          + "proven to describe a pools.fun claim",
      };
    }
  }
  const lockers = emitters.locker === undefined
    ? POOLS_SUITES.map((suite) => suite.locker)
    : [emitters.locker];
  const claimedLogs = lockers.flatMap((locker) => logsFrom(logs, locker, CLAIMED_TOPIC));

  if (claimedLogs.length === 0) {
    return {
      ok: false,
      reason:
        `no Claimed event from ${lockers.length === 1 ? `the pinned locker ${lockers[0]}` : "any known pools.fun locker"}`
        + " in this receipt",
    };
  }

  const decoded: DecodedPoolsClaim[] = [];
  for (const log of claimedLogs) {
    try {
      const args = decodeEventLog({
        abi: PARTY_LOCKER_CLAIMED_EVENT_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      }).args;
      if (!sameAddress(args.account, expected.account)) continue;
      if (!sameAddress(args.token, expected.tokenAddress)) continue;
      decoded.push({
        tokenAddress: getAddress(args.token),
        account: getAddress(args.account),
        tokenAmountRaw: args.tokenAmount,
        pairedAmountRaw: args.pairedAmount,
      });
    } catch {
      // A log that does not decode against the verified ABI is not evidence of
      // anything; it is skipped rather than allowed to fail a receipt that may
      // still contain our real claim.
      continue;
    }
  }

  if (decoded.length === 0) {
    return {
      ok: false,
      reason:
        `the receipt has Claimed events from the locker, but none for token ${expected.tokenAddress} paid to `
        + `${expected.account}`,
    };
  }
  if (decoded.length > 1) {
    return {
      ok: false,
      reason:
        `${decoded.length} Claimed events for this token and account in one receipt; the payout cannot be `
        + "attributed to a single claim row",
    };
  }

  return { ok: true, value: decoded[0]! };
}

/**
 * The suite whose gateway and factory a launch receipt is judged against.
 *
 * THREE CASES, and the middle one is the reason this exists:
 *
 *   the caller named a gateway  -> that suite, factory included. A gateway
 *       address the table does not carry is REFUSED BY NAME rather than treated
 *       as "some gateway": a receipt from an unknown contract cannot be proven
 *       to be a pools.fun launch at all, and the sweep must leave such a row
 *       pending rather than confirm it.
 *   the caller named a factory too -> it must be THAT suite's factory. A hint is
 *       never used verbatim: an emitter pair that is not in the table would let
 *       a forged event pair from arbitrary contracts decode as a launch, and a
 *       mismatched known pair is two suites disagreeing about one row. A
 *       factory-only hint is refused for the same reason.
 *   the caller named neither    -> DISCOVERY: exactly one suite must have
 *       emitted BOTH a GatewayLaunch and a TokenLaunched in this receipt. Zero
 *       is "not a gateway launch"; more than one is a receipt no single suite
 *       describes, and picking one would be the first-match guess the whole
 *       suite model exists to refuse.
 */
function selectSuite(
  logs: readonly PoolsSettlementLog[],
  emitters: { readonly gateway?: string; readonly factory?: string },
):
  | { readonly ok: true; readonly gateway: string; readonly factory: string }
  | { readonly ok: false; readonly reason: string } {
  if (emitters.gateway === undefined && emitters.factory !== undefined) {
    return {
      ok: false,
      reason:
        `a factory (${emitters.factory}) was named without its gateway; a pools.fun suite is selected by its `
        + "gateway, and a factory alone does not identify one",
    };
  }

  if (emitters.gateway !== undefined) {
    const named = emitters.gateway;
    const suite = POOLS_SUITES.find((candidate) => sameAddress(candidate.gateway, named));
    if (suite === undefined) {
      return {
        ok: false,
        reason:
          `the authorized plan names gateway ${named}, which is not one of the pools.fun suites Vex knows `
          + `(${POOLS_SUITES.map((s) => `V${s.version} ${s.gateway}`).join(", ")}); this receipt cannot be `
          + "proven to describe a pools.fun launch",
      };
    }
    // A factory hint is CHECKED against the suite the gateway selects, never
    // substituted for it: the table is the authority on which factory a gateway
    // launches through, and a hint that disagrees is a row two suites describe.
    if (emitters.factory !== undefined && !sameAddress(emitters.factory, suite.factory)) {
      return {
        ok: false,
        reason:
          `the authorized plan names gateway ${named} (suite V${suite.version}) with factory ${emitters.factory}, `
          + `but that suite launches through ${suite.factory}; the emitter pair does not describe one suite`,
      };
    }
    return { ok: true, gateway: suite.gateway, factory: suite.factory };
  }

  const emitting: PoolsContractSuite[] = POOLS_SUITES.filter(
    (suite) =>
      logsFrom(logs, suite.gateway, GATEWAY_LAUNCH_TOPIC).length > 0
      && logsFrom(logs, suite.factory, TOKEN_LAUNCHED_TOPIC).length > 0,
  );

  if (emitting.length === 0) {
    return {
      ok: false,
      reason:
        "no pools.fun suite emitted both a GatewayLaunch and a TokenLaunched in this receipt "
        + `(checked ${POOLS_SUITES.map((s) => `V${s.version}`).join(", ")})`,
    };
  }
  if (emitting.length > 1) {
    return {
      ok: false,
      reason:
        `${emitting.length} pools.fun suites (${emitting.map((s) => `V${s.version}`).join(", ")}) each emitted a `
        + "full launch pair in this receipt; a single launch cannot be attributed from it",
    };
  }
  const suite = emitting[0]!;
  return { ok: true, gateway: suite.gateway, factory: suite.factory };
}
