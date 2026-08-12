/**
 * WHAT A BRIDGE DEPOSIT MAY DECLARE IT MOVED - one rule, shared by every venue
 * whose deposit leg is an ERC-20 transfer (Relay and Khalani today).
 *
 * The evidence is the RECEIPT, never the quote and never our own calldata. A
 * quoted amount is what we asked for; a receipt log is what happened, and the
 * two differ on fee-on-transfer tokens, on partial fills, and on any token that
 * does not emit a standard `Transfer`. AgentScan's own verification cross-checks
 * a declared amount against the ERC-20 `Transfer` logs of the same receipt, so a
 * declared amount no log can produce is not merely optimistic: it is scored as a
 * mismatch against the whole installation.
 *
 * An amount is declared ONLY when EXACTLY ONE log satisfies ALL of:
 *
 *   - it is a well-formed ERC-20 `Transfer` (topic0, exactly three topics, an
 *     exact 32-byte data word) emitted by the event's INPUT token;
 *   - `from` is the signing wallet;
 *   - `to` is a recipient proven by the signed transaction or the deposit plan:
 *     the deposit target, or a spender whose approval for THIS token, replayed
 *     in signing order, still leaves a positive effective allowance;
 *   - the amount is greater than zero;
 *   - the amount is at most the QUOTED input amount, and at most the effective
 *     allowance when the recipient is a spender. Both bounds are ABSOLUTE, in
 *     raw units, so neither can scale with trade size and hide a real overspend.
 *
 * Zero candidates or more than one: no amount, and a NAMED decline the caller
 * records and logs. Vex-built knowledge (a Khalani `TRANSFER` plan Vex composed
 * itself) NARROWS which candidate is ours through `expectedAmountRaw`; it never
 * substitutes for the receipt, because built calldata does not guarantee that
 * the token emitted the standard log the server will look for.
 *
 * Only the reason NAME and counts are observable - never a provider payload,
 * never raw log data.
 */

