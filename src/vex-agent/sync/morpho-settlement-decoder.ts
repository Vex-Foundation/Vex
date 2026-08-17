/**
 * Morpho settlement decoding - turns a mined EVM receipt's ERC-20 Transfer logs
 * into the executed amounts of one `agent_activity` row whose
 * `protocol = 'morpho'` (kind `'lend'`).
 *
 * SAME DOCTRINE AS THE PENDLE AND KYBERSWAP DECODERS: executed amounts come ONLY
 * from NET wallet-delta accounting over the receipt's OWN logs -
 * `sum(Transfer.to = wallet) - sum(Transfer.from = wallet)` per token - never
 * from the quote and never from the intent. A leg that cannot be proven declines
 * the WHOLE decode (`null`) and the caller records no amounts. This module NEVER
 * guesses.
 *
 * ── WHY A VAULT SHARE MINT AND BURN ARE READABLE THIS WAY ───────────────────
 *
 * An ERC-4626 vault share is an ordinary ERC-20 and its mint and burn are
 * ordinary `Transfer` events with the zero address on one side. The wallet is on
 * the OTHER side of both, so the same net-delta rule that reads a swap reads a
 * share mint without needing to know anything about minting: a deposit is a net
 * OUTFLOW of the asset and a net INFLOW of the share token, and a withdrawal is
 * the reverse. Nothing here parses a vault-specific event, which is what keeps
 * it working across both vault generations and across the two different
 * transaction SHAPES the two directions use (a Bundler3 multicall for a deposit,
 * a direct vault call for a withdrawal).
 *
 * The GeneralAdapter1 hop is invisible to this rule for the same reason: the
 * asset may travel wallet -> adapter -> vault inside one transaction, but the
 * wallet's own net delta over the whole receipt is still exactly what left it.
 *
 * ── BOUNDED BY THE INTENT, IN BOTH DIRECTIONS ───────────────────────────────
 *
 * Every proven leg is held against the amount the row itself recorded before
 * broadcasting. Both operations are EXACT on their asset side - a deposit spends
 * the amount asked for, a withdrawal delivers the amount asked for - so a proven
 * asset leg that EXCEEDS the intent is not a settlement, it is evidence the
 * decode read something that was not this operation, and it declines. The bound
 * is a hard inequality against the row's own number, never a percentage and
 * never a tolerance that could grow with size (rules/90).
 *
 * The SHARE leg carries no such bound and deliberately so: the share count is
 * the market-dependent side of the trade and the whole reason the amounts are
 * decoded rather than echoed. It must be a strict, proven movement in the right
 * direction and nothing more. Whether it matches what was quoted is a separate
 * question, answered by `@tools/morpho/mutations.js`'s absolute-tolerance
 * comparison and reported to the user; it is not a condition of recording the
 * truth.
 *
 * ── WHAT DECLINES, AND WHY IT IS NAMED ──────────────────────────────────────
 *
 * `allowance` and `allowance_reset` rows decline: an approval transfers nothing,
 * so no net delta could honestly confirm one. Every role this venue does not
 * write declines too, rather than falling through to a generic reading. A
 * decline leaves the row `pending` with its amounts unknown, which is the honest
 * state - rules/90: a decoder that cannot prove what happened must decline and
 * leave the row pending.
 *
 * ── TWO LANES, TWO RULES, ONE FILE ──────────────────────────────────────────
 *
 * Everything above concerns the VAULT roles (`lend_deposit`, `lend_withdraw`)
 * and reads net wallet deltas. The BLUE MARKET role (`lend_borrow_operate`)
 * cannot be read that way and is decoded from Blue's own events, in the second
 * half of this file, which states why in its own section header. They live
 * together because they answer one question - what does a Morpho receipt prove -
 * and splitting them would put the answer in two places for one venue.
 *
 * CONSUMERS: the Morpho broadcast path
 * (`tools/protocols/morpho/handlers/signed-broadcast.ts`), which decodes its own
 * receipt immediately after mining, and the pending-fallback lane through
 * `sync/executed-amount-fallback/venue-dispatch.ts`. One rule, two callers, no
 * second copy.
 */

import { blueAbi } from "@morpho-org/blue-sdk-viem";
import { decodeEventLog, type Hex } from "viem";

import {
  MORPHO_BORROW_OPERATIONS,
  type MorphoBorrowOperation,
} from "@tools/morpho/mutations.js";

