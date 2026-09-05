/**
 * The settlement decoder, proven against FOUR REAL RECEIPTS.
 *
 * The fixture is a sanitized copy of the four curve trades made on 2026-09-04 -
 * a BLOOPA buy and sell on Robinhood and a CULTOS buy and sell on Base. Only the
 * session wallet address is substituted; the token, pair and vault addresses,
 * the amounts and the log order are exactly what the chains emitted.
 *
 * WHY THESE RECEIPTS AND NOT A HAND-WRITTEN ONE. A curve trade emits SEVERAL
 * transfers of the same token in one receipt - to the pair, to the tax vault,
 * and on a taxed launch to the anti-sniper vault - so a decoder that took the
 * first match, or that summed every transfer of the token rather than only the
 * wallet's own, would pass a synthetic fixture and misreport a real trade. The
 * sell cases are the ones that matter most: Vex's sell fee is a percentage of
 * exactly the number this decoder produces.
 *
 * The expected values are cross-checked against an INDEPENDENT observation: the
 * live harness recorded the wallet's balance delta for each of the four trades
 * (`received` / `receivedVirtual` in `live-trade/*.json`), and those figures are
 * the ones asserted here. Log decoding and balance deltas are two different ways
 * of asking what moved, and they agree.
 */

import { describe, expect, it } from "vitest";

import { decodeCurveSettlement } from "@tools/virtuals/curve/receipt-decoder.js";

import fixture from "./fixtures/curve-receipts.json" with { type: "json" };
import { definedValue } from "../_test-value-guards.js";

interface FixtureTrade {
  readonly chain: string;
  readonly side: "buy" | "sell";
  readonly txHash: string;
  readonly token: string;
  readonly virtual: string;
  readonly expected: { readonly executedInRaw: string; readonly executedOutRaw: string };
  readonly logs: readonly { readonly address: string; readonly topics: readonly string[]; readonly data: string }[];
}

/**
 * The JSON import types `side` as a bare `string`, so the fixture is NARROWED
 * rather than asserted: a row whose side is neither value fails the suite by
 * name instead of reaching the decoder as a lie about the fixture.
 */
function fixtureTrade(raw: (typeof fixture.trades)[number]): FixtureTrade {
  if (raw.side !== "buy" && raw.side !== "sell") {
    throw new Error(`fixture trade ${raw.txHash} has an unknown side ${raw.side}`);
  }
  return { ...raw, side: raw.side };
}

const trades: readonly FixtureTrade[] = fixture.trades.map(fixtureTrade);
const wallet = fixture.wallet as `0x${string}`;

function tokensFor(trade: FixtureTrade): { spendToken: `0x${string}`; receiveToken: `0x${string}` } {
  return trade.side === "buy"
    ? { spendToken: trade.virtual as `0x${string}`, receiveToken: trade.token as `0x${string}` }
    : { spendToken: trade.token as `0x${string}`, receiveToken: trade.virtual as `0x${string}` };
}

describe("decodeCurveSettlement over real receipts", () => {
  it("has all four trades in the fixture", () => {
    expect(trades).toHaveLength(4);
    expect(trades.map((t) => `${t.chain}/${t.side}`).sort()).toEqual([
      "base/buy",
      "base/sell",
      "robinhood/buy",
      "robinhood/sell",
    ]);
  });

  for (const trade of trades) {
    it(`decodes the ${trade.chain} ${trade.side} (${trade.txHash.slice(0, 10)}) to the wallet's own amounts`, () => {
      const settlement = decodeCurveSettlement({ logs: trade.logs, wallet, ...tokensFor(trade) });
      expect(settlement.decoded).toBe(true);
      expect(settlement.executedInRaw.toString()).toBe(trade.expected.executedInRaw);
      expect(settlement.executedOutRaw.toString()).toBe(trade.expected.executedOutRaw);
    });
  }

  it("counts only the WALLET's transfers, not the pair's or the tax vault's", () => {
    // The Robinhood buy moved 1 VIRTUAL out of the wallet in total, while its
    // receipt carries several VIRTUAL transfers (pair, tax vault, router). A
    // decoder summing every VIRTUAL transfer would report more than the wallet
    // ever spent.
    const buy = definedValue(
      trades.find((t) => t.chain === "robinhood" && t.side === "buy"),
      "the robinhood buy fixture",
    );
    const virtualTransfers = buy.logs.filter((l) => l.address.toLowerCase() === buy.virtual.toLowerCase());
    expect(virtualTransfers.length).toBeGreaterThan(1);
    const settlement = decodeCurveSettlement({ logs: buy.logs, wallet, ...tokensFor(buy) });
    expect(settlement.executedInRaw).toBe(1_000_000_000_000_000_000n);
  });

  it("reports the sell's NET proceeds - what the fee is a percentage of", () => {
    // The curve removed its 1 percent protocol tax inside the transaction, so
    // the wallet received strictly less than the router's gross output. This is
    // the number Vex's sell fee is taken from, and taking it from the gross
    // would overcharge every sell.
    const sell = definedValue(
      trades.find((t) => t.chain === "base" && t.side === "sell"),
      "the base sell fixture",
    );
    const settlement = decodeCurveSettlement({ logs: sell.logs, wallet, ...tokensFor(sell) });
    expect(settlement.executedOutRaw).toBe(BigInt(sell.expected.executedOutRaw));
    expect(settlement.executedOutRaw).toBeGreaterThan(0n);
  });
});

describe("decodeCurveSettlement fails honestly", () => {
  const trade = definedValue(trades[0], "the first fixture trade");

  it("says no transfers were found rather than reporting zeros as a decode", () => {
    const settlement = decodeCurveSettlement({ logs: [], wallet, ...tokensFor(trade) });
    expect(settlement.decoded).toBe(false);
    expect(settlement.undecodedReason).toBe("no_transfers");
    expect(settlement.executedInRaw).toBe(0n);
    expect(settlement.executedOutRaw).toBe(0n);
  });

  it("says the wallet received nothing when the inflow leg is missing", () => {
    const withoutInflow = trade.logs.filter((l) => l.address.toLowerCase() !== trade.token.toLowerCase());
    const settlement = decodeCurveSettlement({ logs: withoutInflow, wallet, ...tokensFor(trade) });
    expect(settlement.decoded).toBe(false);
    expect(settlement.undecodedReason).toBe("no_wallet_inflow");
  });

  it("ignores a log from an unrelated contract", () => {
    const noise = {
      address: "0x000000000000000000000000000000000000dEaD",
      topics: definedValue(trade.logs[0], "the first log of the first fixture trade").topics,
      data: definedValue(trade.logs[0], "the first log of the first fixture trade").data,
    };
    const withNoise = decodeCurveSettlement({ logs: [...trade.logs, noise], wallet, ...tokensFor(trade) });
    const clean = decodeCurveSettlement({ logs: trade.logs, wallet, ...tokensFor(trade) });
    expect(withNoise.executedInRaw).toBe(clean.executedInRaw);
    expect(withNoise.executedOutRaw).toBe(clean.executedOutRaw);
  });

  it("matches addresses case-insensitively, so a checksummed table decodes a lowercase receipt", () => {
    const upper = tokensFor(trade);
    const settlement = decodeCurveSettlement({
      logs: trade.logs,
      wallet: wallet.toUpperCase().replace("0X", "0x") as `0x${string}`,
      spendToken: upper.spendToken.toLowerCase() as `0x${string}`,
      receiveToken: upper.receiveToken.toLowerCase() as `0x${string}`,
    });
    expect(settlement.decoded).toBe(true);
  });
});
