/**
 * `solana-settlement-decoders` — pure owner+mint balance-delta decoding from
 * a raw `getTransaction` (jsonParsed) RPC response (W5 design §4/R3, K3).
 *
 * Pins: account create/close handling (missing pre/post side treated as
 * zero), native-SOL fee netting for the fee payer only, rent netted ONLY for
 * accounts that survived the transaction (design
 * `solana-settlement-profile-design.md` D5), the WSOL
 * token-balance-first-then-native fallback for `SOL_MINT`, the
 * `event_role='swap'` both-legs rule, and the "never guess" decline path
 * for every other role when the named mint was never touched.
 */

import { describe, it, expect } from "vitest";

import {
  parseSolanaTransactionResult,
  decodeTokenBalanceDelta,
  decodeNativeSolDelta,
  decodeMintDelta,
  decodeSolanaBalanceSettlement,
  type ParsedSolanaTransaction,
} from "@vex-agent/sync/solana-settlement-decoders.js";
import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";

const WALLET = "Wa11etAddr1111111111111111111111111111111";
const OTHER = "OtherAddr111111111111111111111111111111111";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface TokenBalanceFixture {
  readonly owner: string;
  readonly mint: string;
  readonly amount: string;
}

function fixtureRawTransaction(overrides: {
  readonly err?: unknown;
  readonly fee?: number;
  readonly accountKeys?: readonly string[];
  readonly preBalances?: readonly number[];
  readonly postBalances?: readonly number[];
  readonly preTokenBalances?: readonly TokenBalanceFixture[];
  readonly postTokenBalances?: readonly TokenBalanceFixture[];
  readonly loadedWritable?: readonly string[];
  readonly loadedReadonly?: readonly string[];
  readonly instructions?: readonly unknown[];
  readonly innerInstructions?: readonly unknown[];
} = {}): unknown {
  const toTokenBalance = (b: TokenBalanceFixture) => ({
    owner: b.owner,
    mint: b.mint,
    uiTokenAmount: { amount: b.amount },
  });
  return {
    meta: {
      err: overrides.err ?? null,
      fee: overrides.fee ?? 5000,
      preBalances: overrides.preBalances ?? [1_000_000_000, 0],
      postBalances: overrides.postBalances ?? [1_000_000_000, 0],
      preTokenBalances: (overrides.preTokenBalances ?? []).map(toTokenBalance),
      postTokenBalances: (overrides.postTokenBalances ?? []).map(toTokenBalance),
      loadedAddresses: {
        writable: overrides.loadedWritable ?? [],
        readonly: overrides.loadedReadonly ?? [],
      },
      innerInstructions: overrides.innerInstructions,
    },
    transaction: {
      message: {
        accountKeys: (overrides.accountKeys ?? [WALLET, OTHER]).map((k) => ({
          pubkey: k,
          signer: true,
          writable: true,
        })),
        instructions: overrides.instructions ?? [],
      },
    },
  };
}

/** A `system` program `transfer` parsed instruction (jsonParsed shape). */
function systemTransfer(source: string, destination: string, lamports: number): unknown {
  return { program: "system", parsed: { type: "transfer", info: { source, destination, lamports } } };
}

