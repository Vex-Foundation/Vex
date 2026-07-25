/**
 * `prepareFeeBearingJupiterSwap` + `resolveJupiterFeeSwapKnobs` unit tests
 * (W5 design §6/R4; Codex batch-4 closure blocker C2). Pins: platformFeeBps/
 * feeAccount are NEVER model-controllable; the fee ATA is derived per the
 * mint's REAL owner program (SPL vs Token-2022); the tip cap rejects
 * out-of-range values; the `/build` RESPONSE is validated (request-identity
 * echo, tip/fee-ATA/compute-budget policy) BEFORE any instruction is
 * assembled/signed — a hostile response must never reach `prepared`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

const mockFetchJson = vi.fn();
vi.mock("@utils/http.js", () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

const {
  prepareFeeBearingJupiterSwap,
  resolveJupiterFeeSwapKnobs,
  buildJupiterFeePreview,
} = await import("@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js");
const { JUPITER_SWAP_TIP_DEFAULT_LAMPORTS, JUPITER_TIP_RECEIVER_ADDRESSES } = await import("@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js");
const { VexError, ErrorCodes } = await import("../../../../errors.js");

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TAKER = "GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ";
const TREASURY = "EvA1d9zMBXKFVXjSUFyHphiKUpwHJcLfZfmUH9GCd1sX";
// A REAL published Jupiter tip-receiver address (see constants.ts) — the
// hostile-response guard now checks the tip recipient, not just its amount.
const TIP_RECIPIENT = new PublicKey(JUPITER_TIP_RECEIVER_ADDRESSES[0]);

// ── Realistic wire instructions (real @solana/web3.js encodings, converted
// to the `/build` wire shape) so the new hostile-response guard — which
// decodes these for real — passes for every PRE-EXISTING happy-path test.

function wireIx(ix: TransactionInstruction) {
  return {
    programId: ix.programId.toBase58(),
    accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isWritable: k.isWritable, isSigner: k.isSigner })),
    data: ix.data.toString("base64"),
  };
}

function defaultTipInstruction() {
  return wireIx(SystemProgram.transfer({ fromPubkey: new PublicKey(TAKER), toPubkey: TIP_RECIPIENT, lamports: JUPITER_SWAP_TIP_DEFAULT_LAMPORTS }));
}

/** 200_000 CU x 1_000 microLamports = 200 lamports priority fee — well within the 10M-lamport cap. */
function defaultComputeBudgetInstructions() {
  return [
    wireIx(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })),
    wireIx(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 })),
  ];
}

/** Jupiter's real v6 aggregator program — the id a live `/build` response carries (probed 2026-07-25). It is NOT a Solana builtin, so the default-budget rule credits it 200,000 CU; a placeholder builtin id here would make the priority-fee arithmetic below meaningless. */
const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

function swapInstructionWithFeeAccount(feeAccount: PublicKey) {
  return {
    programId: JUPITER_V6_PROGRAM_ID,
    accounts: [{ pubkey: feeAccount.toBase58(), isWritable: true, isSigner: false }],
    data: "",
  };
}

function fakeBuildResponse(feeAccount: PublicKey, overrides: Record<string, unknown> = {}) {
  return {
    inputMint: USDC_MINT,
    outputMint: SOL_MINT,
    inAmount: "1000000",
    outAmount: "5000000000",
    otherAmountThreshold: "4950000000",
    routePlan: [],
    computeBudgetInstructions: defaultComputeBudgetInstructions(),
    setupInstructions: [],
    swapInstruction: swapInstructionWithFeeAccount(feeAccount),
    cleanupInstruction: null,
    otherInstructions: [],
    tipInstruction: defaultTipInstruction(),
    blockhashWithMetadata: { blockhash: Array(32).fill(1), lastValidBlockHeight: 999 },
    ...overrides,
  };
}

function fakeConnection(opts: { mintOwner: PublicKey; feeAccountExists: boolean }) {
  return {
    getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
      // The mint lookup happens first (resolveMintTokenProgramId), the fee
      // account existence check happens second — distinguish by identity of
      // the queried pubkey rather than call order.
      if (pubkey.toBase58() === USDC_MINT) return { owner: opts.mintOwner };
      return opts.feeAccountExists ? { owner: TOKEN_PROGRAM_ID } : null;
    }),
    getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
  } as unknown as import("@solana/web3.js").Connection;
}

