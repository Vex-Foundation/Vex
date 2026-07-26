/**
 * Khalani failure classifier (W1) — table-driven coverage of EVERY closed-set
 * row plus the unknown → deny fail-closed default. The classifier is the
 * coordinator-fixed reveal decision consumed by the Relay reveal registry (W5)
 * and the bridge handlers (W3a); this suite pins that no row silently widens or
 * narrows the reveal set.
 */

import { describe, it, expect } from "vitest";
import {
  classifyKhalaniFailure,
  isRevealEligibleKhalaniFailure,
  type KhalaniFailureSignal,
  type KhalaniFailureClassification,
} from "@vex-agent/tools/protocols/khalani/failure-mapping.js";

interface Row {
  readonly label: string;
  readonly signal: KhalaniFailureSignal;
  readonly expected: KhalaniFailureClassification;
}

const exc = (externalName: string | undefined): KhalaniFailureSignal => ({
  kind: "exception",
  externalName,
});

const REVEAL_ELIGIBLE_ROWS: readonly Row[] = [
  {
    label: "empty routes[] (primary no-route signal)",
    signal: { kind: "empty_routes" },
    expected: { outcome: "reveal_eligible", trigger: "empty_routes" },
  },
  {
    label: "CannotFillException",
    signal: exc("CannotFillException"),
    expected: { outcome: "reveal_eligible", trigger: "CannotFillException" },
  },
  {
    label: "NotSupportedChainException",
    signal: exc("NotSupportedChainException"),
    expected: { outcome: "reveal_eligible", trigger: "NotSupportedChainException" },
  },
  {
    label: "NotSupportedTokenException",
    signal: exc("NotSupportedTokenException"),
    expected: { outcome: "reveal_eligible", trigger: "NotSupportedTokenException" },
  },
  {
    label: "NotSupportedContractException",
    signal: exc("NotSupportedContractException"),
    expected: { outcome: "reveal_eligible", trigger: "NotSupportedContractException" },
  },
  {
    label: "NotSupportedAssetReverseContractException",
    signal: exc("NotSupportedAssetReverseContractException"),
    expected: {
      outcome: "reveal_eligible",
      trigger: "NotSupportedAssetReverseContractException",
    },
  },
];

const NOT_ELIGIBLE_ROWS: readonly Row[] = [
  {
    label: "QuoteNotFoundException → requote",
    signal: exc("QuoteNotFoundException"),
    expected: { outcome: "not_eligible", handling: "requote" },
  },
  {
    label: "InternalErrorException → backoff",
    signal: exc("InternalErrorException"),
    expected: { outcome: "not_eligible", handling: "backoff" },
  },
  {
    label: "BroadcastException → resign",
    signal: exc("BroadcastException"),
    expected: { outcome: "not_eligible", handling: "resign" },
  },
  {
    label: "ValidationException → fix_request",
    signal: exc("ValidationException"),
    expected: { outcome: "not_eligible", handling: "fix_request" },
  },
  {
    label: "BadRequestException → fix_request",
    signal: exc("BadRequestException"),
    expected: { outcome: "not_eligible", handling: "fix_request" },
  },
  {
    label: "UnexpectedFromAddressException → fix_request",
    signal: exc("UnexpectedFromAddressException"),
    expected: { outcome: "not_eligible", handling: "fix_request" },
  },
  {
    label: "DuplicateRecordException → fetch_existing",
    signal: exc("DuplicateRecordException"),
    expected: { outcome: "not_eligible", handling: "fetch_existing" },
  },
  {
    label: "NotSupportedDepositMethodException → retry_deposit_method",
    signal: exc("NotSupportedDepositMethodException"),
    expected: { outcome: "not_eligible", handling: "retry_deposit_method" },
  },
];

// Taxonomy names present in the live error set but deliberately NOT in either
// fixed classifier set, plus genuinely unknown / absent names — all fail closed.
const DENY_ROWS: readonly Row[] = [
  {
    label: "IntentNotFoundException (taxonomy, unfixed) → deny",
    signal: exc("IntentNotFoundException"),
    expected: { outcome: "not_eligible", handling: "deny" },
  },
  {
    label: "BuildDepositParsingException (taxonomy, unfixed) → deny",
    signal: exc("BuildDepositParsingException"),
    expected: { outcome: "not_eligible", handling: "deny" },
  },
  {
    label: "genuinely unknown exception name → deny",
    signal: exc("SomeBrandNewException"),
    expected: { outcome: "not_eligible", handling: "deny" },
  },
  {
    label: "undefined externalName (transport/unnamed error) → deny",
    signal: exc(undefined),
    expected: { outcome: "not_eligible", handling: "deny" },
  },
  {
    label: "empty externalName → deny",
    signal: exc(""),
    expected: { outcome: "not_eligible", handling: "deny" },
  },
];

const ALL_ROWS: readonly Row[] = [
  ...REVEAL_ELIGIBLE_ROWS,
  ...NOT_ELIGIBLE_ROWS,
  ...DENY_ROWS,
];

describe("classifyKhalaniFailure — closed-set classification", () => {
  for (const row of ALL_ROWS) {
    it(`classifies ${row.label}`, () => {
      expect(classifyKhalaniFailure(row.signal)).toEqual(row.expected);
    });
  }

  it("every reveal-eligible row is reveal_eligible (and only those)", () => {
    for (const row of REVEAL_ELIGIBLE_ROWS) {
      expect(isRevealEligibleKhalaniFailure(row.signal)).toBe(true);
    }
    for (const row of [...NOT_ELIGIBLE_ROWS, ...DENY_ROWS]) {
      expect(isRevealEligibleKhalaniFailure(row.signal)).toBe(false);
    }
  });

  it("case-sensitivity: a mis-cased exception name is NOT recognised (fails closed)", () => {
    expect(classifyKhalaniFailure(exc("cannotfillexception"))).toEqual({
      outcome: "not_eligible",
      handling: "deny",
    });
    expect(classifyKhalaniFailure(exc("QUOTENOTFOUNDEXCEPTION"))).toEqual({
      outcome: "not_eligible",
      handling: "deny",
    });
  });

  it("the full documented Khalani exception taxonomy is exhaustively classified", () => {
    // Every non-2xx `name` from the Khalani error taxonomy (dossier Appendix A
    // §4) maps to a defined outcome — no exception falls through unhandled.
    const taxonomy = [
      "ValidationException",
      "BadRequestException",
      "CannotFillException",
      "UnexpectedFromAddressException",
      "NotSupportedContractException",
      "BuildDepositParsingException",
      "NotSupportedDepositMethodException",
      "BroadcastException",
      "NotSupportedTokenException",
      "NotSupportedChainException",
      "NotSupportedAssetReverseContractException",
      "IntentNotFoundException",
      "QuoteNotFoundException",
      "DuplicateRecordException",
      "InternalErrorException",
    ];
    for (const name of taxonomy) {
      const result = classifyKhalaniFailure(exc(name));
      // Each is either reveal_eligible with a trigger, or not_eligible with a
      // handling — never an unhandled/undefined shape.
      if (result.outcome === "reveal_eligible") {
        expect(result.trigger).toBeTruthy();
      } else {
        expect(result.handling).toBeTruthy();
      }
    }
  });
});
