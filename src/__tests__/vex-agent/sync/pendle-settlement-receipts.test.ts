/**
 * The Pendle settlement decoder against REAL mainnet Router receipts.
 *
 * `pendle-settlement-decoder.test.ts` covers the per-role rules with hand-built
 * logs — which can only ever confirm the shape the test author imagined. These
 * tests run the SAME decoder over three verbatim `eth_getTransactionReceipt`
 * results captured from chain 1 (see `fixtures/pendle-settlement/README.md`):
 * a `mintPyFromToken` (1 → PT+YT), a `redeemPyToToken` (PT+YT → 1), and a claim
 * that credits two tokens and spends nothing.
 *
 * The amounts asserted here are the chain's, not ours, and they are pinned as
 * literals: re-capturing from a different transaction must fail loudly rather
 * than silently re-baseline (rules/90 — "never quietly weaken an assertion").
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { decodePendleSettlement } from "@vex-agent/sync/pendle-settlement-decoder.js";
import type { SettlementDecoderInput } from "@vex-agent/sync/settlement-decoders.js";

function receiptFixture(name: string): { from: string; logs: unknown[] } {
  const path = fileURLToPath(new URL(`./fixtures/pendle-settlement/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as { from: string; logs: unknown[] };
}

const PY_MINT = receiptFixture("py-mint-reusd");
const PY_REDEEM = receiptFixture("py-redeem-reusd");
const CLAIM = receiptFixture("claim-interest-and-rewards-ynrwax");

/** The one substituted identity in every fixture (README § Sanitisation). */
const WALLET = "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e";

// reUSD market (mint + redeem fixtures).
const REUSD_PT = "0xecfafdc7741323a945a163ed068b5a3c43483957";
const REUSD_YT = "0xa8bd3b21291ace53927b35563fc80615919e63d7";
const REUSD_TOKEN = "0x5086bf358635b81d8c47c66d1c8b9e567db70c72";

// ynRWAx claim fixture: interest is paid in the underlying, rewards in PENDLE.
const CLAIM_INTEREST_TOKEN = "0x01ba69727e2860b37bc1a2bd56999c1afb4c15d8";
const PENDLE_TOKEN = "0x808507121b80c02388fad14726482e061b8da827";

function decoderInput(over: Partial<SettlementDecoderInput> & { eventRole: string }): SettlementDecoderInput {
  return {
    receipt: { logs: [] },
    protocolExecutionId: 1,
    chainId: 1,
    walletAddress: WALLET,
    tokenInAddress: null,
    tokenOutAddress: null,
    ...over,
  };
}

describe("Pendle settlement decode over real mainnet receipts", () => {
  it("keeps the sanitised wallet as the receipt's own sender in every fixture", () => {
    // Guards the fixtures themselves: a re-capture that forgot to substitute,
    // or substituted a different placeholder, must not silently pass below.
    expect([PY_MINT.from, PY_REDEEM.from, CLAIM.from]).toEqual([WALLET, WALLET, WALLET]);
  });

  it("proves BOTH out-legs of a real mintPyFromToken (1 token in → PT + YT out)", () => {
    const decoded = decodePendleSettlement(
      decoderInput({
        eventRole: "yield_py",
        receipt: PY_MINT,
        tokenInAddress: REUSD_TOKEN,
        tokenOutAddress: REUSD_PT,
        tokenOut2Address: REUSD_YT,
      }),
    );

    expect(decoded).toEqual({
      executedAmountInRaw: "73304758069703379880585",
      executedAmountOutRaw: "79998655357",
      executedAmountOut2Raw: "79998655357",
    });
  });

  it("declines the mint when the second out-leg names a token the wallet never received", () => {
    // PT and YT are minted in EQUAL raw amounts, so asserting the values alone
    // cannot distinguish a correct decode from a transposed one. What CAN be
    // pinned is that each leg is matched by TOKEN: point the second leg at a
    // token absent from this receipt and the whole decode must decline.
    const decoded = decodePendleSettlement(
      decoderInput({
        eventRole: "yield_py",
        receipt: PY_MINT,
        tokenInAddress: REUSD_TOKEN,
        tokenOutAddress: REUSD_PT,
        tokenOut2Address: PENDLE_TOKEN,
      }),
    );

    expect(decoded).toBeNull();
  });

  it("proves BOTH in-legs of a real redeemPyToToken (PT + YT in → 1 token out)", () => {
    const decoded = decodePendleSettlement(
      decoderInput({
        eventRole: "yield_py",
        receipt: PY_REDEEM,
        tokenInAddress: REUSD_PT,
        tokenIn2Address: REUSD_YT,
        tokenOutAddress: REUSD_TOKEN,
      }),
    );

    expect(decoded).toEqual({
      executedAmountInRaw: "150000000000",
      executedAmountIn2Raw: "150000000000",
      executedAmountOutRaw: "137448731623104581990917",
    });
  });

  it("declines a real mint receipt decoded as a redeem — the second leg is on the wrong side", () => {
    // The Option-C side is a property of the ACTION, and the receipt refuses to
    // supply the other one: nothing left the wallet except the input token.
    const decoded = decodePendleSettlement(
      decoderInput({
        eventRole: "yield_py",
        receipt: PY_MINT,
        tokenInAddress: REUSD_PT,
        tokenIn2Address: REUSD_YT,
        tokenOutAddress: REUSD_TOKEN,
      }),
    );

    expect(decoded).toBeNull();
  });

  it("proves a real claim's credit with NO input leg (the yield_claim contract)", () => {
    const decoded = decodePendleSettlement(
      decoderInput({
        eventRole: "yield_claim",
        receipt: CLAIM,
        tokenOutAddress: CLAIM_INTEREST_TOKEN,
      }),
    );

    expect(decoded).toEqual({ executedAmountOutRaw: "50685328007580247388" });
    // A claim spends nothing: the finalizer REJECTS an executed input leg, so
    // the decoder must never invent one from the SY plumbing in this receipt.
    expect(decoded).not.toHaveProperty("executedAmountInRaw");
  });

  it("proves both credits of the same claim when the row carries a second reward leg", () => {
    const decoded = decodePendleSettlement(
      decoderInput({
        eventRole: "yield_claim",
        receipt: CLAIM,
        tokenOutAddress: CLAIM_INTEREST_TOKEN,
        tokenOut2Address: PENDLE_TOKEN,
      }),
    );

    expect(decoded).toEqual({
      executedAmountOutRaw: "50685328007580247388",
      executedAmountOut2Raw: "94079574964058779",
    });
  });

  it("declines the claim when a promised second credit is not in the receipt", () => {
    const decoded = decodePendleSettlement(
      decoderInput({
        eventRole: "yield_claim",
        receipt: CLAIM,
        tokenOutAddress: CLAIM_INTEREST_TOKEN,
        tokenOut2Address: REUSD_PT,
      }),
    );

    expect(decoded).toBeNull();
  });

  it("declines the reused allowance role even on a receipt full of real transfers", () => {
    // An approval moves nothing; there is no net delta that could honestly
    // confirm it, and the surrounding transfers must not be borrowed for one.
    for (const role of ["allowance", "allowance_reset"]) {
      expect(
        decodePendleSettlement(
          decoderInput({
            eventRole: role,
            receipt: PY_MINT,
            tokenInAddress: REUSD_TOKEN,
            tokenOutAddress: REUSD_PT,
          }),
        ),
      ).toBeNull();
    }
  });
});