describe("resolveJupiterFeeSwapKnobs", () => {
  it("defaults tip/CU strategy/wrap when omitted", () => {
    const knobs = resolveJupiterFeeSwapKnobs({});
    expect(knobs.tipLamports).toBe(1_000_000);
    expect(knobs.computeUnitPricePercentile).toBe("high");
    expect(knobs.wrapAndUnwrapSol).toBe(true);
    expect(knobs.forJitoBundle).toBe(false);
  });

  it("never carries platformFeeBps/feeAccount even if smuggled into raw params", () => {
    const knobs = resolveJupiterFeeSwapKnobs({ platformFeeBps: 9999, feeAccount: "attacker-address", tipLamports: 5000 });
    expect(knobs.tipLamports).toBe(5000);
    expect(Object.keys(knobs)).not.toContain("platformFeeBps");
    expect(Object.keys(knobs)).not.toContain("feeAccount");
  });

  it("rejects a tipLamports above the owner cap (0.01 SOL) — never silently clamped", () => {
    expect(() => resolveJupiterFeeSwapKnobs({ tipLamports: 10_000_001 })).toThrow(VexError);
    try {
      resolveJupiterFeeSwapKnobs({ tipLamports: 10_000_001 });
    } catch (err) {
      expect((err as InstanceType<typeof VexError>).code).toBe(ErrorCodes.INVALID_AMOUNT);
    }
  });

  it("rejects a negative or non-integer tipLamports", () => {
    expect(() => resolveJupiterFeeSwapKnobs({ tipLamports: -1 })).toThrow(VexError);
    expect(() => resolveJupiterFeeSwapKnobs({ tipLamports: 1.5 })).toThrow(VexError);
  });
});

