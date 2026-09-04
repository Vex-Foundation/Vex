/**
 * Holding a bridge execute to the Vex fee statement its approval was granted on.
 *
 * ## Why this module exists
 *
 * The quote decides the fee disposition (charged, or skipped for dust, a
 * fee-on-transfer origin token or a honeypot), that decision is persisted on the
 * prequote row, digest-bound and rendered on the approval card. The executor
 * still re-derives the disposition itself, because a token flagged between the
 * quote and the signature must NOT receive a treasury transfer merely because a
 * row says it should. Two derivations of one money figure is two figures unless
 * something compares them, and that comparison is this module.
 *
 * The comparison lives here, once, for both venues: Relay and Khalani must not
 * be able to disagree about what a divergence is. What each handler owns is
 * WHEN it runs (after its own quote step, before anything is signed) and how it
 * reads its bound row; what this module owns is WHAT counts as the same
 * statement and WHAT the agent is told when it is not.
 *
 * ## Reference
 *
 * MetaMask's `#approveTransaction`
 * (`agents-colab/metamask-core/packages/transaction-controller/src/
 * TransactionController.ts:3074-3180`) signs what was stored and re-derives
 * nothing in the pre-sign window; Rabby's `ethSendTransaction`
 * (`agents-colab/rabby/src/background/controller/provider/controller.ts:
 * 649-730`) consumes the approved payload verbatim. Our own audit
 * (`src/vex-agent/tools/tool-surface-spec/studio-mcp/
 * wallet-reference-audit-2026-08-24.md`) REJECTS both for Vex: the fresh
 * derivation is what would actually execute, so it is compared, and the
 * disagreement refuses rather than picking a side. What IS adopted from
 * MetaMask is the shape of the pre-sign window itself: a controlled result, not
 * a throw, and nothing published before the check passes.
 *
 * ## What a divergence is never allowed to do
 *
 * Refusal is the only outcome. Neither statement is treated as the winner: a
 * fee the card did not state cannot be taken, and a fee the card stated cannot
 * be taken on a token the fresh derivation just declined. The way out is a
 * fresh quote, which restates the fee and gets its own approval.
 */

import type { VexFeePreview } from "@vex-agent/tools/protocols/prequote/fee-disclosure.js";

import { BRIDGE_FEE_BPS } from "./constants.js";
import type { BridgeFeeDisclosure } from "./fee-disclosure.js";

/**
 * The bounded reason a refused execute is logged and reported under. One
 * string, so an operator grepping either venue's logs finds both.
 */
export const VEX_FEE_STATEMENT_CHANGED_REASON = "vex_fee_statement_changed";

/** The bounded reason for a fee-bearing execute whose bound row states no fee. */
export const VEX_FEE_STATEMENT_MISSING_REASON = "vex_fee_statement_missing";

/**
 * The bounded reason for a fee-bearing handler whose prequote registration is
 * absent. NOT a market state and not a user error: these tools are gated by
 * construction, so a missing mapping is an internal authorization failure.
 */
export const VEX_FEE_GATE_UNREGISTERED_REASON = "vex_fee_gate_unregistered";

/** The bounded reason for a bound row that authorizes no execute at all. */
export const VEX_FEE_QUOTE_UNAUTHORIZED_REASON = "vex_fee_quote_unauthorized";

/**
 * A bridge refusal as the PUBLIC tool result must carry it (Codex round-2
 * suggestion, rule 04 layer 3).
 *
 * The venues used to return a bare sentence, so the typed reason existed only in
 * a log line and the agent-facing result collapsed every fee-statement refusal
 * into the venue's generic bridge failure. An agent cannot pick a remedy from
 * that: "the approved fee moved, re-quote" and "the bridge failed" are different
 * situations.
 *
 * Bounded by construction: a reason token, the FIELD names that moved (never
 * their values, never an address) and one first-party remediation sentence.
 */
export interface BridgeFeeRefusal {
  readonly reason: string;
  readonly movedFields: readonly BridgeFeeStatementField[];
  /** The agent-facing sentence, already built by the message helpers below. */
  readonly message: string;
  readonly remediation: string;
}

/**
 * The `data` block a refusing bridge result carries. The key and shape are the
 * same `_vexFeeRefusal` the swap venues emit (`tools/vex-fee/fee-revalidation.
 * ts`), so one agent-side reader covers all four venues, and the `_` prefix is
 * the established convention for a Vex-authored field on these results.
 */
export function bridgeFeeRefusalData(refusal: BridgeFeeRefusal): Record<string, unknown> {
  return {
    _vexFeeRefusal: {
      reason: refusal.reason,
      movedFields: [...refusal.movedFields],
      remediation: refusal.remediation,
    },
  };
}

/**
 * The fields compared, in the order they are compared. `charged` first because
 * a disposition change makes every amount below it incomparable, and naming the
 * amount instead of the disposition would describe the symptom.
 */
