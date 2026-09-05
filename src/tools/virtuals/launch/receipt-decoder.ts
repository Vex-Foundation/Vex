/**
 * What a launch receipt actually says, decoded from its logs.
 *
 * ## Why the logs and not the return value
 *
 * `preLaunch` RETURNS `(token, pair, virtualId, initialPurchase)`, and a
 * simulation can read that. A broadcast cannot: a transaction's return data is
 * not in its receipt. The `PreLaunched` event carries the same four values
 * (`BondingV5.sol:524-530`), so the event is the settlement authority and the
 * simulated return value is only a prediction to compare against.
 *
 * ## Three events, three different truths
 *
 *   `PreLaunched`     the agent EXISTS and the creator's VIRTUAL is held by
 *                     BondingV5. It is not tradable and it is not indexed.
 *   `Launched`        the KEEPER (or anyone) executed `launch(token)`: the
 *                     initial purchase ran, the curve is live, the anti-sniper
 *                     clock started. Emitted by the keeper's own transaction,
 *                     which is why observing it is a chain read and never a
 *                     claim about our own receipt.
 *   `CancelledLaunch` the creator took the initial purchase back. The protocol
 *                     fee, if any was charged at `preLaunch`, is NOT in it.
 *
 * ## Tolerance
 *
 * A log this lane cannot decode is SKIPPED, never fatal: a receipt carries the
 * logs of every contract the call touched (fifteen on the Robinhood launch on
 * disk), and most of them belong to the agent-token factory, the pair and the
 * tax vault. Only the absence of the event we are looking for is a result, and
 * it is returned as `null` rather than thrown so the caller can distinguish
 * "confirmed but undecodable" from "failed".
 */

import { decodeEventLog, getAddress, type Address, type Hex } from "viem";

import { BONDING_V5_LAUNCH_ABI } from "./abi.js";

/** The subset of a viem log this decoder needs. Keeps receipts substitutable. */
export interface DecodableLaunchLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/** The launch parameters both events echo back, as the contract stored them. */
export interface DecodedLaunchParams {
  readonly launchMode: number;
  readonly airdropBips: number;
  readonly needAcf: boolean;
  readonly antiSniperTaxType: number;
  readonly isProject60days: boolean;
}

export interface DecodedPreLaunched {
  readonly token: Address;
  readonly pair: Address;
  readonly virtualId: bigint;
  /** `purchaseAmount - launchFee`, i.e. what a cancel would refund. */
  readonly initialPurchaseRaw: bigint;
  readonly launchParams: DecodedLaunchParams;
}

export interface DecodedLaunched extends DecodedPreLaunched {
  /** The agent tokens the initial purchase actually bought. */
  readonly initialPurchasedAmountRaw: bigint;
}

export interface DecodedCancelledLaunch {
  readonly token: Address;
  readonly pair: Address;
  readonly virtualId: bigint;
  /** The VIRTUAL returned to the creator. Zero when there was nothing to return. */
  readonly refundedRaw: bigint;
}

function params(raw: {
  launchMode: number;
  airdropBips: number;
  needAcf: boolean;
  antiSniperTaxType: number;
  isProject60days: boolean;
}): DecodedLaunchParams {
  return {
    launchMode: Number(raw.launchMode),
    airdropBips: Number(raw.airdropBips),
    needAcf: raw.needAcf,
    antiSniperTaxType: Number(raw.antiSniperTaxType),
    isProject60days: raw.isProject60days,
  };
}

/**
 * Walk the logs for one BondingV5 event.
 *
 * `emitter` is REQUIRED and compared case-insensitively. Any contract can emit
 * a log whose topic0 matches `PreLaunched`, and a decoder that accepted one
 * would let an unrelated contract in the same transaction name the token a
 * launch is recorded against. The pools lane learned this as a real defect
 * (settlement emitter hints, 2026-09-05); this lane starts with the check.
 */
function findEvent<T>(
  logs: readonly DecodableLaunchLog[],
  emitter: Address,
  eventName: "PreLaunched" | "Launched" | "CancelledLaunch",
  // `project` may answer `null` for a matching event that is not the one the
  // caller wants (a `Launched` for a different token in the same block range),
  // and the scan CONTINUES on that answer rather than stopping - a receipt or a
  // log range can carry several.
  project: (args: Record<string, unknown>) => T | null,
): T | null {
  const target = emitter.toLowerCase();
  for (const log of logs) {
    if (typeof log.address !== "string" || log.address.toLowerCase() !== target) continue;
    let decoded: { eventName: string; args: unknown };
    try {
      decoded = decodeEventLog({
        abi: BONDING_V5_LAUNCH_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      }) as { eventName: string; args: unknown };
    } catch {
      // Another BondingV5 event, or a log whose topics this ABI has no entry
      // for. Not an error: the receipt legitimately carries many.
      continue;
    }
    if (decoded.eventName !== eventName) continue;
    const projected = project(decoded.args as Record<string, unknown>);
    if (projected !== null) return projected;
  }
  return null;
}

/** The `PreLaunched` event from a `preLaunch` receipt, or `null`. */
export function decodePreLaunched(input: {
  readonly logs: readonly DecodableLaunchLog[];
  readonly bondingV5: Address;
}): DecodedPreLaunched | null {
  return findEvent(input.logs, input.bondingV5, "PreLaunched", (a) => ({
    token: getAddress(a.token as string),
    pair: getAddress(a.pair as string),
    virtualId: a.virtualId as bigint,
    initialPurchaseRaw: a.initialPurchase as bigint,
    launchParams: params(a.launchParams as never),
  }));
}

/**
 * The `Launched` event, from the KEEPER's receipt or from a `getLogs` range.
 *
 * `token` narrows the search when a range holds several launches: `Launched`
 * indexes the token, so the caller normally filters on chain, and this is the
 * belt to that braces.
 */
export function decodeLaunched(input: {
  readonly logs: readonly DecodableLaunchLog[];
  readonly bondingV5: Address;
  readonly token?: Address;
}): DecodedLaunched | null {
  const wanted = input.token === undefined ? null : getAddress(input.token);
  return findEvent(input.logs, input.bondingV5, "Launched", (a) => {
    const token = getAddress(a.token as string);
    if (wanted !== null && token !== wanted) return null;
    return {
      token,
      pair: getAddress(a.pair as string),
      virtualId: a.virtualId as bigint,
      initialPurchaseRaw: a.initialPurchase as bigint,
      initialPurchasedAmountRaw: a.initialPurchasedAmount as bigint,
      launchParams: params(a.launchParams as never),
    };
  });
}

/** The `CancelledLaunch` event from a `cancelLaunch` receipt, or `null`. */
export function decodeCancelledLaunch(input: {
  readonly logs: readonly DecodableLaunchLog[];
  readonly bondingV5: Address;
}): DecodedCancelledLaunch | null {
  return findEvent(input.logs, input.bondingV5, "CancelledLaunch", (a) => ({
    token: getAddress(a.token as string),
    pair: getAddress(a.pair as string),
    virtualId: a.virtualId as bigint,
    refundedRaw: a.initialPurchase as bigint,
  }));
}
