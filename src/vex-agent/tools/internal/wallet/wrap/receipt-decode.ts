/**
 * What a mined EVM wrap or unwrap receipt PROVES - the settlement rule for the
 * `kind='wrap'` roles (`wrap`, `unwrap`) introduced by migration 051.
 *
 * ONE RULE, TWO CALLERS, NO SECOND COPY: the wrap confirm handler decodes its
 * own receipt the moment it mines, and the pending-fallback lane
 * (`sync/executed-amount-fallback/venue-dispatch.ts`) decodes the same receipt
 * later for a row whose handler never got to. Both call this function.
 *
 * ── WHY A DEDICATED DECODER AND NOT THE GENERIC WALLET-DELTA RULE ───────────
 *
 * A wrap has ONE ERC-20 leg. The other leg is native, and a native movement
 * emits no log at all: `deposit()` is payable, and `withdraw(uint256)` pays the
 * caller with a plain value transfer. A net-delta reading over ERC-20 Transfers
 * would therefore see half the operation and could not tell a wrap from a
 * received airdrop of the same wrapped token. The wrapper's own `Deposit` /
 * `Withdrawal` events are what state the direction and the quantity, which is
 * why they are the primary evidence here.
 *
 * ── THE AMOUNT RELATIONSHIP (migration 051's header is the specification) ───
 *
 * EVM wrap and unwrap are EXACT, POSITIVE and 1:1 in raw units: `deposit()`
 * credits exactly the transaction's `value`, and `withdraw(amount)` pays exactly
 * `amount`. So one proven quantity establishes BOTH executed legs, and this
 * decoder returns it twice rather than inventing a second number.
 *
 * ── AND THE APPROVED AMOUNT IS AN EQUALITY, NOT A CEILING ───────────────────
 *
 * A local `deposit()` / `withdraw(amount)` has no router, no partial fill and
 * no slippage: the mint or burn is EXACT BY CONSTRUCTION, so the wrapper event
 * must equal the amount the operator approved. A short fill is not a lawful
 * outcome of this call shape - it means the receipt belongs to a different
 * transaction, the row is bound to the wrong intent, or the wrapper is not the
 * WETH9-shaped contract this lane assumes. None of those may be settled.
 *
 * The one-raw-unit tolerance the SWAP lanes carry does NOT apply here and is
 * deliberately not repeated: it exists for router rounding this path has none
 * of, and a tolerance on an exact operation only hides the anomaly.
 *
 * A disagreeing amount therefore DECLINES with a structured warn naming both
 * numbers. Declining is what keeps the row non-terminal: the executed legs stay
 * NULL, so the row remains a candidate of the amount-correction lane rather
 * than being settled with a quantity nothing proved.
 *
 * That 1:1 is an EVM fact and is deliberately NOT generalized: a Solana
 * unwrap-all returns the rent-exempt reserve on top of the wrapped lamports, so
 * `out > in` there is correct. That family has its own decoder; this file must
 * never be widened to cover it.
 *
 * ── WHAT DECLINES, AND WHAT A DECLINE MEANS ─────────────────────────────────
 *
 * `null` whenever the evidence does not establish both legs. Per migration 051:
 * undecodable is NOT a terminal failure - the row stays `pending` with its
 * amounts unknown, which is the honest state. This module never guesses and
 * never falls back to the intent's own numbers as if they were settlement.
 */

import logger from "@utils/logger.js";

/** One mined log, in the shape every venue decoder in this repo already accepts. */
export interface WrapSettlementLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface WrapSettlementDecoderInput {
  readonly logs: readonly WrapSettlementLog[];
  readonly walletAddress: string;
  /** The BOUND wrapped-native contract: the only emitter whose events count. */
  readonly contractAddress: string;
  readonly direction: "wrap" | "unwrap";
  /**
   * The approved amount, in raw units. The proven leg must EQUAL it: the call
   * shape admits no partial fill, so any other quantity is an anomaly, never a
   * settlement. See the module header.
   */
  readonly amountRaw: string;
  /**
   * The signed transaction's own `value`. REQUIRED for a wrap and meaningless
   * for an unwrap: the native input of a wrap is not in any log, so without it
   * the leg is unknowable and the caller must decline by name.
   */
  readonly declaredValueRaw?: string;
}