export type BridgeFeeStatementField =
  | "charged"
  | "bps"
  | "feeAmountRaw"
  | "netAmountRaw"
  | "totalDebitedRaw"
  | "receiver";

/**
 * One field moved. `statedOnCard` and `derivedNow` are the two values, as
 * strings, for the caller's own reporting; the message builder below decides
 * which of them may appear in agent-facing text (an address never does).
 */
export interface BridgeFeeStatementDivergence {
  readonly field: BridgeFeeStatementField;
  readonly statedOnCard: string;
  readonly derivedNow: string;
}

export type BridgeFeeStatementCheck =
  | { readonly ok: true }
  | ({ readonly ok: false } & BridgeFeeStatementDivergence);

const UNCHANGED: BridgeFeeStatementCheck = { ok: true };

/**
 * Does the fee this execute would actually take still match the statement the
 * approval was granted on?
 *
 * `statedOnCard` is the row's persisted block, re-parsed by its own owner
 * (`prequote/fee-disclosure.ts`) before it reaches here. `derivedNow` is the
 * venue's own fresh disclosure, built from the split and the eligibility read
 * this call performed, which is the disposition the deposit and the fee leg
 * would use. Pure and total: it reads two values and returns a verdict, so it
 * can never be the reason a bridge fails for an unrelated cause.
 *
 * A skipped statement carries no fee amount and no receiver, so those fields
 * are compared only when BOTH sides are charged; a disposition change is
 * reported as `charged` and nothing further is read.
 */
export function checkBridgeFeeStatementUnchanged(input: {
  readonly statedOnCard: VexFeePreview;
  readonly derivedNow: BridgeFeeDisclosure;
}): BridgeFeeStatementCheck {
  const stated = input.statedOnCard;
  const derived = input.derivedNow;

  if (stated.charged !== derived.charged) {
    return {
      ok: false,
      field: "charged",
      statedOnCard: stated.charged ? "charged" : "not charged",
      derivedNow: derived.charged ? "charged" : "not charged",
    };
  }
  if (stated.bps !== derived.bps) {
    return { ok: false, field: "bps", statedOnCard: String(stated.bps), derivedNow: String(derived.bps) };
  }
  if (stated.charged && derived.charged) {
    if (stated.feeAmountRaw !== derived.feeAmountRaw) {
      return {
        ok: false,
        field: "feeAmountRaw",
        statedOnCard: stated.feeAmountRaw,
        derivedNow: derived.feeAmountRaw,
      };
    }
    if (stated.receiver !== derived.receiver) {
      return { ok: false, field: "receiver", statedOnCard: stated.receiver, derivedNow: derived.receiver };
    }
  }
  if (stated.netAmountRaw !== derived.bridgedAmountRaw) {
    return {
      ok: false,
      field: "netAmountRaw",
      statedOnCard: stated.netAmountRaw,
      derivedNow: derived.bridgedAmountRaw,
    };
  }
  if (stated.totalDebitedRaw !== derived.totalDebitedRaw) {
    return {
      ok: false,
      field: "totalDebitedRaw",
      statedOnCard: stated.totalDebitedRaw,
      derivedNow: derived.totalDebitedRaw,
    };
  }
  return UNCHANGED;
}

/**
 * The refusal an agent reads, naming WHICH field moved in plain words.
 *
 * Two things it never contains: an address (the treasury and the wallet are not
 * the agent's business on a refusal, and a mismatched receiver is a build or
 * config fault, not something an agent can act on) and any provider text. Raw
 * atomic amounts DO appear: they are the same figures the card showed, and
 * without them "the fee changed" is not actionable.
 *
 * Every branch ends the same way, because there is exactly one recovery: quote
 * again and approve the fresh statement.
 */
export function bridgeFeeStatementChangedMessage(
  divergence: BridgeFeeStatementDivergence,
  quoteToolName: string,
): string {
  return `${describeMovedField(divergence)} Nothing was signed and nothing was broadcast: approving a card`
    + " authorizes the Vex fee statement it showed, never a different one. Call"
    + ` ${quoteToolName} again and approve the fresh quote.`;
}

function describeMovedField(divergence: BridgeFeeStatementDivergence): string {
  const lead = "The Vex fee statement this approval was granted on no longer holds:";
  switch (divergence.field) {
    case "charged":
      return divergence.derivedNow === "charged"
        ? `${lead} the approved quote stated that NO Vex fee would be taken on this bridge, and a fee of`
          + ` ${BRIDGE_FEE_BPS} bps would now be taken instead.`
        : `${lead} the approved quote stated a Vex fee would be taken, and it would no longer be taken`
          + " (the origin token is now declined for the fee, or the amount's fee floors to zero), so the"
          + " amount the bridge would deposit is not the amount the card stated.";
    case "bps":
      return `${lead} the fee rate stated on the card was ${divergence.statedOnCard} bps and this bridge`
        + ` would take ${divergence.derivedNow} bps.`;
    case "feeAmountRaw":
      return `${lead} the card stated a Vex fee of ${divergence.statedOnCard} raw units and this bridge`
        + ` would take ${divergence.derivedNow} raw units.`;
    case "netAmountRaw":
      return `${lead} the card stated that ${divergence.statedOnCard} raw units would be bridged and this`
        + ` bridge would deposit ${divergence.derivedNow} raw units.`;
    case "totalDebitedRaw":
      return `${lead} the card stated a total debit of ${divergence.statedOnCard} raw units and this bridge`
        + ` would debit ${divergence.derivedNow} raw units.`;
    case "receiver":
      return `${lead} the treasury address the card stated is not the address this bridge would pay the fee`
        + " to.";
  }
}

