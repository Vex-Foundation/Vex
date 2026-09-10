/**
 * The Trading setup card's decisions, proved without a DOM.
 *
 * These are the rules a person's money depends on being right: the ceiling an
 * input offers, what "Max" resolves to, and what each settled outcome says
 * about whether anything was signed. Table tests, in the shape VS Code's
 * `terminalProfiles.test.ts` uses for the same kind of pure view model.
 *
 * RED ON REVERT: turn `maxLeverageForMarket`'s floor into a round and the 3333
 * row fails, because 4x is a value main is obliged to refuse. Make
 * `describeApplyOutcome` treat `ambiguous` as a failure and the "nothing will
 * be signed again" row fails.
 */

import { describe, expect, it } from "vitest";
import { lighterLeverageOverviewSchema } from "@shared/schemas/lighter-trading-limits.js";
import type {
  ApplyLighterLeverageResult,
  LighterLeverageOverview,
} from "@shared/schemas/lighter-trading-limits.js";
import {
  capitalShareIsUnchanged,
  describeApplyOutcome,
  formatProposalExpiry,
  formatRecordedInstant,
  isRevisionConflict,
  isVaultLocked,
  leveragePickerView,
  maxLeverageForMarket,
  parseCapitalShareInput,
  parseLeverageInput,
  readUnresolvedIntents,
  reconcileIntentIdForMarket,
  visibleLeverageRows,
  type LighterLeverageMarketRow,
  type UnresolvedLeverageIntent,
} from "../lighter-leverage-view.js";
import {
  OUTCOME_AMBIGUOUS,
  OUTCOME_EXPIRED,
  leverageAboveMaximum,
} from "../lighter-trading-setup-copy.js";

function marketRow(
  overrides: Partial<LighterLeverageMarketRow> = {},
): LighterLeverageMarketRow {
  return {
    marketId: 1,
    symbol: "BTC",
    current: {
      initialMarginFraction: 5000,
      leverageDisplay: "2.00",
      marginMode: "cross",
      source: "market_default",
    },
    max: { initialMarginFraction: 200, leverageDisplay: "50.00" },
    openPosition: null,
    ...overrides,
  } as LighterLeverageMarketRow;
}

describe("maxLeverageForMarket", () => {
  it.each([
    // [minimum initial margin fraction, largest whole leverage, why]
    [200, 50, "BTC and ETH on Robinhood Chain"],
    [400, 25, "SOL"],
    [2000, 5, "a five-times market"],
    [3333, 3, "floor, because 4x resolves to 2500 which is below 3333"],
    [5000, 2, "the chain-wide default"],
    [10_000, 1, "a market that admits no leverage at all"],
  ])("reads %i as %ix (%s)", (fraction, expected) => {
    expect(maxLeverageForMarket(fraction)).toBe(expected);
  });

  it.each([0, -1, 10_001, 1.5, Number.NaN])(
    "refuses to invent a ceiling from %s",
    (fraction) => {
      expect(maxLeverageForMarket(fraction)).toBeNull();
    },
  );
});

describe("parseLeverageInput", () => {
  it("accepts a whole leverage inside the market maximum", () => {
    expect(parseLeverageInput("25", 50, "BTC")).toEqual({ kind: "value", leverage: 25 });
  });

  it("accepts exactly the maximum", () => {
    expect(parseLeverageInput("50", 50, "BTC")).toEqual({ kind: "value", leverage: 50 });
  });

  it("names the market maximum when the value is above it", () => {
    expect(parseLeverageInput("51", 50, "BTC")).toEqual({
      kind: "above_max",
      message: leverageAboveMaximum("BTC", 50),
    });
  });

  it.each(["", "   "])("treats %o as nothing typed yet", (raw) => {
    expect(parseLeverageInput(raw, 50, "BTC").kind).toBe("empty");
  });

  it.each(["2.5", "-3", "abc", "0", "1e3"])(
    "refuses %o rather than silently rounding it",
    (raw) => {
      expect(parseLeverageInput(raw, 50, "BTC").kind).toBe("invalid");
    },
  );
});

describe("parseCapitalShareInput", () => {
  it("reads an empty field as no limit, never as zero", () => {
    expect(parseCapitalShareInput("")).toEqual({ kind: "no_limit" });
  });

  it.each([1, 50, 100])("accepts %i percent", (percent) => {
    expect(parseCapitalShareInput(String(percent))).toEqual({ kind: "percent", percent });
  });

  it.each(["0", "101", "12.5", "-5", "half"])("refuses %o", (raw) => {
    expect(parseCapitalShareInput(raw).kind).toBe("invalid");
  });

  it("knows when the typed value is what is already saved", () => {
    expect(capitalShareIsUnchanged(parseCapitalShareInput("40"), 40)).toBe(true);
    expect(capitalShareIsUnchanged(parseCapitalShareInput(""), null)).toBe(true);
    expect(capitalShareIsUnchanged(parseCapitalShareInput(""), 40)).toBe(false);
    expect(capitalShareIsUnchanged(parseCapitalShareInput("41"), 40)).toBe(false);
  });
});