import {
  confirmActivityEvent,
  fillExecutedAmountsOnConfirmed,
  noteSettlementDeclined,
  provenLegAmounts,
  type AgentActivityEvent,
  type AgentActivityEventRole,
  type LegAmountEvidence,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** An EVM log word is `0x` plus exactly 64 hex characters; anything else is not an amount. */
const UINT256_HEX_WORD_RE = /^0x[0-9a-fA-F]{64}$/;

const RAW_INTEGER_RE = /^[0-9]+$/;

/** The three receipt fields this rule reads - the shape every viem receipt log already has. */
export interface DepositTransferLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface Erc20DepositEvidence {
  readonly logs: readonly DepositTransferLog[];
  /** The input token of the activity event whose amount is being established. */
  readonly tokenAddress: string;
  /** The wallet that signed the deposit. */
  readonly senderAddress: string;
  /**
   * Every recipient the signed transaction or the deposit plan proves, each with
   * the ceiling that proof carries. Empty means nothing was proven, which is a
   * decline rather than an unbounded match.
   */
  readonly recipients: readonly AuthorizedDepositRecipient[];
  /** The quoted input amount, raw. The absolute upper bound on what may be declared. */
  readonly quotedAmountInRaw: string;
  /** The exact amount a Vex-built transfer encoded, when the leg has one. */
  readonly expectedAmountRaw?: string;
}

/**
 * An address this deposit's input token may legitimately reach, and the most it
 * may carry there.
 *
 * `maxAmountRaw: null` is the transaction's OWN target: the deposit Vex signed
 * pays it directly, so the quote remains the only ceiling. A spender carries the
 * effective allowance it was granted, because that allowance is exactly how much
 * it was ever able to pull.
 */
export interface AuthorizedDepositRecipient {
  readonly address: string;
  readonly maxAmountRaw: bigint | null;
}

/**
 * ONE approval this execution signed, in the order it was signed.
 */
export interface DepositApprovalGrant {
  readonly token: string;
  readonly spender: string;
  readonly amountRaw: bigint;
}

/**
 * Which addresses the deposit's input may reach, replayed from the approvals
 * this execution actually signed.
 *
 * The replay is the rule, not a formality. Approvals are LAST-WRITE-WINS on
 * chain: `approve(spender, X)` followed by `approve(spender, 0)` leaves the
 * spender able to pull nothing, and a grant list that only remembered "this
 * spender was approved at some point" would keep authorizing it. So the grants
 * are replayed in signing order, only the FINAL effective amount per (token,
 * spender) counts, only the deposit's INPUT token is considered, and only a
 * POSITIVE remainder authorizes anything.
 *
 * `callTarget` is always authorized: it is the address the transaction Vex
 * signed pays, which needs no allowance.
 */
export function authorizedDepositRecipients(args: {
  readonly inputToken: string;
  readonly callTarget: string;
  readonly approvals: readonly DepositApprovalGrant[];
}): AuthorizedDepositRecipient[] {
  const effective = new Map<string, { spender: string; amountRaw: bigint }>();
  for (const grant of args.approvals) {
    if (!sameAddress(grant.token, args.inputToken)) continue;
    effective.set(grant.spender.trim().toLowerCase(), {
      spender: grant.spender,
      amountRaw: grant.amountRaw,
    });
  }
  const recipients: AuthorizedDepositRecipient[] = [{ address: args.callTarget, maxAmountRaw: null }];
  for (const entry of effective.values()) {
    if (entry.amountRaw <= 0n) continue;
    if (sameAddress(entry.spender, args.callTarget)) continue;
    recipients.push({ address: entry.spender, maxAmountRaw: entry.amountRaw });
  }
  return recipients;
}

/** Why no amount could be declared. Named, so a decline is debuggable without the payload. */
export type DepositEvidenceDeclineReason =
  /** No log satisfied every condition. */
  | "no_candidate_transfer"
  /** Several logs did, and nothing in the receipt tells them apart. */
  | "ambiguous_candidate_transfers"
  /** The caller could not state a usable bound or recipient - nothing was even compared. */
  | "unusable_evidence_request";

export type DepositEvidenceOutcome =
  | { readonly kind: "proven"; readonly amountRaw: string }
  | {
      readonly kind: "declined";
      readonly reason: DepositEvidenceDeclineReason;
      readonly candidateCount: number;
    };

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function paddedAddress(address: string): string {
  return `0x${"0".repeat(24)}${address.trim().slice(2).toLowerCase()}`;
}

function parseLogAmount(data: string): bigint | null {
  if (!UINT256_HEX_WORD_RE.test(data)) return null;
  const value = BigInt(data);
  return value > 0n ? value : null;
}

function parseRawAmount(value: string): bigint | null {
  if (!RAW_INTEGER_RE.test(value)) return null;
  return BigInt(value);
}

/**
 * The executed input amount this deposit's receipt proves, or a named decline.
 */
export function proveErc20DepositAmount(evidence: Erc20DepositEvidence): DepositEvidenceOutcome {
  const bound = parseRawAmount(evidence.quotedAmountInRaw);
  if (bound === null || bound <= 0n || evidence.recipients.length === 0) {
    return { kind: "declined", reason: "unusable_evidence_request", candidateCount: 0 };
  }

  const senderTopic = paddedAddress(evidence.senderAddress);
  // The ceiling per authorized recipient: the quote always, and additionally the
  // effective allowance when the recipient is a spender that had to pull.
  const ceilingByTopic = new Map<string, bigint>();
  for (const recipient of evidence.recipients) {
    const ceiling = recipient.maxAmountRaw === null ? bound
      : recipient.maxAmountRaw < bound ? recipient.maxAmountRaw : bound;
    ceilingByTopic.set(paddedAddress(recipient.address), ceiling);
  }
  const candidates: bigint[] = [];
  for (const log of evidence.logs) {
    if (!sameAddress(log.address, evidence.tokenAddress)) continue;
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    // Exactly three topics is what separates an ERC-20 Transfer from an ERC-721
    // one, whose token id is an indexed fourth topic.
    if (log.topics.length !== 3) continue;
    if (log.topics[1]?.toLowerCase() !== senderTopic) continue;
    const to = log.topics[2]?.toLowerCase();
    if (to === undefined) continue;
    const ceiling = ceilingByTopic.get(to);
    if (ceiling === undefined) continue;
    const amount = parseLogAmount(log.data);
    if (amount === null) continue;
    if (amount > ceiling) continue;
    candidates.push(amount);
  }

  // A Vex-built transfer knows the exact amount it encoded, so a candidate equal
  // to it is ours even when the receipt carries other transfers of the same
  // token to the same recipient. When no candidate matches the plan (the token
  // skimmed its own fee, so less arrived), the general rule still applies and
  // still requires a single candidate.
  const expected = evidence.expectedAmountRaw === undefined
    ? null
    : parseRawAmount(evidence.expectedAmountRaw);
  if (expected !== null) {
    const exact = candidates.filter((amount) => amount === expected);
    if (exact.length === 1) return { kind: "proven", amountRaw: expected.toString() };
  }

  if (candidates.length === 0) {
    return { kind: "declined", reason: "no_candidate_transfer", candidateCount: 0 };
  }
  if (candidates.length > 1) {
    return {
      kind: "declined",
      reason: "ambiguous_candidate_transfers",
      candidateCount: candidates.length,
    };
  }
  return { kind: "proven", amountRaw: candidates[0]!.toString() };
}

/**
 * What the confirm site established about this deposit's amount: a proven
 * amount with its own evidence kind (`vex_built_exact` for a native transfer
 * whose signed value IS the principal, `decoded_and_bounded` for a receipt log),
 * or a named decline.
 */
export type DepositSettlement =
  | { readonly kind: "proven"; readonly evidence: LegAmountEvidence }
  | {
      readonly kind: "declined";
      readonly reason: DepositEvidenceDeclineReason;
      readonly candidateCount: number;
    };

/** Adapt a receipt verdict into the settlement the confirm-site writer takes. */
export function receiptDepositSettlement(outcome: DepositEvidenceOutcome): DepositSettlement {
  return outcome.kind === "proven"
    ? { kind: "proven", evidence: { kind: "decoded_and_bounded", amountRaw: outcome.amountRaw } }
    : { kind: "declined", reason: outcome.reason, candidateCount: outcome.candidateCount };
}

export interface DepositSettlementRecord {
  readonly eventId: number;
  readonly role: AgentActivityEventRole;
  readonly txHash: string;
  readonly chainId: number;
  readonly settlement: DepositSettlement;
  /** Log namespace of the calling venue, e.g. `relay.bridge`. */
  readonly logScope: string;
}

export interface DepositSettlementResult {
  readonly applied: boolean;
  readonly row: AgentActivityEvent;
}

/**
 * Confirm a deposit leg WITH the amounts its receipt proved, or confirm it
 * without them and record the decline by name.
 *
 * The status-only race this closes: an EVM repair sweep may have confirmed the
 * same row while this evidence was being established. `confirmActivityEvent` is
 * a once-only transition, so it misses; the amounts must then travel through
 * `fillExecutedAmountsOnConfirmed`, the CAS that owns money on an
 * already-terminal row. A decline records `amounts_undecodable`, which is what
 * releases the row for reporting without amounts instead of holding it forever.
 */
export async function confirmDepositWithProvenAmounts(
  record: DepositSettlementRecord,
): Promise<DepositSettlementResult> {
  const amounts = provenLegAmounts(
    record.role,
    record.settlement.kind === "proven" ? record.settlement.evidence : { kind: "opaque_provider_payload" },
  );

  const confirmResult = await confirmActivityEvent(record.eventId, amounts);

  // Everything below is MONEY bookkeeping on a row whose STATUS question the
  // confirm above already answered. A failure here must never be reported as an
  // unrecorded confirmation, so each writer carries its own failure.
  if (record.settlement.kind === "declined") {
    logger.info(`${record.logScope}.deposit_amount_declined`, {
      id: record.eventId,
      reason: record.settlement.reason,
      candidates: record.settlement.candidateCount,
    });
    try {
      await noteSettlementDeclined(record.eventId, "amounts_undecodable");
    } catch (error) {
      logger.warn(`${record.logScope}.deposit_decline_note_failed`, {
        id: record.eventId,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
    return confirmResult;
  }

  // The status-only race: a repair sweep confirmed this row first, so the
  // once-only confirm transition missed and the amounts must travel through the
  // CAS that owns money on an already-terminal row.
  if (!confirmResult.applied && confirmResult.row.status === "confirmed") {
    try {
      const late = await fillExecutedAmountsOnConfirmed({
        id: record.eventId,
        expectedTxHash: record.txHash,
        expectedChainId: record.chainId,
        amounts,
      });
      logger.info(`${record.logScope}.deposit_amount_late_fill`, {
        id: record.eventId,
        outcome: late.outcome,
      });
    } catch (error) {
      logger.warn(`${record.logScope}.deposit_late_fill_failed`, {
        id: record.eventId,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }
  return confirmResult;
}