/** A `system` program `createAccount` parsed instruction (jsonParsed shape) — the ATA/account-rent-funding pattern. */
function systemCreateAccount(source: string, newAccount: string, lamports: number): unknown {
  return {
    program: "system",
    parsed: {
      type: "createAccount",
      info: { source, newAccount, lamports, space: 165, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
    },
  };
}

describe("parseSolanaTransactionResult", () => {
  it("parses a well-formed jsonParsed getTransaction response", () => {
    const parsed = parseSolanaTransactionResult(fixtureRawTransaction());
    expect(parsed).not.toBeNull();
    expect(parsed?.err).toBeNull();
    expect(parsed?.feeLamports).toBe(5000);
    expect(parsed?.accountKeys).toEqual([WALLET, OTHER]);
  });

  it("accepts legacy plain-string accountKeys (non-jsonParsed fallback)", () => {
    const raw = fixtureRawTransaction();
    (raw as Record<string, unknown> & { transaction: { message: { accountKeys: unknown } } }).transaction.message.accountKeys = [WALLET, OTHER];
    const parsed = parseSolanaTransactionResult(raw);
    expect(parsed?.accountKeys).toEqual([WALLET, OTHER]);
  });

  it("appends loadedAddresses.writable then .readonly after the static keys, in order", () => {
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({ loadedWritable: ["ALT_W1"], loadedReadonly: ["ALT_R1", "ALT_R2"] }),
    );
    expect(parsed?.accountKeys).toEqual([WALLET, OTHER, "ALT_W1", "ALT_R1", "ALT_R2"]);
  });

  it("returns null when meta is missing", () => {
    expect(parseSolanaTransactionResult({ transaction: {} })).toBeNull();
  });

  it("returns null when preBalances contains a non-number entry", () => {
    const raw = fixtureRawTransaction() as Record<string, unknown>;
    (raw.meta as Record<string, unknown>).preBalances = [1, "oops"];
    expect(parseSolanaTransactionResult(raw)).toBeNull();
  });

  it("returns null when a token balance entry is missing owner/mint", () => {
    const raw = fixtureRawTransaction() as Record<string, unknown>;
    (raw.meta as Record<string, unknown>).preTokenBalances = [{ uiTokenAmount: { amount: "1" } }];
    expect(parseSolanaTransactionResult(raw)).toBeNull();
  });

  it("returns null for a non-object input", () => {
    expect(parseSolanaTransactionResult(null)).toBeNull();
    expect(parseSolanaTransactionResult("nope")).toBeNull();
  });
});

describe("decodeTokenBalanceDelta", () => {
  it("computes post - pre for a matching owner+mint", () => {
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        preTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: "1000000" }],
        postTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: "1500000" }],
      }),
    )!;
    expect(decodeTokenBalanceDelta(parsed, WALLET, USDC_MINT)).toBe(500000n);
  });

  it("treats a missing PRE side as zero (account created within the tx)", () => {
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        postTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: "42" }],
      }),
    )!;
    expect(decodeTokenBalanceDelta(parsed, WALLET, USDC_MINT)).toBe(42n);
  });

  it("treats a missing POST side as zero (account closed within the tx)", () => {
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        preTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: "42" }],
      }),
    )!;
    expect(decodeTokenBalanceDelta(parsed, WALLET, USDC_MINT)).toBe(-42n);
  });

  it("returns null when neither side names this owner+mint (never touched)", () => {
    const parsed = parseSolanaTransactionResult(fixtureRawTransaction())!;
    expect(decodeTokenBalanceDelta(parsed, WALLET, USDC_MINT)).toBeNull();
  });

  it("SUMS every matching owner+mint entry per side (multiple token accounts) rather than matching only the first", () => {
    // First account unchanged (1,000,000 -> 1,000,000); second account gains 500,000.
    // A `.find()`-based decoder would report 0 (wrong); summing reports the real 500,000 gain.
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        preTokenBalances: [
          { owner: WALLET, mint: USDC_MINT, amount: "1000000" },
          { owner: WALLET, mint: USDC_MINT, amount: "200000" },
        ],
        postTokenBalances: [
          { owner: WALLET, mint: USDC_MINT, amount: "1000000" },
          { owner: WALLET, mint: USDC_MINT, amount: "700000" },
        ],
      }),
    )!;
    expect(decodeTokenBalanceDelta(parsed, WALLET, USDC_MINT)).toBe(500000n);
  });
});