describe("prepareFeeBearingJupiterSwap", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, JUPITER_API_KEY: "test-jupiter-key" };
  });

  it("always sends the hardcoded platformFeeBps=25 + the derived treasury ATA, never a caller-supplied value", async () => {
    const expectedFeeAccount = getAssociatedTokenAddressSync(
      new PublicKey(USDC_MINT), new PublicKey(TREASURY), false, TOKEN_PROGRAM_ID,
    );
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expectedFeeAccount));
    const connection = fakeConnection({ mintOwner: TOKEN_PROGRAM_ID, feeAccountExists: true });
    // Simulate a knobs object an attacker-controlled call site smuggled extra
    // keys onto (bypassing the type system via a cast, as a compromised
    // caller might attempt at runtime).
    const knobs = resolveJupiterFeeSwapKnobs({});
    (knobs as unknown as Record<string, unknown>).platformFeeBps = 1;
    (knobs as unknown as Record<string, unknown>).feeAccount = "attacker-address";

    await prepareFeeBearingJupiterSwap({
      connection, inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER, knobs, inputDecimals: 6,
    });

    const [url] = mockFetchJson.mock.calls[0] as [string];
    expect(url).toContain("platformFeeBps=25");
    expect(url).toContain(`feeAccount=${expectedFeeAccount.toBase58()}`);
    expect(url).not.toContain("attacker-address");
  });

  it("derives the SPL-program ATA when the mint is owned by the classic Token program", async () => {
    const expected = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(TREASURY), false, TOKEN_PROGRAM_ID);
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expected));
    const connection = fakeConnection({ mintOwner: TOKEN_PROGRAM_ID, feeAccountExists: true });
    const prepared = await prepareFeeBearingJupiterSwap({
      connection, inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
      knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
    });
    expect(prepared.feeAccount).toBe(expected.toBase58());
  });

  it("derives the Token-2022 ATA when the mint is owned by the Token-2022 program", async () => {
    const expected = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(TREASURY), false, TOKEN_2022_PROGRAM_ID);
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expected));
    const connection = fakeConnection({ mintOwner: TOKEN_2022_PROGRAM_ID, feeAccountExists: true });
    const prepared = await prepareFeeBearingJupiterSwap({
      connection, inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
      knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
    });
    expect(prepared.feeAccount).toBe(expected.toBase58());
    expect(prepared.feeAccount).not.toBe(
      getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(TREASURY), false, TOKEN_PROGRAM_ID).toBase58(),
    );
  });

  it("short-circuits mint-owner-program lookup for native SOL input (always the classic Token program / WSOL)", async () => {
    const expected = getAssociatedTokenAddressSync(new PublicKey(SOL_MINT), new PublicKey(TREASURY), false, TOKEN_PROGRAM_ID);
    mockFetchJson.mockResolvedValueOnce(
      fakeBuildResponse(expected, { inputMint: SOL_MINT, outputMint: USDC_MINT, inAmount: "1000000000" }),
    );
    const connection = fakeConnection({ mintOwner: TOKEN_PROGRAM_ID, feeAccountExists: true });
    const prepared = await prepareFeeBearingJupiterSwap({
      connection, inputMint: SOL_MINT, outputMint: USDC_MINT, amountRaw: "1000000000", taker: TAKER,
      knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 9,
    });
    expect(prepared.feeAccount).toBe(expected.toBase58());
    expect(prepared.feeMint).toBe(SOL_MINT);
  });

  it("discloses ATA rent only when the fee account does not yet exist", async () => {
    const expected = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(TREASURY), false, TOKEN_PROGRAM_ID);
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expected));
    const missing = fakeConnection({ mintOwner: TOKEN_PROGRAM_ID, feeAccountExists: false });
    const preparedMissing = await prepareFeeBearingJupiterSwap({
      connection: missing, inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
      knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
    });
    expect(preparedMissing.feeAccountExists).toBe(false);
    expect(preparedMissing.ataRentLamports).toBe(2_039_280);

    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expected));
    const existing = fakeConnection({ mintOwner: TOKEN_PROGRAM_ID, feeAccountExists: true });
    const preparedExisting = await prepareFeeBearingJupiterSwap({
      connection: existing, inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
      knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
    });
    expect(preparedExisting.feeAccountExists).toBe(true);
    expect(preparedExisting.ataRentLamports).toBeNull();
  });

  it("exposes the SAME blockhash evidence baked into the unsigned tx (VERIFY-mode-ready for prepareVersionedTx)", async () => {
    const expected = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(TREASURY), false, TOKEN_PROGRAM_ID);
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expected));
    const connection = fakeConnection({ mintOwner: TOKEN_PROGRAM_ID, feeAccountExists: true });
    const prepared = await prepareFeeBearingJupiterSwap({
      connection, inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
      knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
    });
    expect(prepared.recentBlockhash).toBe(prepared.unsignedTx.message.recentBlockhash);
    expect(prepared.lastValidBlockHeight).toBe(999);
  });

  it("buildJupiterFeePreview discloses the bounded fee-amount/priority-fee-estimate/tip/landing-mode fields (Zod-validated shape)", async () => {
    const expected = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(TREASURY), false, TOKEN_PROGRAM_ID);
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expected));
    const connection = fakeConnection({ mintOwner: TOKEN_PROGRAM_ID, feeAccountExists: true });
    const prepared = await prepareFeeBearingJupiterSwap({
      connection, inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
      knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
    });
    const preview = buildJupiterFeePreview(prepared);
    expect(preview.feeBps).toBe(25);
    expect(preview.otherAmountThresholdRaw).toBe("4950000000");
    expect(preview.landingMode).toBe("self_managed_submit");
    expect(preview.tipLamports).toBe(1_000_000);
    // 25bps of a 1,000,000-raw (6-decimal) inAmount = 2500 raw = 0.0025 exact-decimal.
    expect(preview.feeAmountRaw).toBe("2500");
    expect(preview.feeAmountDecimal).toBe("0.0025");
    // 200_000 CU x 1_000 microLamports / 1e6 = 200 lamports, decoded from the response itself.
    expect(preview.priorityFeeLamportsEstimate).toBe(200);
    // Both a limit and a price instruction are present in this fixture, so
    // the estimate is honest, not a conservative upper bound.
    expect(preview.priorityFeeIsUpperBound).toBe(false);
  });

  it("prices a price-only response (the documented normal /build shape — no explicit compute-unit limit) at the budget SIMD-0170 grants it", async () => {
    const expected = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(TREASURY), false, TOKEN_PROGRAM_ID);
    mockFetchJson.mockResolvedValueOnce(
      fakeBuildResponse(expected, { computeBudgetInstructions: [wireIx(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }))] }),
    );
    const connection = fakeConnection({ mintOwner: TOKEN_PROGRAM_ID, feeAccountExists: true });
    const prepared = await prepareFeeBearingJupiterSwap({
      connection, inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
      knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
    });
    // Signed instruction set: ComputeBudget price (builtin 3,000) + Jupiter
    // swap (200,000) + System tip transfer (builtin 3,000) = 206,000 CU.
    // 206,000 x 1,000 microLamports / 1e6 = 206 lamports. The pre-fix guard
    // substituted Solana's 1,400,000 maximum here and disclosed 1,400 — 6.8x
    // the fee this transaction is actually charged.
    expect(prepared.priorityFeeLamportsEstimate).toBe(206);
    expect(prepared.priorityFeeIsUpperBound).toBe(true);
    const preview = buildJupiterFeePreview(prepared);
    expect(preview.priorityFeeLamportsEstimate).toBe(206);
    expect(preview.priorityFeeIsUpperBound).toBe(true);
  });

  it("counts the spliced treasury fee-ATA create in the priority-fee denominator when that ATA does not exist yet", async () => {
    const expected = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(TREASURY), false, TOKEN_PROGRAM_ID);
    mockFetchJson.mockResolvedValueOnce(
      fakeBuildResponse(expected, { computeBudgetInstructions: [wireIx(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }))] }),
    );
    const connection = fakeConnection({ mintOwner: TOKEN_PROGRAM_ID, feeAccountExists: false });
    const prepared = await prepareFeeBearingJupiterSwap({
      connection, inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
      knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
    });
    // Vex splices an idempotent associated-token-account create (NOT builtin,
    // 200,000 CU) into the same signed transaction, so the granted budget is
    // 206,000 + 200,000 = 406,000. Omitting it would understate the fee — the
    // direction that lets a transaction past the cap.
    expect(prepared.priorityFeeLamportsEstimate).toBe(406);
    expect(prepared.priorityFeeIsUpperBound).toBe(true);
  });
});

