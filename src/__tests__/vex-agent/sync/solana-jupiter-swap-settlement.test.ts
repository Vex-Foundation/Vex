/**
 * Protocol-aware settlement decoding for a fee-bearing Jupiter swap + the
 * dispatch that selects it (design `solana-settlement-profile-design.md`
 * D2/D4/D5).
 *
 * FIXTURES ARE THE REAL SHAPE, NOT AN IDEALISED ONE. The whole defect exists
 * because a live `/build` swap contains wallet-sourced `system` transfers an
 * idealised fixture lacks. `swapRawTransaction` below reproduces the recorded
 * `/build` response's instruction set verbatim (fixture
 * `agents_dm/agentscan-phase3/fixtures/swap-build-instructions.json`):
 *   setup: ATA createIdempotent (WSOL) → system transfer of the EXACT input
 *          amount into that WSOL ATA → syncNative → ATA createIdempotent
 *          (output mint)
 *   swap:  the aggregator instruction
 *   tip:   system transfer to a published Jupiter tip receiver
 *   clean: closeAccount on the WSOL ATA (rent returns to the wallet)
 * — plus the inner `system createAccount` each ATA creation CPIs into.
 *
 * Pins: both legs decoded exactly, the wrap transfer counted as the INPUT
 * rather than netted away, temporary create+close rent never added back,
 * persistent ATA rent added exactly once, sign discipline instead of an
 * absolute value, and a DECLINE for every unclassified wallet-sourced transfer,
 * mismatched tip, or unreadable instruction set.
 */

import { describe, it, expect } from "vitest";

import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { parseSolanaTransactionResult } from "@vex-agent/sync/solana-settlement-decoders.js";
import { decodeJupiterFeeSwapSettlement } from "@vex-agent/sync/solana-jupiter-swap-settlement.js";
import { decodeSolanaSettlement } from "@vex-agent/sync/solana-settlement-dispatch.js";
import {
  buildSolanaSettlementRouteProvenance,
  jupiterFeeSwapSettlementProfileSchema,
  type JupiterFeeSwapSettlementProfile,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/settlement-profile.js";
import { JUPITER_TIP_RECEIVER_ADDRESSES } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js";
import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";

// A real (on-curve) wallet — ATA derivation rejects an off-curve owner, so a
// synthetic byte string would not exercise the production path.
const WALLET = Keypair.generate().publicKey;
const WALLET_ADDRESS = WALLET.toBase58();
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TIP_RECEIVER = JUPITER_TIP_RECEIVER_ADDRESSES[0]!;
const OUTSIDER = Keypair.generate().publicKey.toBase58();

// Derived through spl-token's own primitive (not Vex's wrapper) so the fixture
// address is independent evidence of what `/build` actually funds.
const WSOL_ATA = getAssociatedTokenAddressSync(new PublicKey(SOL_MINT), WALLET).toBase58();
const USDC_ATA = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), WALLET).toBase58();

const FEE_LAMPORTS = 5_000;
const TIP_LAMPORTS = 1_000_000;
const ATA_RENT = 2_039_280;
const SOL_IN = 10_000_000; // 0.01 SOL
const USDC_OUT = "758696";

interface TokenBalanceFixture {
  readonly owner: string;
  readonly mint: string;
  readonly amount: string;
}