describe("decodeNativeSolDelta", () => {
  it("nets out the network fee for the fee payer (combined index 0)", () => {
    // Sent 1 SOL + paid the 5000-lamport fee.
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        fee: 5000,
        preBalances: [2_000_000_000, 0],
        postBalances: [999_995_000, 0],
      }),
    )!;
    expect(decodeNativeSolDelta(parsed, WALLET)).toBe(-1_000_000_000n);
  });

  it("does NOT adjust for fee when the wallet is not the fee payer (index > 0)", () => {
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        fee: 5000,
        preBalances: [500_000_000, 1_000_000_000],
        postBalances: [494_995_000, 1_500_000_000],
      }),
    )!;
    expect(decodeNativeSolDelta(parsed, OTHER)).toBe(500_000_000n);
  });

  it("returns null when the wallet is not in the combined account-key list", () => {
    const parsed = parseSolanaTransactionResult(fixtureRawTransaction())!;
    expect(decodeNativeSolDelta(parsed, "SomeoneElse1111111111111111111111111111111")).toBeNull();
  });

  it("nets out ATA-creation rent EXACTLY when the created account SURVIVES the transaction (top-level instruction)", () => {
    // Only the fee (5000) + rent (2,039,280) left the wallet's native balance; no other movement.
    const newAta = "NewAta11111111111111111111111111111111111";
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        fee: 5000,
        accountKeys: [WALLET, OTHER, newAta],
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [1_997_955_720, 0, 2_039_280], // the new account still holds its rent
        instructions: [systemCreateAccount(WALLET, newAta, 2_039_280)],
      }),
    )!;
    expect(decodeNativeSolDelta(parsed, WALLET)).toBe(0n);
  });

  it("nets out ATA-creation rent for a createAccount nested in innerInstructions (CPI, e.g. associated-token-account program)", () => {
    const newAta = "NewAta22222222222222222222222222222222222";
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        fee: 5000,
        accountKeys: [WALLET, OTHER, newAta],
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [1_997_955_720, 0, 2_039_280],
        innerInstructions: [
          { index: 0, instructions: [systemCreateAccount(WALLET, newAta, 2_039_280)] },
        ],
      }),
    )!;
    expect(decodeNativeSolDelta(parsed, WALLET)).toBe(0n);
  });

  it("does NOT add rent back for an account created AND closed inside the same transaction (design D5)", () => {
    // Create-and-close is exactly what wrapping native SOL does: the rent has
    // already returned to the wallet by the time postBalances is taken, so the
    // wallet only paid the fee. The pre-D5 decoder added the rent a SECOND time
    // and would have reported +2,039,280 here.
    const tempAta = "TempWsolAta111111111111111111111111111111";
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        fee: 5000,
        accountKeys: [WALLET, OTHER, tempAta],
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [1_999_995_000, 0, 0], // rent came back; the account is gone
        instructions: [systemCreateAccount(WALLET, tempAta, 2_039_280)],
      }),
    )!;
    expect(decodeNativeSolDelta(parsed, WALLET)).toBe(0n);
  });

  it("DECLINES when a created account cannot be located in the combined account keys (its survival is unprovable)", () => {
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        fee: 5000,
        preBalances: [2_000_000_000, 0],
        postBalances: [1_997_955_720, 0],
        instructions: [systemCreateAccount(WALLET, "UnknownAccount11111111111111111111111111", 2_039_280)],
      }),
    )!;
    expect(decodeNativeSolDelta(parsed, WALLET)).toBeNull();
  });

  it("ignores rent for an account another payer funded", () => {
    const otherAta = "OtherAta1111111111111111111111111111111111";
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        fee: 5000,
        accountKeys: [WALLET, OTHER, otherAta],
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [1_999_995_000, 0, 2_039_280],
        instructions: [systemCreateAccount(OTHER, otherAta, 2_039_280)],
      }),
    )!;
    expect(decodeNativeSolDelta(parsed, WALLET)).toBe(0n);
  });

  it("DECLINES (never guesses) when a `system` transfer is sourced from the wallet — indistinguishable from a tip", () => {
    const newAta = "NewAta11111111111111111111111111111111111";
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        fee: 5000,
        accountKeys: [WALLET, OTHER, newAta],
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [1_996_955_720, 0, 2_039_280],
        instructions: [
          systemCreateAccount(WALLET, newAta, 2_039_280),
          systemTransfer(WALLET, "TipRecipient111111111111111111111111111111", 1_000_000),
        ],
      }),
    )!;
    expect(decodeNativeSolDelta(parsed, WALLET)).toBeNull();
  });

  it("DECLINES when a `system` transfer carries no readable destination/lamports rather than assuming it moved nothing", () => {
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        instructions: [{ program: "system", parsed: { type: "transfer", info: { source: OTHER, destination: "X" } } }],
      }),
    )!;
    expect(parsed.nativeInstructionEvidence).toBeNull();
    expect(decodeNativeSolDelta(parsed, WALLET)).toBeNull();
  });

  it("DECLINES when a `system` instruction cannot be parsed (unexpected/malformed shape) rather than assuming no value moved", () => {
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        instructions: [{ program: "system", parsed: { type: "transfer", info: { destination: "X", lamports: 100 } } }],
      }),
    )!;
    expect(decodeNativeSolDelta(parsed, WALLET)).toBeNull();
  });
});

