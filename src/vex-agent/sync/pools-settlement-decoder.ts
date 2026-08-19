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
 * EMITTER PINNING. Logs are filtered to the pinned gateway and factory before
 * anything is decoded: any contract can emit a same-signature event, and
 * trusting an unpinned emitter would let an unrelated address be recorded as the
 * user's token.
 */

import { decodeEventLog, getAddress, toEventSelector, type Address, type Hex } from "viem";

import {
  PARTY_FACTORY_TOKEN_LAUNCHED_ABI,
  PARTY_LOCKER_CLAIMED_EVENT_ABI,
  POOLS_GATEWAY_LAUNCH_EVENT_ABI,
} from "@tools/pools-fun/abi.js";
import {
  POOLS_FACTORY_ADDRESS,
  POOLS_GATEWAY_ADDRESS,
  POOLS_LOCKER_ADDRESS,
} from "@tools/pools-fun/constants.js";

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

/** What the authorized plan said this launch would be. The decoder proves the receipt matches. */
export interface PoolsLaunchExpectation {
  readonly launcher: Address;
  readonly feeRecipient: Address;
  readonly pairedAsset: Address;
  readonly userSalt: Hex;
  /** The token address the user approved, from the verifier. */
  readonly predictedTokenAddress: Address;
}

/** A launch proven to be ours. */
export interface DecodedPoolsLaunch {
  readonly tokenAddress: Address;
  readonly poolAddress: Address;
  readonly pairedAsset: Address;
  readonly feeRecipient: Address;
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
  const gateway = emitters.gateway ?? POOLS_GATEWAY_ADDRESS;
  const factory = emitters.factory ?? POOLS_FACTORY_ADDRESS;

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
  if (!sameAddress(gatewayEvent.feeRecipient, expected.feeRecipient)) {
    return {
      ok: false,
      reason:
        `the fee stream was set to ${gatewayEvent.feeRecipient} but the authorized plan set `
        + `${expected.feeRecipient}`,
    };
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
      launcher: getAddress(gatewayEvent.launcher),
      feePaidWei: gatewayEvent.feePaidWei,
      devBuyOut: gatewayEvent.devBuyOut,
      startTick: factoryEvent.startTick,
      metadataUri: factoryEvent.metadataUri,
    },
  };
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
  const locker = emitters.locker ?? POOLS_LOCKER_ADDRESS;
  const claimedLogs = logsFrom(logs, locker, CLAIMED_TOPIC);

  if (claimedLogs.length === 0) {
    return { ok: false, reason: `no Claimed event from the pinned locker ${locker} in this receipt` };
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
