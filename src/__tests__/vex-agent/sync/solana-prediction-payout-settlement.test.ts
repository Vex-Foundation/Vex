/**
 * Jupiter Prediction payout settlement — the STRICTLY-POSITIVE JupUSD guard
 * (phase-3 W2, live-gate DEFECT 7).
 *
 * Why this suite exists, stated plainly so nobody softens it later:
 *
 *  - `decodeTokenBalanceDelta` returns `0n` — NOT `null` — when the wallet's
 *    account for the mint exists but is unchanged. That is EXACTLY the shape
 *    of the transaction Vex broadcasts for a prediction sell/claim: the
 *    proceeds arrive later, in a keeper's fill (chain-proven on
 *    `5AChd2vmZt…`, JupUSD pre=post=271024).
 *  - `confirmActivityEvent` checks PRESENCE, not magnitude (044:134-137), and
 *    `'0'` is present. So labelling the leg JupUSD without this guard would
 *    turn an honest `pending` row into a confirmed ZERO payout — a wrong
 *    number the agent believes.
 *  - The generic decoder takes an ABSOLUTE value
 *    (`solana-settlement-decoders.ts`'s `absRaw`), so a NEGATIVE JupUSD
 *    movement would be recorded as a payout of that magnitude. A non-zero
 *    guard is therefore not enough; the delta must be strictly positive.
 *
 * Zero or negative is NOT a terminal failure — it means we could not read the
 * payout, which is not the same as the payout having failed. The row stays
 * `pending` and the sweep re-checks it.
 */

import { describe, it, expect } from "vitest";

import { parseSolanaTransactionResult } from "@vex-agent/sync/solana-settlement-decoders.js";
import { decodeSolanaSettlement } from "@vex-agent/sync/solana-settlement-dispatch.js";
import {
  PREDICTION_PAYOUT_EVENT_ROLES,
  decodeJupiterPredictionPayoutSettlement,
} from "@vex-agent/sync/solana-prediction-payout-settlement.js";
import {
  JUPITER_PREDICTION_PAYOUT_MINT,
  JUPITER_PREDICTION_USDC_MINT,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/constants.js";

const WALLET = "Wa11etAddr1111111111111111111111111111111";
const OTHER = "OtherAddr111111111111111111111111111111111";

interface TokenBalanceFixture {
  readonly owner: string;
  readonly mint: string;
  readonly amount: string;
}

function parsedTx(
  preTokenBalances: readonly TokenBalanceFixture[],
  postTokenBalances: readonly TokenBalanceFixture[],
) {
  const toTokenBalance = (b: TokenBalanceFixture) => ({
    owner: b.owner,
    mint: b.mint,
    uiTokenAmount: { amount: b.amount },
  });
  const parsed = parseSolanaTransactionResult({
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000_000, 0],
      postBalances: [1_000_000_000, 0],
      preTokenBalances: preTokenBalances.map(toTokenBalance),
      postTokenBalances: postTokenBalances.map(toTokenBalance),
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: {
      message: {
        accountKeys: [WALLET, OTHER].map((k) => ({ pubkey: k, signer: true, writable: true })),
        instructions: [],
      },
    },
  });
  if (!parsed) throw new Error("fixture transaction failed to parse");
  return parsed;
}

/** JupUSD moving from `pre` to `post` on the wallet's own account. */
function jupUsdMove(pre: string, post: string) {
  return parsedTx(
    [{ owner: WALLET, mint: JUPITER_PREDICTION_PAYOUT_MINT, amount: pre }],
    [{ owner: WALLET, mint: JUPITER_PREDICTION_PAYOUT_MINT, amount: post }],
  );
}

function decodePayout(tx: ReturnType<typeof parsedTx>, tokenOutAddress: string | null) {
  return decodeJupiterPredictionPayoutSettlement({
    parsedTransaction: tx,
    walletAddress: WALLET,
    tokenInAddress: null,
    tokenOutAddress,
  });
}

