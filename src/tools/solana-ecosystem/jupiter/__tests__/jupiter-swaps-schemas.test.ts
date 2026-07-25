/**
 * codex-002 financial gates for the Jupiter Swap V2 response schemas.
 *
 * These responses feed transaction signing, so the schema must accept valid
 * shapes (incl. forward-compatible extra fields) and reject malformed ones:
 * missing requestId, a non-base64 transaction blob, an empty success
 * signature, or an instruction with a bad pubkey / non-base64 data.
 */

import { describe, expect, it } from "vitest";
import {
  jupiterSwapBuildResponseSchema,
  jupiterSwapExecuteResponseSchema,
  jupiterSwapOrderResponseSchema,
  jupiterSwapSubmitResponseSchema,
} from "../jupiter-swaps/schemas.js";

const PUBKEY = "So11111111111111111111111111111111111111112";
const B64 = "AQIDBA=="; // base64 of [1,2,3,4]

function validOrder(): Record<string, unknown> {
  return {
    mode: "manual",
    inputMint: PUBKEY,
    outputMint: PUBKEY,
    inAmount: "1000",
    outAmount: "990",
    otherAmountThreshold: "980",
    routePlan: [],
    transaction: B64,
    requestId: "req-123",
  };
}

describe("jupiterSwapOrderResponseSchema", () => {
  it("accepts a valid order, including unknown forward-compat fields", () => {
    const r = jupiterSwapOrderResponseSchema.safeParse({
      ...validOrder(),
      someFutureField: { x: 1 },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.requestId).toBe("req-123");
  });

  it("accepts platformFee without `amount` (live /order omits it) and coerces numeric amount", () => {
    // Live api.jup.ag/swap/v2/order returns platformFee = { feeBps, feeMint } with NO amount.
    const noAmount = jupiterSwapOrderResponseSchema.safeParse({
      ...validOrder(),
      platformFee: { feeBps: 2, feeMint: PUBKEY },
    });
    expect(noAmount.success).toBe(true);
    if (noAmount.success) expect(noAmount.data.platformFee?.amount).toBeUndefined();

    // On routes that do carry it, a numeric amount must coerce to string.
    const numeric = jupiterSwapOrderResponseSchema.safeParse({
      ...validOrder(),
      platformFee: { amount: 3000, feeBps: 2, feeMint: PUBKEY },
    });
    expect(numeric.success).toBe(true);
    if (numeric.success) expect(numeric.data.platformFee?.amount).toBe("3000");
  });

  it("accepts transaction:null (RFQ path, no tx yet)", () => {
    expect(
      jupiterSwapOrderResponseSchema.safeParse({ ...validOrder(), transaction: null })
        .success,
    ).toBe(true);
  });

  it("rejects a missing requestId", () => {
    const { requestId: _omit, ...rest } = validOrder();
    expect(jupiterSwapOrderResponseSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a non-base64 transaction blob", () => {
    expect(
      jupiterSwapOrderResponseSchema.safeParse({ ...validOrder(), transaction: "!!not b64!!" })
        .success,
    ).toBe(false);
  });

  it("rejects a base64 string of impossible length", () => {
    // length 1 is not a valid base64 encoding
    expect(
      jupiterSwapOrderResponseSchema.safeParse({ ...validOrder(), transaction: "A" }).success,
    ).toBe(false);
  });

  it("accepts transaction:\"\" on Jupiter's 200-level error path (errorCode present)", () => {
    // The service maps {errorCode, transaction:""} to SOLANA_QUOTE_FAILED — the
    // schema must not pre-empt that with HTTP_RESPONSE_INVALID.
    expect(
      jupiterSwapOrderResponseSchema.safeParse({
        ...validOrder(),
        transaction: "",
        errorCode: 1001,
        errorMessage: "no route",
      }).success,
    ).toBe(true);
  });

  it("rejects transaction:\"\" when no error field is present", () => {
    expect(
      jupiterSwapOrderResponseSchema.safeParse({ ...validOrder(), transaction: "" }).success,
    ).toBe(false);
  });

  it("rejects an empty inAmount", () => {
    expect(
      jupiterSwapOrderResponseSchema.safeParse({ ...validOrder(), inAmount: "" }).success,
    ).toBe(false);
  });
});

describe("jupiterSwapExecuteResponseSchema", () => {
  const base = {
    code: 0,
    inputAmountResult: "1000",
    outputAmountResult: "990",
  };

  it("accepts Success with a signature", () => {
    expect(
      jupiterSwapExecuteResponseSchema.safeParse({ ...base, status: "Success", signature: "sig" })
        .success,
    ).toBe(true);
  });

  it("rejects Success with an empty signature", () => {
    expect(
      jupiterSwapExecuteResponseSchema.safeParse({ ...base, status: "Success", signature: "" })
        .success,
    ).toBe(false);
  });

  it("accepts Failed with an empty signature", () => {
    expect(
      jupiterSwapExecuteResponseSchema.safeParse({ ...base, status: "Failed", signature: "" })
        .success,
    ).toBe(true);
  });
});

describe("jupiterSwapBuildResponseSchema", () => {
  const instruction = {
    programId: PUBKEY,
    accounts: [{ pubkey: PUBKEY, isWritable: true, isSigner: false }],
    data: B64,
  };

  function validBuild(): Record<string, unknown> {
    return {
      inputMint: PUBKEY,
      outputMint: PUBKEY,
      inAmount: "1000",
      outAmount: "990",
      otherAmountThreshold: "980",
      routePlan: [],
      computeBudgetInstructions: [],
      setupInstructions: [],
      swapInstruction: instruction,
      cleanupInstruction: null,
      otherInstructions: [],
    };
  }

  it("accepts a valid build response", () => {
    expect(jupiterSwapBuildResponseSchema.safeParse(validBuild()).success).toBe(true);
  });

  it("rejects an instruction with non-base64 data", () => {
    expect(
      jupiterSwapBuildResponseSchema.safeParse({
        ...validBuild(),
        swapInstruction: { ...instruction, data: "@@@" },
      }).success,
    ).toBe(false);
  });

  it("rejects an instruction account with a bad pubkey", () => {
    expect(
      jupiterSwapBuildResponseSchema.safeParse({
        ...validBuild(),
        swapInstruction: {
          ...instruction,
          accounts: [{ pubkey: "0", isWritable: true, isSigner: false }],
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a build response without tipInstruction at all (back-compat with responses recorded before this field)", () => {
    expect(jupiterSwapBuildResponseSchema.safeParse(validBuild()).success).toBe(true);
  });

  it("accepts a null tipInstruction (no tipAmount requested)", () => {
    expect(
      jupiterSwapBuildResponseSchema.safeParse({ ...validBuild(), tipInstruction: null }).success,
    ).toBe(true);
  });

  it("accepts a populated tipInstruction (tipAmount requested)", () => {
    expect(
      jupiterSwapBuildResponseSchema.safeParse({ ...validBuild(), tipInstruction: instruction })
        .success,
    ).toBe(true);
  });

  it("rejects a tipInstruction with non-base64 data", () => {
    expect(
      jupiterSwapBuildResponseSchema.safeParse({
        ...validBuild(),
        tipInstruction: { ...instruction, data: "@@@" },
      }).success,
    ).toBe(false);
  });

  // Transcribed (not read at runtime) from the live-recorded 2026-07-23
  // GET /build response for a 0.01 SOL -> USDC quote, keyless, taker=the
  // all-ones System Program placeholder pubkey (no real wallet). Source:
  // agents_dm/agentscan-phase3/fixtures/swap-build-instructions.json (that
  // path is gitignored, so committed tests transcribe the real values here
  // instead of reading it). Lookup-table address list trimmed to 3 of the
  // ~230 real entries; array length is not schema-relevant.
  it("accepts the live-recorded 2026-07-23 SOL->USDC /build response", () => {
    const liveBuildResponse = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: "10000000",
      outAmount: "758696",
      otherAmountThreshold: "754903",
      swapMode: "ExactIn",
      slippageBps: 50,
      // Live 2026-07-23 fixture carries this even on /build, though the docs'
      // /build reference page does not list it (see DOCS-GAP in schemas.ts).
      priceImpactPct: "0",
      routePlan: [
        {
          percent: 100,
          bps: 10000,
          swapInfo: {
            ammKey: "GMCJvYGf5Ex2ARiMquaBDqU6iKM8uiEQkB8jCnoNfHpC",
            label: "GoonFi V2",
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            inAmount: "10000000",
            outAmount: "758696",
          },
        },
      ],
      computeBudgetInstructions: [
        { programId: "ComputeBudget111111111111111111111111111111", accounts: [], data: "A9RmAQAAAAAA" },
      ],
      setupInstructions: [
        {
          programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
          accounts: [
            { pubkey: "11111111111111111111111111111111", isSigner: true, isWritable: true },
            { pubkey: "aqxoAhCwpy3oB1BpNw9hL1HdLYLgPpbPjzxDrrQj3Fs", isSigner: false, isWritable: true },
          ],
          data: "AQ==",
        },
      ],
      swapInstruction: {
        programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        accounts: [
          { pubkey: "11111111111111111111111111111111", isSigner: true, isWritable: false },
          { pubkey: "aqxoAhCwpy3oB1BpNw9hL1HdLYLgPpbPjzxDrrQj3Fs", isSigner: false, isWritable: true },
        ],
        data: "u2T6zDHErxSAlpgAAAAAAKiTCwAAAAAAMgAAAAAAAQAAAJcAECcAAQ==",
      },
      cleanupInstruction: {
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        accounts: [
          { pubkey: "aqxoAhCwpy3oB1BpNw9hL1HdLYLgPpbPjzxDrrQj3Fs", isSigner: false, isWritable: true },
          { pubkey: "11111111111111111111111111111111", isSigner: false, isWritable: true },
          { pubkey: "11111111111111111111111111111111", isSigner: true, isWritable: false },
        ],
        data: "CQ==",
      },
      otherInstructions: [],
      tipInstruction: null,
      addressesByLookupTableAddress: {
        DBmHWCVEGCzZ3zDNr9WzRaMmSqCjcixMh78imXfno9qJ: [
          "EwfLtdve4ojEg8CD1Ezq4qQTxxq5uSZg5ptdPbQE6Czf",
          "8HVcoWfV9kbEyDKker9DhDuw6pstx945nPu5pnzE8xcW",
          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        ],
      },
      blockhashWithMetadata: {
        blockhash: [160, 87, 105, 234, 84, 202, 174, 253, 10, 44, 193, 123, 16, 117, 210, 202],
        lastValidBlockHeight: 412821718,
      },
    };

    const result = jupiterSwapBuildResponseSchema.safeParse(liveBuildResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tipInstruction).toBeNull();
      expect(result.data.priceImpactPct).toBe("0");
      expect(result.data.routePlan[0]?.swapInfo.label).toBe("GoonFi V2");
      expect(result.data.blockhashWithMetadata?.lastValidBlockHeight).toBe(412821718);
    }
  });
});

describe("jupiterSwapSubmitResponseSchema", () => {
  it("accepts a valid submit response", () => {
    expect(jupiterSwapSubmitResponseSchema.safeParse({ signature: "sig-abc" }).success).toBe(true);
  });

  it("accepts unknown forward-compat fields", () => {
    expect(
      jupiterSwapSubmitResponseSchema.safeParse({ signature: "sig-abc", slot: 123 }).success,
    ).toBe(true);
  });

  it("rejects a missing signature", () => {
    expect(jupiterSwapSubmitResponseSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(jupiterSwapSubmitResponseSchema.safeParse({ signature: "" }).success).toBe(false);
  });
});