export interface MorphoDecodedSettlement {
  readonly executedAmountInRaw: string;
  readonly executedAmountOutRaw: string;
}

export interface MorphoSettlementLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface MorphoSettlementDecoderInput {
  readonly logs: readonly MorphoSettlementLog[];
  readonly walletAddress: string;
  /**
   * The row's `event_role` VERBATIM. Deliberately a plain string, not the
   * `AgentActivityEventRole` union: this decoder switches on the roles ITS venue
   * writes and DECLINES a role it does not own rather than guessing.
   */
  readonly eventRole: string;
  /** The token that LEFT the wallet: the asset on a deposit, the shares on a withdrawal. */
  readonly tokenInAddress: string | null;
  /** The token that ARRIVED: the shares on a deposit, the asset on a withdrawal. */
  readonly tokenOutAddress: string | null;
  /**
   * The row's own `amount_in_raw` - what the handler RECORDED before
   * broadcasting. The BOUND on a deposit's asset leg, never its answer.
   */
  readonly amountInRaw: string | null;
  /** The row's own `amount_out_raw` - the BOUND on a withdrawal's asset leg. */
  readonly amountOutRaw: string | null;
}

export const MORPHO_SETTLEMENT_PROTOCOL = "morpho";

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** A mined log's ABI `uint256` word is ALWAYS `0x` + exactly 64 hex chars. Anything else is not a real amount. */
const UINT256_HEX_WORD_RE = /^0x[0-9a-fA-F]{64}$/;

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function paddedAddress(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/** Malformed or attacker-controlled log data is IGNORED (one log), never fatal. */
function parseLogAmount(data: string): bigint | null {
  if (!UINT256_HEX_WORD_RE.test(data)) return null;
  try {
    const value = BigInt(data);
    return value >= 0n ? value : null;
  } catch {
    return null;
  }
}

/** Net ERC-20 wallet delta for one token: positive = net received, negative = net sent. */
function netTransferDelta(
  logs: readonly MorphoSettlementLog[],
  tokenAddress: string,
  wallet: string,
): bigint {
  const walletPadded = paddedAddress(wallet);
  const token = tokenAddress.toLowerCase();
  let received = 0n;
  let sent = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== token) continue;
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    // ERC-20 Transfer only - an ERC-721 Transfer has four topics and its third
    // word is a token id, not an amount.
    if (log.topics.length !== 3) continue;
    const amount = parseLogAmount(log.data);
    if (amount === null) continue;
    const from = log.topics[1]?.toLowerCase();
    const to = log.topics[2]?.toLowerCase();
    if (to === walletPadded) received += amount;
    if (from === walletPadded) sent += amount;
  }
  return received - sent;
}

/** A SPENT leg must be a strict net OUTFLOW; its executed amount is the magnitude. */
function provenOutflow(
  logs: readonly MorphoSettlementLog[],
  token: string | null,
  wallet: string,
): bigint | null {
  if (token === null || !EVM_ADDRESS_RE.test(token)) return null;
  const spent = -netTransferDelta(logs, token, wallet);
  return spent > 0n ? spent : null;
}

/** A RECEIVED leg must be a strict net INFLOW. */
function provenInflow(
  logs: readonly MorphoSettlementLog[],
  token: string | null,
  wallet: string,
): bigint | null {
  if (token === null || !EVM_ADDRESS_RE.test(token)) return null;
  const received = netTransferDelta(logs, token, wallet);
  return received > 0n ? received : null;
}

/** The row's own recorded amount as a positive bound, or `null` when it has none. */
function bound(raw: string | null): bigint | null {
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const value = BigInt(raw);
  return value > 0n ? value : null;
}

/**
 * Decode a Morpho `agent_activity` row's executed amounts from a mined receipt.
 * `null` whenever any required leg cannot be proven, or whenever a proven asset
 * leg falls outside the intent that authorised it.
 */