describe("decodeJupiterPredictionPayoutSettlement — strictly-positive JupUSD only", () => {
  it("proves a POSITIVE JupUSD delta as the executed payout", () => {
    expect(decodePayout(jupUsdMove("4999", "271024"), JUPITER_PREDICTION_PAYOUT_MINT)).toEqual({
      executedAmountOutRaw: "266025",
    });
  });

  it("DECLINES a ZERO delta — the account exists but the keeper has not filled yet (the exact live shape of 5AChd2vmZt…)", () => {
    expect(decodePayout(jupUsdMove("271024", "271024"), JUPITER_PREDICTION_PAYOUT_MINT)).toBeNull();
  });

  it("DECLINES a NEGATIVE delta — the generic decoder's abs() would have recorded it as a payout", () => {
    expect(decodePayout(jupUsdMove("271024", "4999"), JUPITER_PREDICTION_PAYOUT_MINT)).toBeNull();
  });

  it("DECLINES when the transaction never touched JupUSD at all", () => {
    const tx = parsedTx(
      [{ owner: WALLET, mint: JUPITER_PREDICTION_USDC_MINT, amount: "0" }],
      [{ owner: WALLET, mint: JUPITER_PREDICTION_USDC_MINT, amount: "7500000" }],
    );
    expect(decodePayout(tx, JUPITER_PREDICTION_PAYOUT_MINT)).toBeNull();
  });

  it("DECLINES a FOREIGN payout mint — including the USDC every pre-fix row was written with", () => {
    const tx = parsedTx(
      [{ owner: WALLET, mint: JUPITER_PREDICTION_USDC_MINT, amount: "0" }],
      [{ owner: WALLET, mint: JUPITER_PREDICTION_USDC_MINT, amount: "7500000" }],
    );
    expect(decodePayout(tx, JUPITER_PREDICTION_USDC_MINT)).toBeNull();
  });

  it("DECLINES a row that names no payout mint", () => {
    expect(decodePayout(jupUsdMove("4999", "271024"), null)).toBeNull();
  });

  it("DECLINES a row that also names an input leg — a shape this decoder cannot prove whole", () => {
    const decoded = decodeJupiterPredictionPayoutSettlement({
      parsedTransaction: jupUsdMove("4999", "271024"),
      walletAddress: WALLET,
      tokenInAddress: JUPITER_PREDICTION_USDC_MINT,
      tokenOutAddress: JUPITER_PREDICTION_PAYOUT_MINT,
    });
    expect(decoded).toBeNull();
  });

  it("credits only the OWNING wallet — another owner's JupUSD credit in the same tx is not ours", () => {
    const tx = parsedTx(
      [{ owner: OTHER, mint: JUPITER_PREDICTION_PAYOUT_MINT, amount: "0" }],
      [{ owner: OTHER, mint: JUPITER_PREDICTION_PAYOUT_MINT, amount: "266025" }],
    );
    expect(decodePayout(tx, JUPITER_PREDICTION_PAYOUT_MINT)).toBeNull();
  });
});

describe("decodeSolanaSettlement — every prediction PAYOUT role routes to the guarded decoder", () => {
  // sell, claim, and BOTH roles closeAll fans out (`predict_close` for a close
  // item, `predict_claim` for a claim item — `predict-execute-close-all.ts`).
  it("covers exactly predict_sell / predict_claim / predict_close", () => {
    expect([...PREDICTION_PAYOUT_EVENT_ROLES].sort()).toEqual(
      ["predict_claim", "predict_close", "predict_sell"],
    );
  });

  for (const eventRole of PREDICTION_PAYOUT_EVENT_ROLES) {
    it(`${eventRole}: a positive JupUSD delta confirms`, () => {
      expect(
        decodeSolanaSettlement({
          parsedTransaction: jupUsdMove("4999", "271024"),
          eventRole,
          walletAddress: WALLET,
          tokenInAddress: null,
          tokenOutAddress: JUPITER_PREDICTION_PAYOUT_MINT,
          routeProvenance: null,
        }),
      ).toEqual({ executedAmountOutRaw: "266025" });
    });

    it(`${eventRole}: a ZERO JupUSD delta leaves the row pending — never a confirmed zero payout`, () => {
      expect(
        decodeSolanaSettlement({
          parsedTransaction: jupUsdMove("271024", "271024"),
          eventRole,
          walletAddress: WALLET,
          tokenInAddress: null,
          tokenOutAddress: JUPITER_PREDICTION_PAYOUT_MINT,
          routeProvenance: null,
        }),
      ).toBeNull();
    });

    it(`${eventRole}: a NEGATIVE JupUSD delta leaves the row pending — never abs()-ed into a payout`, () => {
      expect(
        decodeSolanaSettlement({
          parsedTransaction: jupUsdMove("271024", "4999"),
          eventRole,
          walletAddress: WALLET,
          tokenInAddress: null,
          tokenOutAddress: JUPITER_PREDICTION_PAYOUT_MINT,
          routeProvenance: null,
        }),
      ).toBeNull();
    });

    it(`${eventRole}: a pre-fix USDC-labelled row declines rather than falling back to the generic decoder`, () => {
      const tx = parsedTx(
        [{ owner: WALLET, mint: JUPITER_PREDICTION_USDC_MINT, amount: "0" }],
        [{ owner: WALLET, mint: JUPITER_PREDICTION_USDC_MINT, amount: "7500000" }],
      );
      expect(
        decodeSolanaSettlement({
          parsedTransaction: tx,
          eventRole,
          walletAddress: WALLET,
          tokenInAddress: null,
          tokenOutAddress: JUPITER_PREDICTION_USDC_MINT,
          routeProvenance: null,
        }),
      ).toBeNull();
    });
  }

  it("predict_buy is NOT a payout role — its USDC INPUT leg still takes the generic path", () => {
    const tx = parsedTx(
      [{ owner: WALLET, mint: JUPITER_PREDICTION_USDC_MINT, amount: "18383433" }],
      [{ owner: WALLET, mint: JUPITER_PREDICTION_USDC_MINT, amount: "13383433" }],
    );
    expect(
      decodeSolanaSettlement({
        parsedTransaction: tx,
        eventRole: "predict_buy",
        walletAddress: WALLET,
        tokenInAddress: JUPITER_PREDICTION_USDC_MINT,
        tokenOutAddress: null,
        routeProvenance: null,
      }),
    ).toEqual({ executedAmountInRaw: "5000000" });
  });
});
