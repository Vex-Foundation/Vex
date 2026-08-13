/**
 * The Solana sweep's SPL balance-delta decoder, proven against VERBATIM
 * mainnet `getTransaction` results (`fixtures/jupiter-settlement/`) plus the
 * negative shapes those captures cannot contain.
 *
 * The contract under test, in one line: an executed amount exists only when
 * exactly ONE account owned by OUR wallet moved the mint in question, and the
 * decoder declines - leaving the sweep to confirm status-only - in every other
 * case. Lamport balances are never read: they carry the network fee, the
 * Jupiter tip and ATA rent, none of which is the swap.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  decodeDeclaredLegExecutedAmounts,
  decodeJupiterSwapExecutedAmounts,
} from "@vex-agent/sync/solana-activity-repair/executed-amounts.js";
import { readOwnerMintDelta } from "@vex-agent/sync/solana-activity-repair/spl-balance-delta.js";

const WALLET = "AeyBYFtgm85BrsZMKrAWdc2qGQqYvwfkt88dZdfYEndS";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP_USD = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";
const WSOL = "So11111111111111111111111111111111111111112";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/jupiter-settlement/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

const solToUsdc = fixture("swap-sol-to-usdc-3SC5Mi5L");
const usdcToSol = fixture("swap-usdc-to-sol-3ewjUYAG");
const jupUsdToUsdc = fixture("swap-jupusd-to-usdc-3g3NAiBJ");

describe("readOwnerMintDelta - real mainnet balance layouts", () => {
  it("reads a fresh output ATA (absent in pre, present in post) as its full post amount", () => {
    expect(readOwnerMintDelta(solToUsdc, { owner: WALLET, mint: USDC })).toEqual({
      outcome: "proven",
      deltaRaw: 1_103_883n,
      decimals: 6,
    });
  });

  it("reads a spent input ATA as a negative delta", () => {
    expect(readOwnerMintDelta(usdcToSol, { owner: WALLET, mint: USDC })).toEqual({
      outcome: "proven",
      deltaRaw: -3_000_000n,
      decimals: 6,
    });
  });

  it("finds our two accounts among 16 balance entries in a multi-hop route", () => {
    expect(readOwnerMintDelta(jupUsdToUsdc, { owner: WALLET, mint: JUP_USD })).toEqual({
      outcome: "proven",
      deltaRaw: -4_584_000n,
      decimals: 6,
    });
    expect(readOwnerMintDelta(jupUsdToUsdc, { owner: WALLET, mint: USDC })).toEqual({
      outcome: "proven",
      deltaRaw: 4_572_791n,
      decimals: 6,
    });
  });

  it("has NO wSOL evidence when the wrap ATA was opened and closed inside the transaction", () => {
    // Both real wrapped-SOL captures: the ATA exists only mid-transaction, so
    // it appears in neither balance array. There is nothing to read, and the
    // lamport delta is not a substitute.
    expect(readOwnerMintDelta(solToUsdc, { owner: WALLET, mint: WSOL })).toEqual({
      outcome: "unproven",
      reason: "no_matching_account",
    });
    expect(readOwnerMintDelta(usdcToSol, { owner: WALLET, mint: WSOL })).toEqual({
      outcome: "unproven",
      reason: "no_matching_account",
    });
  });

  it("ignores foreign owners holding the same mint", () => {
    // Every fixture carries pool-owned USDC/JupUSD accounts; a wallet with no
    // account of its own must read as absence, never as the pool's movement.
    expect(readOwnerMintDelta(jupUsdToUsdc, { owner: "SomeOtherWalletAddress1111111111111111111", mint: USDC })).toEqual(
      { outcome: "unproven", reason: "no_matching_account" },
    );
  });
});

describe("readOwnerMintDelta - shapes the chain captures cannot contain", () => {
  const balance = (accountIndex: number, amount: string, owner = WALLET, mint = USDC, decimals = 6): unknown => ({
    accountIndex,
    mint,
    owner,
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    uiTokenAmount: { amount, decimals, uiAmount: null, uiAmountString: amount },
  });
  const body = (meta: Record<string, unknown>): unknown => ({ meta });

  it("declines when the transaction carries an on-chain error, whatever the balances say", () => {
    expect(
      readOwnerMintDelta(
        body({
          err: { InstructionError: [3, "ProgramFailedToComplete"] },
          preTokenBalances: [balance(1, "1000")],
          postTokenBalances: [balance(1, "4000")],
        }),
        { owner: WALLET, mint: USDC },
      ),
    ).toEqual({ outcome: "unproven", reason: "on_chain_error" });
  });

  it("declines a body with no readable err property - absent is not null", () => {
    expect(
      readOwnerMintDelta(body({ preTokenBalances: [], postTokenBalances: [] }), { owner: WALLET, mint: USDC }),
    ).toEqual({ outcome: "unproven", reason: "unreadable_body" });
  });

  it("declines when a balance array is missing entirely", () => {
    expect(readOwnerMintDelta(body({ err: null, preTokenBalances: [] }), { owner: WALLET, mint: USDC })).toEqual({
      outcome: "unproven",
      reason: "unreadable_body",
    });
  });

  it("declines an unreadable balance entry rather than skipping it - its owner is unknown", () => {
    expect(
      readOwnerMintDelta(
        body({ err: null, preTokenBalances: [{ accountIndex: 1 }], postTokenBalances: [balance(1, "4000")] }),
        { owner: WALLET, mint: USDC },
      ),
    ).toEqual({ outcome: "unproven", reason: "unreadable_body" });
  });

  it("declines when TWO of our accounts moved the same mint - which one is the swap is a guess", () => {
    expect(
      readOwnerMintDelta(
        body({
          err: null,
          preTokenBalances: [balance(1, "1000"), balance(2, "5000")],
          postTokenBalances: [balance(1, "4000"), balance(2, "9000")],
        }),
        { owner: WALLET, mint: USDC },
      ),
    ).toEqual({ outcome: "unproven", reason: "ambiguous_accounts" });
  });

  it("declines when our account exists but did not move", () => {
    expect(
      readOwnerMintDelta(
        body({ err: null, preTokenBalances: [balance(1, "1000")], postTokenBalances: [balance(1, "1000")] }),
        { owner: WALLET, mint: USDC },
      ),
    ).toEqual({ outcome: "unproven", reason: "zero_delta" });
  });

  it("declines when the same account reports two different decimals - the amount is unreadable", () => {
    expect(
      readOwnerMintDelta(
        body({
          err: null,
          preTokenBalances: [balance(1, "1000")],
          postTokenBalances: [balance(1, "4000", WALLET, USDC, 9)],
        }),
        { owner: WALLET, mint: USDC },
      ),
    ).toEqual({ outcome: "unproven", reason: "inconsistent_decimals" });
  });
});

describe("decodeJupiterSwapExecutedAmounts", () => {
  it("proves BOTH legs of a fully-SPL multi-hop swap, with decimals-correct human amounts", () => {
    expect(
      decodeJupiterSwapExecutedAmounts(jupUsdToUsdc, { owner: WALLET, inputMint: JUP_USD, outputMint: USDC }),
    ).toEqual({
      outcome: "proven",
      amounts: {
        executedAmountInRaw: "4584000",
        executedAmountInHuman: "4.584",
        executedAmountOutRaw: "4572791",
        executedAmountOutHuman: "4.572791",
      },
    });
  });

  it("proves a wrapped-SOL INPUT leg from the instruction stream, with the SPL output beside it", () => {
    // The wSOL account is created and closed inside the transaction, so it has
    // no balance entry at all; the wrap principal is read from the instructions.
    expect(decodeJupiterSwapExecutedAmounts(solToUsdc, { owner: WALLET, inputMint: WSOL, outputMint: USDC })).toEqual({
      outcome: "proven",
      amounts: {
        executedAmountInRaw: "15000000",
        executedAmountInHuman: "0.015",
        executedAmountOutRaw: "1103883",
        executedAmountOutHuman: "1.103883",
      },
    });
  });

  it("proves a wrapped-SOL OUTPUT leg as the net credit, never the close payout", () => {
    expect(decodeJupiterSwapExecutedAmounts(usdcToSol, { owner: WALLET, inputMint: USDC, outputMint: WSOL })).toEqual({
      outcome: "proven",
      amounts: {
        executedAmountInRaw: "3000000",
        executedAmountInHuman: "3",
        executedAmountOutRaw: "40177809",
        executedAmountOutHuman: "0.040177809",
      },
    });
  });

  it("declines a native leg whose transient flow cannot be proven - one leg is never half a swap", () => {
    // This body has no wallet-owned transient wrap account at all, so the native
    // leg has neither balance nor instruction evidence.
    expect(
      decodeJupiterSwapExecutedAmounts(jupUsdToUsdc, { owner: WALLET, inputMint: WSOL, outputMint: USDC }),
    ).toEqual({ outcome: "declined", reason: "input_wsol_no_transient_candidate" });
  });

  it("declines when the input leg moved the wrong way - a spent leg cannot gain", () => {
    // The mints deliberately swapped: the real input delta is negative, so
    // reading it as the OUTPUT leg must be refused rather than sign-flipped.
    expect(
      decodeJupiterSwapExecutedAmounts(jupUsdToUsdc, { owner: WALLET, inputMint: USDC, outputMint: JUP_USD }),
    ).toEqual({ outcome: "declined", reason: "input_delta_not_spent" });
  });

  it("declines when both legs name the same mint - a single delta cannot describe two legs", () => {
    expect(
      decodeJupiterSwapExecutedAmounts(jupUsdToUsdc, { owner: WALLET, inputMint: USDC, outputMint: USDC }),
    ).toEqual({ outcome: "declined", reason: "identical_mints" });
  });
});

/**
 * The lend/prediction path: the same bounded deltas, but PER LEG, bounded by the
 * mints the ROW ITSELF declared, because those rows carry no settlement profile.
 * A leg the row never declared is never invented, and a leg whose delta is
 * ambiguous is simply absent from the result.
 */