export function decodeMorphoSettlement(
  input: MorphoSettlementDecoderInput,
): MorphoDecodedSettlement | null {
  const wallet = input.walletAddress;
  if (!EVM_ADDRESS_RE.test(wallet)) return null;

  const { logs } = input;

  if (input.eventRole === "lend_deposit") {
    // Asset out, shares in. The ASSET leg is the bounded one: a deposit spends
    // exactly what was asked for, so more than the intent is not this operation.
    const assetBound = bound(input.amountInRaw);
    if (assetBound === null) return null;
    const assetOut = provenOutflow(logs, input.tokenInAddress, wallet);
    if (assetOut === null || assetOut > assetBound) return null;
    const sharesIn = provenInflow(logs, input.tokenOutAddress, wallet);
    if (sharesIn === null) return null;
    return { executedAmountInRaw: assetOut.toString(), executedAmountOutRaw: sharesIn.toString() };
  }

  if (input.eventRole === "lend_withdraw") {
    // Shares out, asset in. Here the ASSET is the OUT leg and the bounded one:
    // a withdrawal delivers exactly the assets asked for.
    const assetBound = bound(input.amountOutRaw);
    if (assetBound === null) return null;
    const assetIn = provenInflow(logs, input.tokenOutAddress, wallet);
    if (assetIn === null || assetIn > assetBound) return null;
    const sharesOut = provenOutflow(logs, input.tokenInAddress, wallet);
    if (sharesOut === null) return null;
    return { executedAmountInRaw: sharesOut.toString(), executedAmountOutRaw: assetIn.toString() };
  }

  // Includes `allowance` / `allowance_reset`: an approval moves no tokens, so no
  // net delta could honestly confirm it here. `lend_borrow_operate` is included
  // too, deliberately: a Blue MARKET operation is not readable by net delta and
  // has its own decoder below.
  return null;
}

// ── THE BLUE MARKET LANE (`lend_borrow_operate`) ────────────────────────────
//
// WHY THE NET-DELTA RULE ABOVE IS NOT REUSED HERE, and why that is not a
// duplicate decoder but a different question.
//
// The vault lane can read a wallet's net ERC-20 delta because a deposit and a
// withdrawal each move exactly two tokens with the wallet on one side of both,
// and the row's own intent bounds them. A Blue market operation cannot be read
// that way for two independent reasons:
//
//   1. A REPAYMENT BY SHARES HAS NO AMOUNT IN THE INTENT AT ALL. Its row is
//      written with `amount_raw = null` because the asset cost of burning a
//      share count is decided on chain. A net delta would be accepted without
//      any bound to hold it against, so ANY movement of the loan token in the
//      same transaction - a fee, a swap leg, a second unrelated repayment -
//      would be recorded as the repayment.
//   2. BLUE IS PERMISSIONLESS. Anyone may open a market pairing the same two
//      tokens. A token movement says nothing about WHICH market it settled, and
//      the market is the whole subject of the row.
//
// Morpho Blue emits its own event for each of the four operations, carrying the
// market id, the position owner and the exact asset amount THE PROTOCOL ITSELF
// accounted for. Four facts must line up before an amount is claimed: the log
// came from this chain's pinned Blue deployment, it decodes under Blue's own
// ABI as the operation's event, its market id is the row's market, and its
// `onBehalf` is the row's wallet. Anything less is declined BY NAME and the row
// stays pending, which is the honest state.

/** The three facts a borrow receipt must be read against, persisted at intent time. */
export interface MorphoBorrowDecodeProvenance {
  readonly operation: MorphoBorrowOperation;
  /** The Blue market id: the hash of the five parameters, `0x` + 64 hex. */
  readonly marketId: string;
  /** The chain's Morpho Blue core deployment, which is also `msg.sender`'s target. */
  readonly blueAddress: string;
}

export interface MorphoBorrowSettlementDecoderInput {
  readonly logs: readonly MorphoSettlementLog[];
  readonly walletAddress: string;
  /** `null` for a row that did not persist it, which declines rather than guessing. */
  readonly provenance: MorphoBorrowDecodeProvenance | null;
  /**
   * The row's OWN `amount_in_raw` and `amount_out_raw`, as a BOUND and never as
   * an answer. Both columns are passed and the decoder reads the one its
   * operation's direction names, so no caller has to restate the operation ->
   * direction mapping this module owns. The named one is `null` for a repayment
   * by shares, which authorised a share count rather than an asset amount and
   * therefore bounds nothing.
   */
  readonly amountInRaw: string | null;
  readonly amountOutRaw: string | null;
}