describe("which rows the table shows", () => {
  const withPosition = marketRow({
    marketId: 0,
    symbol: "ETH",
    openPosition: { size: "0.0050", side: "long" },
  });
  const withOwnTerms = marketRow({
    marketId: 1,
    symbol: "BTC",
    current: {
      initialMarginFraction: 400,
      leverageDisplay: "25.00",
      marginMode: "cross",
      source: "position_row",
    },
  });
  const untouched = marketRow({ marketId: 3, symbol: "SOL" });

  it("shows the markets this account already has terms on", () => {
    expect(
      visibleLeverageRows([withPosition, withOwnTerms, untouched], new Set()).map(
        (row) => row.symbol,
      ),
    ).toEqual(["ETH", "BTC"]);
  });

  it("keeps a picked market visible", () => {
    expect(
      visibleLeverageRows([withPosition, untouched], new Set([3])).map((row) => row.symbol),
    ).toEqual(["ETH", "SOL"]);
  });

  it("offers only what is not already on screen, filtered by symbol", () => {
    expect(
      leveragePickerView([withPosition, withOwnTerms, untouched], new Set(), "so").rows.map(
        (row) => row.symbol,
      ),
    ).toEqual(["SOL"]);
    expect(
      leveragePickerView([withPosition, untouched], new Set([3]), "").rows.map(
        (row) => row.symbol,
      ),
    ).toEqual([]);
  });

  it("offers a market the account has no row for, which is the point of the picker", () => {
    // The measured case: an account whose only position row is ETH, on a build
    // whose overview lists every active market. BTC has no terms of its own, so
    // it is not in the table - and it MUST be reachable from the picker.
    const view = leveragePickerView([withPosition, untouched], new Set(), "sol");
    expect(view.rows.map((row) => row.symbol)).toEqual(["SOL"]);
    expect(view.rows[0]?.current.source).toBe("market_default");
  });

  it("browses without a query instead of hiding every market behind one", () => {
    expect(
      leveragePickerView([withPosition, untouched], new Set(), "").rows.map(
        (row) => row.symbol,
      ),
    ).toEqual(["SOL"]);
  });

  it("bounds the window and reports the whole match count", () => {
    const many = Array.from({ length: 57 }, (_, index) =>
      marketRow({ marketId: index + 10, symbol: `M${index}` }),
    );
    const view = leveragePickerView(many, new Set(), "", 8);
    expect(view.rows).toHaveLength(8);
    expect(view.matchCount).toBe(57);
    expect(view.limit).toBe(8);
  });
});

describe("unresolved changes", () => {
  /**
   * A COMPLETE, schema-valid overview with the one field this parse owns
   * replaced by whatever main might actually have put there: an older build
   * that omits it, or a row this build cannot read. Everything else is parsed
   * through the shared schema, so the fixture cannot drift from the contract.
   */
  const VALID_OVERVIEW: LighterLeverageOverview = lighterLeverageOverviewSchema.parse({
    environment: "rhc",
    walletAddress: "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA",
    accountIndex: 24226,
    vaultState: "unlocked",
    markets: [],
    omitted: { count: 0, reason: "none" },
    unresolved: [],
  });

  function overviewWith(unresolved: unknown): LighterLeverageOverview {
    const carried: Record<string, unknown> = { ...VALID_OVERVIEW, unresolved };
    return carried as LighterLeverageOverview;
  }

  const INTENT: UnresolvedLeverageIntent = {
    intentId: "intent-9",
    marketId: 0,
    symbol: "ETH",
    executionState: "ambiguous",
    updatedAt: "2026-09-10T12:00:00.000Z",
  };

  it("reads the durable list the overview carries", () => {
    expect(readUnresolvedIntents(overviewWith([INTENT]))).toEqual({
      rows: [INTENT],
      unreadable: 0,
    });
  });

  it("reads a build with no unresolved field as nothing unresolved", () => {
    expect(readUnresolvedIntents(overviewWith(undefined))).toEqual({ rows: [], unreadable: 0 });
  });

  it("counts a row it cannot read instead of dropping it in silence", () => {
    const read = readUnresolvedIntents(
      overviewWith([INTENT, { intentId: "", marketId: 1, symbol: "BTC" }]),
    );
    expect(read.rows).toEqual([INTENT]);
    expect(read.unreadable).toBe(1);
  });

  it("prefers the durable intent id over anything this visit remembered", () => {
    expect(
      reconcileIntentIdForMarket(0, [INTENT], new Map([[0, "proposal-from-this-visit"]])),
    ).toBe("intent-9");
  });

  it("falls back to the id recorded before an unanswered confirmation", () => {
    expect(reconcileIntentIdForMarket(0, [], new Map([[0, "proposal-7"]]))).toBe("proposal-7");
  });

  it("has nothing to reconcile for a market with neither", () => {
    expect(reconcileIntentIdForMarket(3, [INTENT], new Map())).toBeNull();
  });

  it("reconciles the newest intent when main reports two for one market", () => {
    const older = { ...INTENT, intentId: "intent-1", updatedAt: "2026-09-09T12:00:00.000Z" };
    expect(reconcileIntentIdForMarket(0, [older, INTENT], new Map())).toBe("intent-9");
  });
});