function ataCreateIdempotent(): unknown {
  return { program: "spl-associated-token-account", programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", parsed: { type: "createIdempotent", info: {} } };
}

function systemTransfer(source: string, destination: string, lamports: number): unknown {
  return { program: "system", parsed: { type: "transfer", info: { source, destination, lamports } } };
}

function systemCreateAccount(source: string, newAccount: string, lamports: number): unknown {
  return {
    program: "system",
    parsed: { type: "createAccount", info: { source, newAccount, lamports, space: 165, owner: TOKEN_PROGRAM_ID.toBase58() } },
  };
}

function splTokenNoOp(type: string): unknown {
  return { program: "spl-token", parsed: { type, info: {} } };
}

function rawTransaction(overrides: {
  readonly accountKeys: readonly string[];
  readonly preBalances: readonly number[];
  readonly postBalances: readonly number[];
  readonly preTokenBalances?: readonly TokenBalanceFixture[];
  readonly postTokenBalances?: readonly TokenBalanceFixture[];
  readonly instructions: readonly unknown[];
  readonly innerInstructions?: unknown;
}): unknown {
  const toTokenBalance = (b: TokenBalanceFixture) => ({ owner: b.owner, mint: b.mint, uiTokenAmount: { amount: b.amount } });
  return {
    meta: {
      err: null,
      fee: FEE_LAMPORTS,
      preBalances: overrides.preBalances,
      postBalances: overrides.postBalances,
      preTokenBalances: (overrides.preTokenBalances ?? []).map(toTokenBalance),
      postTokenBalances: (overrides.postTokenBalances ?? []).map(toTokenBalance),
      loadedAddresses: { writable: [], readonly: [] },
      innerInstructions: overrides.innerInstructions,
    },
    transaction: {
      message: {
        accountKeys: overrides.accountKeys.map((k) => ({ pubkey: k, signer: k === WALLET_ADDRESS, writable: true })),
        instructions: overrides.instructions,
      },
    },
  };
}

const WALLET_PRE = 2_000_000_000;

/**
 * SOL → USDC with wrap funding, an allowlisted tip, the network fee, a
 * TEMPORARY WSOL ATA (created + closed) and a PERSISTENT output ATA.
 *
 * Wallet lamports: −fee −tip −input −outputAtaRent (the WSOL ATA's rent is paid
 * and returned inside the same transaction, so it nets to zero).
 */
function solToUsdcRawTransaction(options: {
  readonly extraInstructions?: readonly unknown[];
  readonly tipLamports?: number;
  readonly tipDestination?: string;
  readonly walletPost?: number;
  readonly usdcOut?: string;
  readonly wsolAtaPost?: number;
} = {}): unknown {
  const tipLamports = options.tipLamports ?? TIP_LAMPORTS;
  const tipDestination = options.tipDestination ?? TIP_RECEIVER;
  const walletPost = options.walletPost ?? WALLET_PRE - FEE_LAMPORTS - tipLamports - SOL_IN - ATA_RENT;
  return rawTransaction({
    accountKeys: [WALLET_ADDRESS, WSOL_ATA, USDC_ATA, tipDestination],
    preBalances: [WALLET_PRE, 0, 0, 0],
    postBalances: [walletPost, options.wsolAtaPost ?? 0, ATA_RENT, tipLamports],
    postTokenBalances: [{ owner: WALLET_ADDRESS, mint: USDC_MINT, amount: options.usdcOut ?? USDC_OUT }],
    instructions: [
      ataCreateIdempotent(),
      systemTransfer(WALLET_ADDRESS, WSOL_ATA, SOL_IN),
      splTokenNoOp("syncNative"),
      ataCreateIdempotent(),
      { program: "jupiter", parsed: undefined },
      systemTransfer(WALLET_ADDRESS, tipDestination, tipLamports),
      splTokenNoOp("closeAccount"),
      ...(options.extraInstructions ?? []),
    ],
    innerInstructions: [
      { index: 0, instructions: [systemCreateAccount(WALLET_ADDRESS, WSOL_ATA, ATA_RENT)] },
      { index: 3, instructions: [systemCreateAccount(WALLET_ADDRESS, USDC_ATA, ATA_RENT)] },
    ],
  });
}

function profile(overrides: Partial<JupiterFeeSwapSettlementProfile> = {}): JupiterFeeSwapSettlementProfile {
  return jupiterFeeSwapSettlementProfileSchema.parse({
    v: 1,
    kind: "jupiter_fee_swap_exact_in",
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    inputAmountRaw: String(SOL_IN),
    tipRecipient: TIP_RECEIVER,
    tipLamports: TIP_LAMPORTS,
    wrapAndUnwrapSol: true,
    ...overrides,
  });
}

function decode(raw: unknown, p: JupiterFeeSwapSettlementProfile = profile()) {
  const parsed = parseSolanaTransactionResult(raw);
  expect(parsed).not.toBeNull();
  return decodeJupiterFeeSwapSettlement({ parsedTransaction: parsed!, walletAddress: WALLET_ADDRESS, profile: p });
}

describe("decodeJupiterFeeSwapSettlement — native SOL input (the live defect)", () => {
  it("decodes BOTH legs exactly from the real /build swap shape", () => {
    expect(decode(solToUsdcRawTransaction())).toEqual({
      executedAmountInRaw: String(SOL_IN),
      executedAmountOutRaw: USDC_OUT,
    });
  });

  it("counts the wrap transfer as the INPUT and never nets it away", () => {
    // Netting the wrap back out would leave a zero input; the exact match on
    // the approved amount is what proves it was treated as the debit.
    const decoded = decode(solToUsdcRawTransaction());
    expect(decoded?.executedAmountInRaw).toBe("10000000");
  });

  it("adds the PERSISTENT output-ATA rent back exactly once and never the temporary WSOL rent", () => {
    // Both rents are identical, both funded by the wallet, both created in this
    // transaction. Only the surviving one may be added back — double-counting
    // the closed one is the latent bug D5 closes, and it would shift the
    // decoded input by exactly one rent-exempt minimum.
    expect(decode(solToUsdcRawTransaction())?.executedAmountInRaw).toBe("10000000");

    // Same transaction, but the WSOL account SURVIVES: its rent is then a real
    // cost and the residual no longer equals the approved input — decline.
    expect(decode(solToUsdcRawTransaction({ wsolAtaPost: ATA_RENT }))).toBeNull();
  });

  it("declines when the residual does not equal the approved input amount", () => {
    expect(decode(solToUsdcRawTransaction({ walletPost: WALLET_PRE - FEE_LAMPORTS - TIP_LAMPORTS - SOL_IN - ATA_RENT - 1 }))).toBeNull();
  });

  it("declines a wrong-SIGN native input rather than absolutizing its magnitude", () => {
    // The wallet GAINED lamports where the profile says it spent them.
    const gained = WALLET_PRE - FEE_LAMPORTS - TIP_LAMPORTS + SOL_IN - ATA_RENT;
    expect(decode(solToUsdcRawTransaction({ walletPost: gained }))).toBeNull();
  });

  it("declines a ZERO output leg instead of confirming a swap that produced nothing", () => {
    expect(decode(solToUsdcRawTransaction({ usdcOut: "0" }))).toBeNull();
  });
});

describe("decodeJupiterFeeSwapSettlement — tip classification (design D4.2)", () => {
  it("declines when the persisted recipient is not on Jupiter's published allowlist", () => {
    const raw = solToUsdcRawTransaction({ tipDestination: OUTSIDER });
    expect(decode(raw, profile({ tipRecipient: OUTSIDER }))).toBeNull();
  });

  it("declines when an allowlisted recipient receives an amount other than the persisted approval", () => {
    const raw = solToUsdcRawTransaction({ tipLamports: 2_000_000 });
    expect(decode(raw)).toBeNull(); // profile still says 1,000,000
  });

  it("declines when the profile names a tip the landed transaction never paid", () => {
    const raw = rawTransaction({
      accountKeys: [WALLET_ADDRESS, WSOL_ATA, USDC_ATA],
      preBalances: [WALLET_PRE, 0, 0],
      postBalances: [WALLET_PRE - FEE_LAMPORTS - SOL_IN - ATA_RENT, 0, ATA_RENT],
      postTokenBalances: [{ owner: WALLET_ADDRESS, mint: USDC_MINT, amount: USDC_OUT }],
      instructions: [systemTransfer(WALLET_ADDRESS, WSOL_ATA, SOL_IN)],
      innerInstructions: [
        { index: 0, instructions: [systemCreateAccount(WALLET_ADDRESS, WSOL_ATA, ATA_RENT)] },
        { index: 3, instructions: [systemCreateAccount(WALLET_ADDRESS, USDC_ATA, ATA_RENT)] },
      ],
    });
    expect(decode(raw)).toBeNull();
  });

  it("decodes a legitimately TIPLESS swap when the profile records the absence", () => {
    const raw = rawTransaction({
      accountKeys: [WALLET_ADDRESS, WSOL_ATA, USDC_ATA],
      preBalances: [WALLET_PRE, 0, 0],
      postBalances: [WALLET_PRE - FEE_LAMPORTS - SOL_IN - ATA_RENT, 0, ATA_RENT],
      postTokenBalances: [{ owner: WALLET_ADDRESS, mint: USDC_MINT, amount: USDC_OUT }],
      instructions: [systemTransfer(WALLET_ADDRESS, WSOL_ATA, SOL_IN)],
      innerInstructions: [
        { index: 0, instructions: [systemCreateAccount(WALLET_ADDRESS, WSOL_ATA, ATA_RENT)] },
        { index: 3, instructions: [systemCreateAccount(WALLET_ADDRESS, USDC_ATA, ATA_RENT)] },
      ],
    });
    expect(decode(raw, profile({ tipRecipient: null, tipLamports: 0 }))).toEqual({
      executedAmountInRaw: String(SOL_IN),
      executedAmountOutRaw: USDC_OUT,
    });
  });
});

describe("decodeJupiterFeeSwapSettlement — unexplained movement declines (design D4.6)", () => {
  it("declines on a SECOND unclassified wallet-sourced transfer", () => {
    const raw = solToUsdcRawTransaction({
      extraInstructions: [systemTransfer(WALLET_ADDRESS, OUTSIDER, 250_000)],
      walletPost: WALLET_PRE - FEE_LAMPORTS - TIP_LAMPORTS - SOL_IN - ATA_RENT - 250_000,
    });
    expect(decode(raw)).toBeNull();
  });

  it("declines on a SECOND transfer to the tip receiver (only one tip may be classified)", () => {
    const raw = solToUsdcRawTransaction({
      extraInstructions: [systemTransfer(WALLET_ADDRESS, TIP_RECEIVER, TIP_LAMPORTS)],
      walletPost: WALLET_PRE - FEE_LAMPORTS - 2 * TIP_LAMPORTS - SOL_IN - ATA_RENT,
    });
    expect(decode(raw)).toBeNull();
  });

  it("ignores a transfer the wallet did not source (someone else's payment in the same transaction)", () => {
    const raw = solToUsdcRawTransaction({ extraInstructions: [systemTransfer(OUTSIDER, WSOL_ATA, 1)] });
    expect(decode(raw)?.executedAmountInRaw).toBe("10000000");
  });

  it("declines when the instruction set cannot be read at all (malformed inner instructions)", () => {
    const raw = solToUsdcRawTransaction();
    (raw as { meta: Record<string, unknown> }).meta.innerInstructions = [{ instructions: "not-an-array" }];
    const parsed = parseSolanaTransactionResult(raw);
    expect(parsed?.nativeInstructionEvidence).toBeNull();
    expect(decodeJupiterFeeSwapSettlement({ parsedTransaction: parsed!, walletAddress: WALLET_ADDRESS, profile: profile() })).toBeNull();
  });

  it("declines when the wallet is not present in the transaction's account keys", () => {
    const raw = solToUsdcRawTransaction();
    expect(
      decodeJupiterFeeSwapSettlement({
        parsedTransaction: parseSolanaTransactionResult(raw)!,
        walletAddress: OUTSIDER,
        profile: profile(),
      }),
    ).toBeNull();
  });
});

describe("decodeJupiterFeeSwapSettlement — native SOL output (USDC → SOL, unwrap)", () => {
  const SOL_OUT = 12_000_000;
  const USDC_IN = "10000000";

  function usdcToSolRawTransaction(): unknown {
    // Wallet lamports: −fee −tip +output. The WSOL ATA is created to receive the
    // unwrapped proceeds and closed in cleanup, so its rent nets to zero.
    return rawTransaction({
      accountKeys: [WALLET_ADDRESS, WSOL_ATA, TIP_RECEIVER],
      preBalances: [WALLET_PRE, 0, 0],
      postBalances: [WALLET_PRE - FEE_LAMPORTS - TIP_LAMPORTS + SOL_OUT, 0, TIP_LAMPORTS],
      preTokenBalances: [{ owner: WALLET_ADDRESS, mint: USDC_MINT, amount: USDC_IN }],
      postTokenBalances: [{ owner: WALLET_ADDRESS, mint: USDC_MINT, amount: "0" }],
      instructions: [
        ataCreateIdempotent(),
        { program: "jupiter", parsed: undefined },
        systemTransfer(WALLET_ADDRESS, TIP_RECEIVER, TIP_LAMPORTS),
        splTokenNoOp("closeAccount"),
      ],
      innerInstructions: [{ index: 0, instructions: [systemCreateAccount(WALLET_ADDRESS, WSOL_ATA, ATA_RENT)] }],
    });
  }

  it("decodes the exact output, excluding the network fee, the tip and the temporary WSOL rent", () => {
    const decoded = decode(
      usdcToSolRawTransaction(),
      profile({ inputMint: USDC_MINT, outputMint: SOL_MINT, inputAmountRaw: USDC_IN }),
    );
    expect(decoded).toEqual({ executedAmountInRaw: USDC_IN, executedAmountOutRaw: String(SOL_OUT) });
  });

  it("declines when the SPL input leg moved in the wrong direction", () => {
    const raw = usdcToSolRawTransaction() as { meta: Record<string, unknown> };
    raw.meta.preTokenBalances = [{ owner: WALLET_ADDRESS, mint: USDC_MINT, uiTokenAmount: { amount: "0" } }];
    raw.meta.postTokenBalances = [{ owner: WALLET_ADDRESS, mint: USDC_MINT, uiTokenAmount: { amount: USDC_IN } }];
    expect(decode(raw, profile({ inputMint: USDC_MINT, outputMint: SOL_MINT, inputAmountRaw: USDC_IN }))).toBeNull();
  });
});

describe("decodeSolanaSettlement — dispatch (design D2)", () => {
  const swapRaw = solToUsdcRawTransaction();
  const routeProvenance = buildSolanaSettlementRouteProvenance({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    inputAmountRaw: String(SOL_IN),
    approvedTipLamports: TIP_LAMPORTS,
    certifiedTip: { tipLamports: TIP_LAMPORTS, tipReceiver: TIP_RECEIVER },
    wrapAndUnwrapSol: true,
  })!;

  function dispatch(overrides: Partial<Parameters<typeof decodeSolanaSettlement>[0]> = {}) {
    return decodeSolanaSettlement({
      parsedTransaction: parseSolanaTransactionResult(swapRaw)!,
      eventRole: "swap",
      walletAddress: WALLET_ADDRESS,
      tokenInAddress: SOL_MINT,
      tokenOutAddress: USDC_MINT,
      routeProvenance,
      ...overrides,
    });
  }

  it("routes a profile-bearing swap row to the protocol-aware decoder", () => {
    expect(dispatch()).toEqual({ executedAmountInRaw: String(SOL_IN), executedAmountOutRaw: USDC_OUT });
  });

  it("falls back to the generic decoder when the profile is missing — which declines this transaction, leaving the row pending", () => {
    expect(dispatch({ routeProvenance: null })).toBeNull();
  });

  it("falls back to the generic decoder when the stored profile fails validation", () => {
    expect(dispatch({ routeProvenance: { settlement: { v: 1, kind: "jupiter_fee_swap_exact_in" } } })).toBeNull();
    expect(dispatch({ routeProvenance: { routeID: "kyber-style-provenance" } })).toBeNull();
  });

  it("refuses to use a profile whose mints disagree with the legs THIS row names", () => {
    // The row's executed columns belong to the row's own mints; a profile
    // describing a different pair may never fill them in.
    expect(dispatch({ tokenOutAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" })).toBeNull();
    expect(dispatch({ tokenInAddress: USDC_MINT, tokenOutAddress: SOL_MINT })).toBeNull();
  });

  it("keeps a NON-swap role on the generic path even if a profile is somehow present", () => {
    // A lend row's generic decode proves only the mint it names — the Jupiter
    // decoder (which would demand both legs and a tip) is never consulted.
    const lendRaw = rawTransaction({
      accountKeys: [WALLET_ADDRESS],
      preBalances: [WALLET_PRE],
      postBalances: [WALLET_PRE - FEE_LAMPORTS],
      preTokenBalances: [{ owner: WALLET_ADDRESS, mint: USDC_MINT, amount: "500000" }],
      postTokenBalances: [{ owner: WALLET_ADDRESS, mint: USDC_MINT, amount: "0" }],
      instructions: [],
    });
    expect(
      decodeSolanaSettlement({
        parsedTransaction: parseSolanaTransactionResult(lendRaw)!,
        eventRole: "lend_deposit",
        walletAddress: WALLET_ADDRESS,
        tokenInAddress: USDC_MINT,
        tokenOutAddress: null,
        routeProvenance,
      }),
    ).toEqual({ executedAmountInRaw: "500000" });
  });

  it("never second-guesses a protocol decline by re-running the generic decoder", () => {
    // An SPL→SPL swap the GENERIC decoder decodes happily (it only inspects
    // token balances) but whose persisted tip does not match what landed. Once
    // the profile selected the protocol decoder, its decline is final.
    const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
    const splRaw = rawTransaction({
      accountKeys: [WALLET_ADDRESS, TIP_RECEIVER],
      preBalances: [WALLET_PRE, 0],
      postBalances: [WALLET_PRE - FEE_LAMPORTS - TIP_LAMPORTS, TIP_LAMPORTS],
      preTokenBalances: [{ owner: WALLET_ADDRESS, mint: USDC_MINT, amount: "1000000" }],
      postTokenBalances: [{ owner: WALLET_ADDRESS, mint: USDT_MINT, amount: "999000" }],
      instructions: [systemTransfer(WALLET_ADDRESS, TIP_RECEIVER, TIP_LAMPORTS)],
    });
    const splInput = {
      parsedTransaction: parseSolanaTransactionResult(splRaw)!,
      eventRole: "swap" as const,
      walletAddress: WALLET_ADDRESS,
      tokenInAddress: USDC_MINT,
      tokenOutAddress: USDT_MINT,
    };

    // Baseline: with no profile the generic path proves both legs.
    expect(decodeSolanaSettlement({ ...splInput, routeProvenance: null })).toEqual({
      executedAmountInRaw: "1000000",
      executedAmountOutRaw: "999000",
    });

    const mismatchedTip = buildSolanaSettlementRouteProvenance({
      inputMint: USDC_MINT,
      outputMint: USDT_MINT,
      inputAmountRaw: "1000000",
      approvedTipLamports: 999,
      certifiedTip: { tipLamports: 999, tipReceiver: TIP_RECEIVER },
      wrapAndUnwrapSol: false,
    })!;
    expect(decodeSolanaSettlement({ ...splInput, routeProvenance: mismatchedTip })).toBeNull();
  });
});