export type MorphoBorrowSettlementDecode =
  | {
    readonly kind: "decoded";
    /** Relative to the WALLET: `in` = the wallet sent, `out` = the wallet received. */
    readonly direction: "in" | "out";
    readonly executedAmountRaw: string;
  }
  /** Names the REAL cause in agent-readable words. Never a bare failure. */
  | { readonly kind: "declined"; readonly reason: string };

/** The one place a `route_provenance` borrow block is named. Written and read here. */
export const MORPHO_BORROW_PROVENANCE_KEY = "morphoBorrow";

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

/** Which Blue event proves each operation, and which way the wallet's own leg points. */
const BORROW_OPERATION_EVIDENCE: Readonly<Record<MorphoBorrowOperation, {
  readonly eventName: "SupplyCollateral" | "WithdrawCollateral" | "Borrow" | "Repay";
  readonly direction: "in" | "out";
}>> = {
  supply_collateral: { eventName: "SupplyCollateral", direction: "in" },
  withdraw_collateral: { eventName: "WithdrawCollateral", direction: "out" },
  borrow: { eventName: "Borrow", direction: "out" },
  repay: { eventName: "Repay", direction: "in" },
};

/**
 * Blue's own four market events, taken from the SDK's ABI rather than restated
 * here. A narrow ABI on purpose: `decodeEventLog` against the full Blue ABI
 * would happily decode a neighbouring event and leave the caller to notice.
 */
const BLUE_MARKET_EVENT_ABI = blueAbi.filter(
  (entry): entry is Extract<typeof entry, { type: "event" }> =>
    entry.type === "event"
    && (["SupplyCollateral", "WithdrawCollateral", "Borrow", "Repay"] as readonly string[]).includes(entry.name),
);

/** Build the `route_provenance` block a borrow row carries for its own later decode. */
export function morphoBorrowRouteProvenance(
  provenance: MorphoBorrowDecodeProvenance,
): Record<string, unknown> {
  return {
    [MORPHO_BORROW_PROVENANCE_KEY]: {
      operation: provenance.operation,
      marketId: provenance.marketId.toLowerCase(),
      blueAddress: provenance.blueAddress.toLowerCase(),
    },
  };
}

/**
 * Read that block back off a row, validating every field. `null` when the row
 * has none or when any field is not the shape its decode needs - a partially
 * readable provenance is exactly the shape that would send this decoder at the
 * wrong contract or the wrong market.
 */
export function readMorphoBorrowRouteProvenance(
  routeProvenance: Record<string, unknown> | null,
): MorphoBorrowDecodeProvenance | null {
  if (routeProvenance === null) return null;
  const block = routeProvenance[MORPHO_BORROW_PROVENANCE_KEY];
  if (typeof block !== "object" || block === null) return null;
  const { operation, marketId, blueAddress } = block as Record<string, unknown>;
  if (typeof operation !== "string" || !MORPHO_BORROW_OPERATIONS.includes(operation as MorphoBorrowOperation)) {
    return null;
  }
  if (typeof marketId !== "string" || !BYTES32_RE.test(marketId)) return null;
  if (typeof blueAddress !== "string" || !EVM_ADDRESS_RE.test(blueAddress)) return null;
  return {
    operation: operation as MorphoBorrowOperation,
    marketId: marketId.toLowerCase(),
    blueAddress: blueAddress.toLowerCase(),
  };
}

/**
 * A mined topic is ALWAYS a 32-byte word. A type guard rather than a cast: the
 * receipt is a boundary, and the same predicate that makes the value safe is
 * what makes it typed.
 */
function isTopicWord(value: string): value is Hex {
  return BYTES32_RE.test(value);
}

/** Log data is `0x` followed by whole bytes, or it is not ABI-encoded output. */
function isHexData(value: string): value is Hex {
  return /^0x([0-9a-fA-F]{2})*$/.test(value);
}

/** A log's topics as viem needs them, or `null` when one is not a real 32-byte word. */
function eventTopics(log: MorphoSettlementLog): [Hex, ...Hex[]] | null {
  const [signature, ...rest] = log.topics;
  if (signature === undefined || !isTopicWord(signature)) return null;
  const indexed: Hex[] = [];
  for (const topic of rest) {
    if (!isTopicWord(topic)) return null;
    indexed.push(topic);
  }
  return [signature, ...indexed];
}

/** One Blue event's arguments, read as the untrusted record a decoded log is. */
function eventArgument(args: object, name: string): unknown {
  const record: Record<string, unknown> = { ...args };
  return record[name];
}