describe("describeApplyOutcome", () => {
  it("states the observed configuration after a completed change", () => {
    const result = {
      status: "completed",
      intentId: "intent-1",
      observed: {
        initialMarginFraction: 400,
        leverageDisplay: "25.00",
        marginMode: "cross",
        source: "position_row",
      },
    } as const satisfies ApplyLighterLeverageResult;
    expect(describeApplyOutcome("BTC", result)).toEqual({
      tone: "success",
      message: "Applied. Lighter now reports 25.00x cross for BTC.",
      reconcilable: false,
    });
  });

  it("repeats a refusal in main's own words", () => {
    const result = {
      status: "refused",
      intentId: null,
      reason: "an agent order is settling on this account; try again when it has settled",
    } as const satisfies ApplyLighterLeverageResult;
    const view = describeApplyOutcome("BTC", result);
    expect(view.message).toContain(
      "an agent order is settling on this account; try again when it has settled",
    );
    expect(view.reconcilable).toBe(false);
  });

  it("offers Reconcile, and only Reconcile, for an ambiguous submission", () => {
    const result = {
      status: "ambiguous",
      intentId: "intent-2",
      reason: "the provider did not return the signed hash",
    } as const satisfies ApplyLighterLeverageResult;
    const view = describeApplyOutcome("BTC", result);
    expect(view.reconcilable).toBe(true);
    expect(view.message).toContain(OUTCOME_AMBIGUOUS);
    expect(view.message).toContain("the provider did not return the signed hash");
  });

  it("carries both the reason and the provider's own status for a rejection", () => {
    const result = {
      status: "rejected",
      intentId: "intent-3",
      providerStatus: 4,
      reason: "the transaction executed with a failure status.",
    } as const satisfies ApplyLighterLeverageResult;
    expect(describeApplyOutcome("BTC", result).message).toBe(
      "Lighter rejected the change: the transaction executed with a failure status. Provider status: 4.",
    );
  });

  it("says the provider status was not reported rather than printing null", () => {
    const result = {
      status: "rejected",
      intentId: "intent-3",
      providerStatus: null,
      reason: "consent expired with the nonce unconsumed.",
    } as const satisfies ApplyLighterLeverageResult;
    expect(describeApplyOutcome("BTC", result).message).toContain(
      "Provider status: Not reported.",
    );
  });

  it("says an expired proposal signed nothing", () => {
    const result = {
      status: "expired",
      intentId: "intent-4",
      reason: "consent expired before submission",
    } as const satisfies ApplyLighterLeverageResult;
    const view = describeApplyOutcome("BTC", result);
    expect(view.message).toContain(OUTCOME_EXPIRED);
    expect(view.reconcilable).toBe(false);
  });
});

describe("small predicates", () => {
  it("locks every control unless the vault is explicitly unlocked", () => {
    expect(isVaultLocked("locked")).toBe(true);
    expect(isVaultLocked("unlocked")).toBe(false);
  });

  it("recognises the stale-revision refusal under any namespace", () => {
    expect(isRevisionConflict("settings.lighter_revision_conflict")).toBe(true);
    expect(isRevisionConflict("data.revision-conflict")).toBe(false);
    expect(isRevisionConflict("validation.invalid_input")).toBe(false);
    expect(isRevisionConflict("settings.write_failed")).toBe(false);
    expect(isRevisionConflict("internal.unexpected")).toBe(false);
  });

  it("shows an unparseable expiry verbatim instead of Invalid Date", () => {
    expect(formatProposalExpiry("not a date")).toBe("not a date");
    expect(formatProposalExpiry("2026-09-10T12:00:00.000Z")).not.toContain("Invalid");
  });

  it("shows an unparseable recorded instant verbatim as well", () => {
    expect(formatRecordedInstant("who knows")).toBe("who knows");
    expect(formatRecordedInstant("2026-09-10T12:00:00.000Z")).not.toContain("Invalid");
  });
});

describe("a proven change whose account read failed", () => {
  it("still reads as applied, carries the note, and never invites a second change", () => {
    const result: ApplyLighterLeverageResult = {
      status: "completed",
      intentId: "intent-1",
      observed: null,
      note: "the account read timed out",
    };
    const view = describeApplyOutcome("BTC", result);
    expect(view.tone).toBe("success");
    expect(view.message).toContain("Applied.");
    expect(view.message).toContain("the account read timed out");
    expect(view.reconcilable).toBe(false);
  });
});