describe("decodeMintDelta", () => {
  it("prefers the WSOL token-balance path for SOL_MINT when present", () => {
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        preTokenBalances: [{ owner: WALLET, mint: SOL_MINT, amount: "0" }],
        postTokenBalances: [{ owner: WALLET, mint: SOL_MINT, amount: "1000000000" }],
      }),
    )!;
    expect(decodeMintDelta(parsed, WALLET, SOL_MINT)).toBe(1_000_000_000n);
  });

  it("falls back to native lamports for SOL_MINT when no token-balance entry exists", () => {
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({ fee: 5000, preBalances: [2_000_000_000, 0], postBalances: [999_995_000, 0] }),
    )!;
    expect(decodeMintDelta(parsed, WALLET, SOL_MINT)).toBe(-1_000_000_000n);
  });

  it("uses the token-balance path only for a non-SOL mint", () => {
    const parsed = parseSolanaTransactionResult(fixtureRawTransaction())!;
    expect(decodeMintDelta(parsed, WALLET, USDC_MINT)).toBeNull();
  });

  it("SUMS multiple WSOL token accounts for SOL_MINT rather than matching only the first (WSOL regression)", () => {
    // First WSOL account unchanged; second gains 1 SOL. A `.find()`-based decoder
    // would report 0 (wrong, reads the first account only); summing reports 1e9.
    const parsed = parseSolanaTransactionResult(
      fixtureRawTransaction({
        preTokenBalances: [
          { owner: WALLET, mint: SOL_MINT, amount: "2000000000" },
          { owner: WALLET, mint: SOL_MINT, amount: "0" },
        ],
        postTokenBalances: [
          { owner: WALLET, mint: SOL_MINT, amount: "2000000000" },
          { owner: WALLET, mint: SOL_MINT, amount: "1000000000" },
        ],
      }),
    )!;
    expect(decodeMintDelta(parsed, WALLET, SOL_MINT)).toBe(1_000_000_000n);
  });
});