export interface WrapDecodedSettlement {
  readonly executedAmountInRaw: string;
  readonly executedAmountOutRaw: string;
}

/**
 * WHAT THE RECEIPT PROVED, as three DISTINCT facts.
 *
 * This used to be `WrapDecodedSettlement | null`, and that `null` was the
 * defect: it collapsed "the evidence does not establish the legs" together with
 * "the evidence establishes a quantity that CONTRADICTS the approval". The
 * first is honestly unknown and is migration 051's status-only path; the second
 * is known and wrong. Every caller downstream held one `null` and had to guess
 * which it was - and they all guessed "unknown", so a contradicted amount
 * settled as though it had merely been undecodable.
 *
 *  - `settled`         the legs are proven and EQUAL the approved amount.
 *  - `undecodable`     no wrapper event for this wallet on this contract, or
 *                      evidence legs that disagree with each other. Nothing is
 *                      known yet, so the row stays a correction candidate.
 *  - `amount_mismatch` a wrapper event EXISTS for this wallet and its quantity
 *                      is not the approved one. An anomaly that must reach a
 *                      durable unresolved state, never a settlement.
 */
export type WrapReceiptVerdict =
  | { readonly kind: "settled"; readonly legs: WrapDecodedSettlement }
  | { readonly kind: "undecodable" }
  | {
      readonly kind: "amount_mismatch";
      readonly approvedAmountRaw: string;
      readonly observedAmountRaw: string;
    };

/** `Deposit(address indexed dst, uint wad)`, computed with viem's `toEventSelector`. */
const DEPOSIT_TOPIC = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";

/** `Withdrawal(address indexed src, uint wad)`, computed the same way. */
const WITHDRAWAL_TOPIC = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

/** `Transfer(address indexed from, address indexed to, uint value)`. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** A mined log's ABI `uint256` word is ALWAYS `0x` plus exactly 64 hex chars. */
const UINT256_HEX_WORD_RE = /^0x[0-9a-fA-F]{64}$/;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function paddedAddress(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/** Malformed or attacker-shaped log data is IGNORED (one log), never fatal. */
function parseLogAmount(data: string): bigint | null {
  if (!UINT256_HEX_WORD_RE.test(data)) return null;
  try {
    const value = BigInt(data);
    return value >= 0n ? value : null;
  } catch {
    return null;
  }
}

/** A raw decimal-digit amount as a positive bigint, or `null`. Never a float, never a Number. */
function positiveRaw(value: string | undefined): bigint | null {
  if (value === undefined || !/^[0-9]+$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : null;
}

/**
 * Total `wad` over the wrapper's own events for this wallet.
 *
 * Only logs emitted BY the bound contract count: a `Deposit` from some other
 * contract proves nothing about this wrapper, and matching it would let any
 * unrelated event in the same transaction supply the amount.
 */
function sumWrapperEvents(
  logs: readonly WrapSettlementLog[],
  contract: string,
  topic: string,
  walletPadded: string,
): bigint {
  let total = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== contract) continue;
    if (log.topics[0] !== topic) continue;
    // `Deposit`/`Withdrawal` carry exactly one indexed party, and it must be
    // this wallet: a wrapper event for somebody else is not this row.
    if (log.topics.length !== 2) continue;
    if (log.topics[1]?.toLowerCase() !== walletPadded) continue;
    const amount = parseLogAmount(log.data);
    if (amount === null) continue;
    total += amount;
  }
  return total;
}

/**
 * Total of the ERC-20 EVIDENCE leg: the mint on a wrap (zero address -> wallet)
 * or the burn on an unwrap (wallet -> zero address), on the bound contract.
 *
 * Returned as `null` when no such Transfer exists at all, which is a legitimate
 * state and not a failure: not every wrapper deployment emits one alongside its
 * `Deposit`/`Withdrawal`. When one IS present it must agree with the wrapper
 * event, so a disagreement is a discrepancy rather than a settlement.
 */