/**
 * Every Blue event in this receipt that proves THIS row's operation on THIS
 * market for THIS wallet's position. Returns the asset amounts, one per match.
 */
function matchingBlueAssets(
  input: MorphoBorrowSettlementDecoderInput,
  provenance: MorphoBorrowDecodeProvenance,
  eventName: string,
): bigint[] {
  const wallet = input.walletAddress.toLowerCase();
  const blue = provenance.blueAddress.toLowerCase();
  const assets: bigint[] = [];

  for (const log of input.logs) {
    if (log.address.toLowerCase() !== blue) continue;
    const topics = eventTopics(log);
    if (topics === null || !isHexData(log.data)) continue;

    let decoded;
    try {
      decoded = decodeEventLog({ abi: BLUE_MARKET_EVENT_ABI, topics, data: log.data });
    } catch {
      // Not one of Blue's four market events, or malformed. One log is skipped;
      // an unreadable log is never fatal and never an amount.
      continue;
    }
    if (decoded.eventName !== eventName) continue;

    const marketId = eventArgument(decoded.args, "id");
    const onBehalf = eventArgument(decoded.args, "onBehalf");
    const eventAssets = eventArgument(decoded.args, "assets");
    if (typeof marketId !== "string" || marketId.toLowerCase() !== provenance.marketId) continue;
    if (typeof onBehalf !== "string" || onBehalf.toLowerCase() !== wallet) continue;
    if (typeof eventAssets !== "bigint") continue;
    assets.push(eventAssets);
  }

  return assets;
}

/**
 * Decode a `lend_borrow_operate` row's single executed leg from a mined receipt.
 *
 * Every refusal NAMES what was missing, in words an agent can act on, because a
 * decline here leaves a real row pending and somebody has to know why. Nothing
 * is sanitised away in the process: the values named are a market id, a
 * contract address and two amounts, all of which are already columns on the row.
 */
export function decodeMorphoBorrowSettlement(
  input: MorphoBorrowSettlementDecoderInput,
): MorphoBorrowSettlementDecode {
  const { provenance } = input;
  if (provenance === null) {
    return {
      kind: "declined",
      reason:
        "this borrow row did not persist the operation, market and Morpho Blue address its receipt must be read "
        + "against, so which of the four market operations it settled is unknown rather than guessable",
    };
  }
  if (!EVM_ADDRESS_RE.test(input.walletAddress)) {
    return { kind: "declined", reason: "this borrow row's wallet address is not a valid EVM address" };
  }

  const evidence = BORROW_OPERATION_EVIDENCE[provenance.operation];
  const assets = matchingBlueAssets(input, provenance, evidence.eventName);

  if (assets.length === 0) {
    return {
      kind: "declined",
      reason:
        `the receipt contains no Morpho Blue ${evidence.eventName} event emitted by ${provenance.blueAddress} for `
        + `market ${provenance.marketId} on behalf of this row's wallet, so it does not prove this ${provenance.operation}`,
    };
  }
  if (assets.length > 1) {
    return {
      kind: "declined",
      reason:
        `the receipt contains ${assets.length} Morpho Blue ${evidence.eventName} events for market `
        + `${provenance.marketId} on behalf of this row's wallet, and which one this row settled is not proven, so no `
        + "amount is recorded rather than an arbitrary one",
    };
  }

  const executed = assets[0]!;
  if (executed <= 0n) {
    return {
      kind: "declined",
      reason: `the Morpho Blue ${evidence.eventName} event accounted for zero assets, which is not a settlement`,
    };
  }

  // The BOUND, in the one direction it can be applied. A repayment by shares has
  // none by construction, and inventing one from the share count would be the
  // guess this whole module exists to refuse.
  const authorised = bound(evidence.direction === "in" ? input.amountInRaw : input.amountOutRaw);
  if (authorised !== null && executed > authorised) {
    return {
      kind: "declined",
      reason:
        `the Morpho Blue ${evidence.eventName} event accounted for ${executed.toString()} raw units, which exceeds the `
        + `${authorised.toString()} this row recorded before broadcasting, so the receipt is evidence of something `
        + `other than this ${provenance.operation}`,
    };
  }

  return { kind: "decoded", direction: evidence.direction, executedAmountRaw: executed.toString() };
}