describe("decodeSolanaBalanceSettlement", () => {
  function swapTx(): ParsedSolanaTransaction {
    return parseSolanaTransactionResult(
      fixtureRawTransaction({
        preTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: "10000000" }],
        postTokenBalances: [
          { owner: WALLET, mint: USDC_MINT, amount: "0" },
          { owner: WALLET, mint: SOL_MINT, amount: "990000000" },
        ],
      }),
    )!;
  }

  it("event_role='swap' decodes BOTH legs when both mints are proven", () => {
    const decoded = decodeSolanaBalanceSettlement({
      parsedTransaction: swapTx(),
      eventRole: "swap",
      walletAddress: WALLET,
      tokenInAddress: USDC_MINT,
      tokenOutAddress: SOL_MINT,
    });
    expect(decoded).toEqual({ executedAmountInRaw: "10000000", executedAmountOutRaw: "990000000" });
  });

  it("event_role='swap' declines the WHOLE result when either leg is undecodable", () => {
    const decoded = decodeSolanaBalanceSettlement({
      parsedTransaction: swapTx(),
      eventRole: "swap",
      walletAddress: WALLET,
      tokenInAddress: USDC_MINT,
      tokenOutAddress: "SomeUntouchedMint1111111111111111111111111",
    });
    expect(decoded).toBeNull();
  });

  it("event_role='swap' declines when a token address is missing entirely", () => {
    const decoded = decodeSolanaBalanceSettlement({
      parsedTransaction: swapTx(),
      eventRole: "swap",
      walletAddress: WALLET,
      tokenInAddress: null,
      tokenOutAddress: SOL_MINT,
    });
    expect(decoded).toBeNull();
  });

  it("lend_deposit proves only the named input mint", () => {
    const tx = parseSolanaTransactionResult(
      fixtureRawTransaction({
        preTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: "5000000" }],
        postTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: "0" }],
      }),
    )!;
    const decoded = decodeSolanaBalanceSettlement({
      parsedTransaction: tx,
      eventRole: "lend_deposit",
      walletAddress: WALLET,
      tokenInAddress: USDC_MINT,
      tokenOutAddress: null,
    });
    expect(decoded).toEqual({ executedAmountInRaw: "5000000" });
  });

  it("predict_claim proves only the named output mint", () => {
    const tx = parseSolanaTransactionResult(
      fixtureRawTransaction({
        preTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: "0" }],
        postTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: "7500000" }],
      }),
    )!;
    const decoded = decodeSolanaBalanceSettlement({
      parsedTransaction: tx,
      eventRole: "predict_claim",
      walletAddress: WALLET,
      tokenInAddress: null,
      tokenOutAddress: USDC_MINT,
    });
    expect(decoded).toEqual({ executedAmountOutRaw: "7500000" });
  });

  it("declines when the row names neither tokenIn nor tokenOut", () => {
    const decoded = decodeSolanaBalanceSettlement({
      parsedTransaction: swapTx(),
      eventRole: "lend_borrow_operate",
      walletAddress: WALLET,
      tokenInAddress: null,
      tokenOutAddress: null,
    });
    expect(decoded).toBeNull();
  });

  it("declines when the named mint was never touched (never guess)", () => {
    const decoded = decodeSolanaBalanceSettlement({
      parsedTransaction: swapTx(),
      eventRole: "lend_withdraw",
      walletAddress: WALLET,
      tokenInAddress: null,
      tokenOutAddress: "SomeUntouchedMint1111111111111111111111111",
    });
    expect(decoded).toBeNull();
  });

  it("event_role='swap' declines the WHOLE result when the native-SOL out-leg carries an undetectable tip transfer", () => {
    const tx = parseSolanaTransactionResult(
      fixtureRawTransaction({
        fee: 5000,
        preTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: "10000000" }],
        postTokenBalances: [{ owner: WALLET, mint: USDC_MINT, amount: "0" }],
        preBalances: [2_000_000_000, 0],
        postBalances: [2_998_995_000, 0],
        instructions: [systemTransfer(WALLET, "TipRecipient111111111111111111111111111111", 1_000_000)],
      }),
    )!;
    const decoded = decodeSolanaBalanceSettlement({
      parsedTransaction: tx,
      eventRole: "swap",
      walletAddress: WALLET,
      tokenInAddress: USDC_MINT,
      tokenOutAddress: SOL_MINT,
    });
    expect(decoded).toBeNull();
  });
});