describe("decodeDeclaredLegExecutedAmounts", () => {
  /** A balance entry in the exact mainnet shape, for the cases the captures cannot contain. */
  const spl = (accountIndex: number, mint: string, amount: string): unknown => ({
    accountIndex,
    mint,
    owner: WALLET,
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: amount },
  });

  it("proves both declared legs when both moved unambiguously", () => {
    expect(
      decodeDeclaredLegExecutedAmounts(jupUsdToUsdc, { owner: WALLET, inputMint: JUP_USD, outputMint: USDC }),
    ).toEqual({
      outcome: "proven",
      amounts: {
        executedAmountInRaw: "4584000",
        executedAmountInHuman: "4.584",
        executedAmountOutRaw: "4572791",
        executedAmountOutHuman: "4.572791",
      },
    });
  });

  it("proves the input leg alone when the row declares no output mint", () => {
    expect(
      decodeDeclaredLegExecutedAmounts(jupUsdToUsdc, { owner: WALLET, inputMint: JUP_USD, outputMint: null }),
    ).toEqual({
      outcome: "proven",
      amounts: { executedAmountInRaw: "4584000", executedAmountInHuman: "4.584" },
    });
  });

  it("proves the output leg alone when the row declares no input mint", () => {
    expect(
      decodeDeclaredLegExecutedAmounts(jupUsdToUsdc, { owner: WALLET, inputMint: null, outputMint: USDC }),
    ).toEqual({
      outcome: "proven",
      amounts: { executedAmountOutRaw: "4572791", executedAmountOutHuman: "4.572791" },
    });
  });

  it("keeps the provable leg and drops the unprovable one", () => {
    // A declared native leg with no transient flow to read: the SPL leg still
    // stands. Partial truth beats both a guess and a blanket refusal.
    expect(
      decodeDeclaredLegExecutedAmounts(jupUsdToUsdc, { owner: WALLET, inputMint: JUP_USD, outputMint: WSOL }),
    ).toEqual({
      outcome: "proven",
      amounts: { executedAmountInRaw: "4584000", executedAmountInHuman: "4.584" },
    });
  });

  it("proves a declared native leg through the same transient flow the swap path uses", () => {
    expect(
      decodeDeclaredLegExecutedAmounts(usdcToSol, { owner: WALLET, inputMint: null, outputMint: WSOL }),
    ).toEqual({
      outcome: "proven",
      amounts: { executedAmountOutRaw: "40177809", executedAmountOutHuman: "0.040177809" },
    });
  });

  it("declines when NEITHER declared leg could be proven", () => {
    expect(
      decodeDeclaredLegExecutedAmounts(jupUsdToUsdc, { owner: WALLET, inputMint: WSOL, outputMint: null }),
    ).toEqual({ outcome: "declined", reason: "no_provable_leg" });
  });

  it("drops a leg whose delta is ambiguous, keeping the leg that is not", () => {
    // Two wallet-owned accounts of the input mint moved: which one the operation
    // was is a guess, so that leg is absent while the output leg still stands.
    const ambiguousInput = {
      meta: {
        err: null,
        preTokenBalances: [
          spl(1, JUP_USD, "1000"),
          spl(2, JUP_USD, "5000"),
          spl(3, USDC, "1000"),
        ],
        postTokenBalances: [
          spl(1, JUP_USD, "400"),
          spl(2, JUP_USD, "4000"),
          spl(3, USDC, "3500"),
        ],
      },
    };

    expect(
      decodeDeclaredLegExecutedAmounts(ambiguousInput, { owner: WALLET, inputMint: JUP_USD, outputMint: USDC }),
    ).toEqual({
      outcome: "proven",
      amounts: { executedAmountOutRaw: "2500", executedAmountOutHuman: "0.0025" },
    });
  });

  it("declines when the only declared leg is ambiguous", () => {
    const ambiguousOnly = {
      meta: {
        err: null,
        preTokenBalances: [spl(1, JUP_USD, "1000"), spl(2, JUP_USD, "5000")],
        postTokenBalances: [spl(1, JUP_USD, "400"), spl(2, JUP_USD, "4000")],
      },
    };

    expect(
      decodeDeclaredLegExecutedAmounts(ambiguousOnly, { owner: WALLET, inputMint: JUP_USD, outputMint: null }),
    ).toEqual({ outcome: "declined", reason: "no_provable_leg" });
  });

  it("declines when the row declares no mint at all", () => {
    expect(
      decodeDeclaredLegExecutedAmounts(jupUsdToUsdc, { owner: WALLET, inputMint: null, outputMint: null }),
    ).toEqual({ outcome: "declined", reason: "no_declared_mint" });
  });

  it("declines when both legs name the same mint - one delta cannot be counted twice", () => {
    expect(
      decodeDeclaredLegExecutedAmounts(jupUsdToUsdc, { owner: WALLET, inputMint: USDC, outputMint: USDC }),
    ).toEqual({ outcome: "declined", reason: "identical_mints" });
  });
});