function sumEvidenceTransfers(
  logs: readonly WrapSettlementLog[],
  contract: string,
  walletPadded: string,
  direction: "wrap" | "unwrap",
): bigint | null {
  const zeroPadded = paddedAddress(ZERO_ADDRESS);
  const fromPadded = direction === "wrap" ? zeroPadded : walletPadded;
  const toPadded = direction === "wrap" ? walletPadded : zeroPadded;
  let total: bigint | null = null;
  for (const log of logs) {
    if (log.address.toLowerCase() !== contract) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    // ERC-20 Transfer only: an ERC-721 Transfer has four topics and its third
    // word is a token id, not an amount.
    if (log.topics.length !== 3) continue;
    if (log.topics[1]?.toLowerCase() !== fromPadded) continue;
    if (log.topics[2]?.toLowerCase() !== toPadded) continue;
    const amount = parseLogAmount(log.data);
    if (amount === null) continue;
    total = (total ?? 0n) + amount;
  }
  return total;
}

const UNDECODABLE = { kind: "undecodable" } as const;

/**
 * Decode one EVM wrap or unwrap into the fact its receipt establishes.
 *
 * The proven quantity is held against the amount the row itself approved before
 * broadcasting: both directions are exact, so a proven leg that DIFFERS from
 * the approval in either direction is NOT a settlement. The comparison is
 * equality on raw base units, never a percentage (rules/90).
 *
 * A difference is reported as `amount_mismatch` and NOT as `undecodable`,
 * because the caller's durable consequence differs: undecodable leaves a row
 * that may still be repaired, while a contradiction must reach a state a human
 * resolves. See {@link WrapReceiptVerdict}.
 */
export function decodeWrapSettlement(
  input: WrapSettlementDecoderInput,
): WrapReceiptVerdict {
  const wallet = input.walletAddress.trim();
  const contract = input.contractAddress.trim().toLowerCase();
  if (!EVM_ADDRESS_RE.test(wallet) || !EVM_ADDRESS_RE.test(contract)) return UNDECODABLE;

  const approved = positiveRaw(input.amountRaw);
  if (approved === null) return UNDECODABLE;

  const walletPadded = paddedAddress(wallet);
  const topic = input.direction === "wrap" ? DEPOSIT_TOPIC : WITHDRAWAL_TOPIC;
  const wrapped = sumWrapperEvents(input.logs, contract, topic, walletPadded);
  // No wrapper event for this wallet on this contract at all: the receipt
  // simply does not describe this row yet. Honestly UNKNOWN, not an anomaly -
  // so it is not warned about, and the sweep re-reads such rows.
  if (wrapped <= 0n) return UNDECODABLE;
  if (wrapped !== approved) {
    // THE ANOMALY. Both numbers are named so an operator can see the size of
    // the disagreement without re-deriving it; nothing else about the row is
    // logged (no wallet, no calldata, no provider text).
    logger.warn("wallet.wrap.settlement_amount_mismatch", {
      direction: input.direction,
      contractAddress: contract,
      approvedAmountRaw: approved.toString(),
      observedAmountRaw: wrapped.toString(),
    });
    return {
      kind: "amount_mismatch",
      approvedAmountRaw: approved.toString(),
      observedAmountRaw: wrapped.toString(),
    };
  }

  const evidence = sumEvidenceTransfers(input.logs, contract, walletPadded, input.direction);
  if (evidence !== null && evidence !== wrapped) return UNDECODABLE;

  if (input.direction === "wrap") {
    // C21 DISCIPLINE, as on every other native input in this repo: the native
    // leg is proven by the signed transaction's own declared value and by
    // nothing else, and the wrapper's credit must match it EXACTLY. `deposit()`
    // credits precisely what was sent, so anything else means the two facts
    // describe different transactions.
    const declared = positiveRaw(input.declaredValueRaw);
    if (declared === null || declared !== wrapped) return UNDECODABLE;
  }

  // 1:1 by the wrapper contract's construction, in both directions. The unwrap's
  // native output has no log by construction and needs none: it IS the `wad`.
  const proven = wrapped.toString();
  return {
    kind: "settled",
    legs: { executedAmountInRaw: proven, executedAmountOutRaw: proven },
  };
}