// ── Hostile-response validation (Codex batch-4 closure blocker C2) ────────
//
// `/build` is untrusted: each scenario below tampers with ONE aspect of an
// otherwise-valid response and confirms `prepareFeeBearingJupiterSwap` throws
// BEFORE assembling any signable transaction — never resolves, never signs.
describe("prepareFeeBearingJupiterSwap — hostile /build response (never signs a tampered response)", () => {
  const originalEnv = { ...process.env };
  const connection = () => fakeConnection({ mintOwner: TOKEN_PROGRAM_ID, feeAccountExists: true });
  const expectedFeeAccount = () => getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(TREASURY), false, TOKEN_PROGRAM_ID);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, JUPITER_API_KEY: "test-jupiter-key" };
  });

  it("refuses a response with an ALTERED inputMint (identity echo mismatch)", async () => {
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expectedFeeAccount(), { inputMint: "AttackerMint111111111111111111111111111111" }));
    await expect(
      prepareFeeBearingJupiterSwap({
        connection: connection(), inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
        knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
      }),
    ).rejects.toThrow(VexError);
  });

  it("refuses a response with an ALTERED outputMint (identity echo mismatch)", async () => {
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expectedFeeAccount(), { outputMint: "AttackerMint111111111111111111111111111111" }));
    await expect(
      prepareFeeBearingJupiterSwap({
        connection: connection(), inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
        knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
      }),
    ).rejects.toThrow(VexError);
  });

  it("refuses a response with an ALTERED inAmount (economic identity mismatch)", async () => {
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expectedFeeAccount(), { inAmount: "999999999" }));
    await expect(
      prepareFeeBearingJupiterSwap({
        connection: connection(), inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
        knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
      }),
    ).rejects.toThrow(VexError);
  });

  it("refuses an OVERSIZED tip instruction (lamports far above the approved/requested tip)", async () => {
    const oversizedTip = wireIx(SystemProgram.transfer({ fromPubkey: new PublicKey(TAKER), toPubkey: TIP_RECIPIENT, lamports: 50_000_000 }));
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expectedFeeAccount(), { tipInstruction: oversizedTip }));
    await expect(
      prepareFeeBearingJupiterSwap({
        connection: connection(), inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
        knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
      }),
    ).rejects.toThrow(VexError);
  });

  it("refuses a tip instruction REDIRECTED to a non-Jupiter tip-receiver address (correct amount, wrong recipient)", async () => {
    const redirectedTip = wireIx(
      SystemProgram.transfer({ fromPubkey: new PublicKey(TAKER), toPubkey: Keypair.generate().publicKey, lamports: JUPITER_SWAP_TIP_DEFAULT_LAMPORTS }),
    );
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expectedFeeAccount(), { tipInstruction: redirectedTip }));
    await expect(
      prepareFeeBearingJupiterSwap({
        connection: connection(), inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
        knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
      }),
    ).rejects.toThrow(VexError);
  });

  it("refuses a price-only compute-budget response (the documented normal /build shape) whose exposure exceeds the cap", async () => {
    // 206,000 CU (the budget SIMD-0170 grants this 3-instruction transaction,
    // since no limit instruction is present) x 48,543,690 microLamports / 1e6
    // = 10,000,001 lamports — one over the 10,000,000-lamport cap. An extreme
    // price still refuses; only the denominator was recalibrated.
    const priceOnly = [wireIx(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 48_543_690 }))];
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expectedFeeAccount(), { computeBudgetInstructions: priceOnly }));
    await expect(
      prepareFeeBearingJupiterSwap({
        connection: connection(), inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
        knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
      }),
    ).rejects.toThrow(VexError);
  });

  it("refuses a MISSING fee ATA in the swap instruction's accounts", async () => {
    const noFeeAccountSwapIx = { programId: "11111111111111111111111111111111", accounts: [], data: "" };
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expectedFeeAccount(), { swapInstruction: noFeeAccountSwapIx }));
    await expect(
      prepareFeeBearingJupiterSwap({
        connection: connection(), inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
        knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
      }),
    ).rejects.toThrow(VexError);
  });

  it("refuses a WRONG fee ATA (decoy account substituted for the real treasury ATA) in the swap instruction's accounts", async () => {
    const decoy = Keypair.generate().publicKey;
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expectedFeeAccount(), { swapInstruction: swapInstructionWithFeeAccount(decoy) }));
    await expect(
      prepareFeeBearingJupiterSwap({
        connection: connection(), inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
        knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
      }),
    ).rejects.toThrow(VexError);
  });

  it("refuses an EXCESSIVE compute budget (decoded priority-fee estimate exceeds the exposure cap)", async () => {
    const excessive = [
      wireIx(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })),
      wireIx(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 })),
    ];
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expectedFeeAccount(), { computeBudgetInstructions: excessive }));
    await expect(
      prepareFeeBearingJupiterSwap({
        connection: connection(), inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
        knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
      }),
    ).rejects.toThrow(VexError);
  });

  it("refuses a non-ComputeBudget-program instruction disguised inside computeBudgetInstructions", async () => {
    const disguised = wireIx(SystemProgram.transfer({ fromPubkey: new PublicKey(TAKER), toPubkey: TIP_RECIPIENT, lamports: 1 }));
    mockFetchJson.mockResolvedValueOnce(fakeBuildResponse(expectedFeeAccount(), { computeBudgetInstructions: [disguised] }));
    await expect(
      prepareFeeBearingJupiterSwap({
        connection: connection(), inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: "1000000", taker: TAKER,
        knobs: resolveJupiterFeeSwapKnobs({}), inputDecimals: 6,
      }),
    ).rejects.toThrow(VexError);
  });
});