/**
 * A fee-bearing bridge execute whose bound row carries no readable fee
 * statement. Fail closed: the gate refuses such a row before the handler is
 * reached, so reaching here means the row changed underneath or a build wrote a
 * row without one, and neither is a state in which money may move unbound.
 */
export function missingBridgeFeeStatementMessage(quoteToolName: string): string {
  return "the quote authorizing this bridge carries no readable Vex fee statement, so the fee this bridge"
    + " would take cannot be bound to anything a person approved. Nothing was signed and nothing was"
    + ` broadcast. Call ${quoteToolName} again and approve the fresh quote.`;
}

/**
 * Why the re-read of the authorizing row found nothing this bridge may execute
 * on, in words an agent can act on.
 *
 * Shared by both bridge venues for the same reason the comparison is: the two
 * handlers refuse the same states, so they must refuse them in the same
 * vocabulary. `not_gated` is absent on purpose - it is not a quote state at all,
 * and its refusal is `unregisteredBridgeFeeGateMessage` below.
 */
export function unauthorizedBridgeQuoteMessage(
  refusal: {
    readonly reason: "no_quote" | "safety_fail" | "not_executable"
      | "approval_row_superseded" | "approved_disclosure_changed" | "approval_binding_missing";
    /** Present only on `not_executable`; always passed, `undefined` elsewhere. */
    readonly eligibilityKind: string | undefined;
  },
  quoteToolName: string,
): string {
  switch (refusal.reason) {
    case "no_quote":
      return `no matching fee-bearing quote found. Call ${quoteToolName} first with the exact same params,`
        + " then retry.";
    case "safety_fail":
      return "the quote for this exact request is recorded as a confirmed safety failure. Nothing was"
        + " signed or broadcast, and re-running the execute cannot clear it.";
    case "not_executable":
      return "the quote authorizing this bridge was superseded by a newer quote for the same request that"
        + ` authorizes nothing (recorded eligibility: ${refusal.eligibilityKind ?? "unknown"}). Nothing was`
        + ` signed or broadcast. Call ${quoteToolName} again and read its eligibility before retrying.`;
    case "approval_row_superseded":
      return `a newer ${quoteToolName} for these exact params was recorded while the approval waited, so the`
        + " quote the approval card named is no longer the current one. Nothing was signed or broadcast."
        + " Approving a card authorizes the quote it showed, including its Vex fee statement, never a later"
        + ` one. Call ${quoteToolName} again and approve the fresh quote.`;
    case "approved_disclosure_changed":
      return "the approved quote is still the current one, but the disclosure it carries now is not the one"
        + " the approval card stated, so signing would bridge against numbers nobody consented to. Nothing"
        + ` was signed or broadcast. Call ${quoteToolName} again and approve the fresh quote.`;
    case "approval_binding_missing":
      return "this approval does not record WHICH quote it authorized, so no quote can be proven to be the"
        + ` one that was approved. Nothing was signed or broadcast. Call ${quoteToolName} again and approve`
        + " the fresh quote.";
  }
}

/**
 * A fee-bearing bridge handler whose execute-gate registration is missing.
 *
 * `not_gated` used to be answered with `null` - "proceed" - on both bridge
 * venues, which made the loss of the registry mapping a grant of permission to
 * sign (review finding, 2026-09-04). These two tools are gated BY CONSTRUCTION:
 * their whole fee authority is the prequote row, so an absent registration means
 * this build cannot bind the fee to anything a person approved. Rule 07: missing
 * or unknown authority fails closed.
 *
 * It is deliberately NOT phrased as a quote problem. Re-quoting cannot fix a
 * build that lost its mapping, and telling an agent to retry a call that can
 * never succeed is the dead end this vocabulary avoids everywhere else.
 */
export function unregisteredBridgeFeeGateMessage(bridgeToolId: string): string {
  return `${bridgeToolId} is a fee-bearing tool with no registered quote gate in this build, so the Vex fee`
    + " it would take cannot be bound to any approved quote. Nothing was signed, nothing was broadcast and"
    + " no funds moved. This is a Vex build defect, not a state you can clear: report it. A bridge is still"
    + " possible through the other bridge venue.";
}
