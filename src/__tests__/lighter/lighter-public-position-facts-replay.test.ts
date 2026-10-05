import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { validateLighterRecentTrades } from "@tools/lighter/validation.js";
import {
  buildLighterFillRecord,
  isLighterFillBuildFailure,
} from "@vex-agent/tools/protocols/lighter/agentscan-activity.js";
import { projectTrade } from "@vex-agent/tools/protocols/lighter/projectors.js";
import { requireValue } from "../helpers/require-value.js";

// Captured public RHC recentTrades on 2026-10-05, market 19, limit 100.
// These are provider contract observations, not the owner's affected history.
const captured: { readonly response: unknown } = JSON.parse(readFileSync(
  new URL("../fixtures/lighter/rhc-public-position-facts-2026-10-05.json", import.meta.url), "utf8",
));
const trades = validateLighterRecentTrades(captured.response).trades;
// Asset and fee references are local fixtures; position effects use only the
// captured provider trade's before-size, sign flag, size and account side.
const baseAsset = { venueAssetId: "fixture-base", symbol: "BABA", decimals: 4 };
const quoteAsset = { venueAssetId: "fixture-quote", symbol: "USD", decimals: 6 };
const market = { marketSymbol: "BABA-USD", baseAsset, quoteAsset };
const feeTerms = {
  integratorMakerFeeTick: null, integratorTakerFeeTick: null,
  collectorAccountIndex: null, feeAuthorizationIntentId: null, feeAsset: null,
};

function accountView(trade: typeof trades[number], accountIndex: number, enabled = true) {
  const view = projectTrade(trade, accountIndex, { positionFactsWithoutPnl: enabled });
  const account = view.account;
  if (typeof account !== "object" || account === null) throw new Error("missing account view");
  return account;
}

describe("captured RHC position evidence with absent PnL", () => {
  it("replays all 18 complete position observations through the shared ledger and projection classifier", () => {
    expect(trades).toHaveLength(18);
    const effects: string[] = [];
    for (const trade of trades) {
      const role = typeof trade.taker_position_sign_changed === "boolean" ? "taker" : "maker";
      const ask = role === "maker" ? trade.is_maker_ask : !trade.is_maker_ask;
      const accountIndex = ask ? trade.ask_account_id : trade.bid_account_id;
      const record = buildLighterFillRecord({
        trade, intent: null, observation: { environment: "rhc", accountIndex, marketIndex: 19 }, market, feeTerms,
      });
      if (isLighterFillBuildFailure(record)) throw new Error(record.reason);
      expect(record.accountFacts?.accountPnl).toBeNull();
      expect(record.positionEffect).not.toBeNull();
      expect(record.positionEffect).not.toBe("unknown");
      effects.push(requireValue(record.positionEffect));
      expect(accountView(trade, accountIndex)).toMatchObject({ known: true, realizedPnl: null, positionEffect: record.positionEffect });
      expect(accountView(trade, accountIndex, false)).toMatchObject({ known: false, realizedPnl: null, positionEffect: "unknown" });
      const legacy = buildLighterFillRecord({
        trade, intent: null, observation: { environment: "rhc", accountIndex, marketIndex: 19 }, market, feeTerms,
        positionFactsWithoutPnl: false,
      });
      if (isLighterFillBuildFailure(legacy)) throw new Error(legacy.reason);
      expect(legacy.accountFacts).toBeNull();
      expect(legacy.positionEffect).toBeNull();
    }
    expect(effects.filter((effect) => effect === "open")).toHaveLength(7);
    expect(effects.filter((effect) => effect === "close")).toHaveLength(10);
    expect(effects.filter((effect) => effect === "flip")).toHaveLength(1);
  });

  it.each(["1323367940", "1323199710"])("keeps PnL unknown on observed open %s", (tradeId) => {
    const trade = requireValue(trades.find((row) => row.trade_id_str === tradeId));
    const accountIndex = trade.is_maker_ask ? trade.bid_account_id : trade.ask_account_id;
    expect(accountView(trade, accountIndex)).toMatchObject({ positionEffect: "open", positionSizeBefore: "0.0000", realizedPnl: null });
    expect(accountView(trade, 31776)).toMatchObject({ known: false, positionEffect: "unknown" });
  });
});
