/**
 * THE SOLANA ARM of the amount-correction fallback: a confirmed Solana row whose
 * amounts were never established, repaired from its finalized transaction body.
 *
 * The rows this exists for are real and still on the owner's machine: a Khalani
 * `bridge_deposit` on Solana (which is VOLUME on the server) and Jupiter
 * lend/prediction legs confirmed status-only before the decoders existed.
 *
 * What is pinned here:
 *
 * 1. **No EVM RPC method is ever issued for a Solana row** - the receipt port is
 *    never touched, and the split happens before any EVM read.
 * 2. **A deposit is bounded INPUT-ONLY**, from the mint the row itself declared:
 *    its counter-leg lands on another chain, in another transaction.
 * 3. **Wrong owner, wrong mint, wrong direction and an ambiguous delta all
 *    DECLINE by name** and are stamped, so they stop being re-read.
 * 4. **A body that could not be read is a DEFERRAL**, not a decline, and still
 *    rotates the candidate window.
 * 5. **The per-pass body budget is bounded**, and rows past it wait rather than
 *    being decided without evidence.
 *
 * The bodies are the VERBATIM mainnet captures in `fixtures/jupiter-settlement/`;
 * what makes a case a deposit, a lend leg or a swap is the ROW, since every
 * decode is bounded by owner and mint.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

const mockListCandidates = vi.fn();
const mockFill = vi.fn();
const mockDeclined = vi.fn();
const mockNoteVersion = vi.fn();
const mockTouchChecked = vi.fn();
const mockNoteSettledBlockTime = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listAmountCorrectionCandidates: (...a: unknown[]) => mockListCandidates(...a),
    fillExecutedAmountsOnConfirmed: (...a: unknown[]) => mockFill(...a),
    noteSettlementDeclined: (...a: unknown[]) => mockDeclined(...a),
    noteSettlementDecodeVersion: (...a: unknown[]) => mockNoteVersion(...a),
    touchAmountCorrectionChecked: (...a: unknown[]) => mockTouchChecked(...a),
    noteSettledBlockTime: (...a: unknown[]) => mockNoteSettledBlockTime(...a),
  };
});

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { repairMissingExecutedAmounts, SETTLEMENT_DECODER_SET_VERSION } = await import(
  "@vex-agent/sync/executed-amount-fallback.js"
);
const { SOLANA_AMOUNT_REPAIR_BODY_FETCH_LIMIT } = await import(
  "@vex-agent/sync/executed-amount-fallback/solana-lane.js"
);

const WALLET = "AeyBYFtgm85BrsZMKrAWdc2qGQqYvwfkt88dZdfYEndS";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP_USD = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";
const SOLANA_CHAIN_ID = 20011000000;
const SIGNATURE = "3ewjUYAGSignatureBase58aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function body(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/jupiter-settlement/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

const usdcSpent = body("swap-usdc-to-sol-3ewjUYAG");
const multiHop = body("swap-jupusd-to-usdc-3g3NAiBJ");

function solanaRow(over: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: 11,
    eventRole: "bridge_deposit",
    kind: "bridge",
    protocol: "khalani",
    chainId: SOLANA_CHAIN_ID,
    chainFamily: "solana",
    status: "confirmed",
    txHash: SIGNATURE,
    walletAddress: WALLET,
    tokenInAddress: USDC,
    tokenOutAddress: null,
    executedAmountInRaw: null,
    executedAmountOutRaw: null,
    tokenIn2Address: null,
    tokenOut2Address: null,
    executedAmountIn2Raw: null,
    executedAmountOut2Raw: null,
    routeProvenance: null,
    ...over,
  } as AgentActivityEvent;
}

function deps(bodyLookup: unknown) {
  return {
    // Present so the shape matches production; a Solana row must never reach them.
    fetchReceiptLogs: vi.fn().mockResolvedValue([]),
    fetchTransaction: vi.fn().mockResolvedValue(null),
    fetchReceiptStatus: vi.fn().mockResolvedValue("success"),
    solanaBodyPort: { getFinalizedTransaction: vi.fn().mockResolvedValue(bodyLookup) },
  };
}

const found = (value: unknown) => ({ outcome: "found" as const, value });

beforeEach(() => {
  vi.clearAllMocks();
  mockFill.mockResolvedValue({ outcome: "applied", row: solanaRow() });
  mockDeclined.mockResolvedValue({ applied: true });
  mockTouchChecked.mockResolvedValue(undefined);
  mockNoteSettledBlockTime.mockResolvedValue(true);
});

describe("the Solana arm - proven repairs", () => {
  it("fills a bridge_deposit INPUT-ONLY, from the mint the row declared", async () => {
    mockListCandidates.mockResolvedValue([solanaRow()]);
    const port = deps(found(usdcSpent));

    const result = await repairMissingExecutedAmounts(port);

    expect(mockFill).toHaveBeenCalledWith({
      id: 11,
      expectedTxHash: SIGNATURE,
      expectedChainId: SOLANA_CHAIN_ID,
      amounts: { executedAmountInRaw: "3000000", executedAmountInHuman: "3" },
    });
    // The settling block's time rides the same body.
    expect(mockNoteSettledBlockTime).toHaveBeenCalledWith(11, new Date(1784953206 * 1000).toISOString());
    expect(result).toMatchObject({ checked: 1, filled: 1, declined: 0, deferred: 0 });
  });

  it("never issues an EVM RPC method for a Solana row", async () => {
    mockListCandidates.mockResolvedValue([solanaRow()]);
    const port = deps(found(usdcSpent));

    await repairMissingExecutedAmounts(port);

    expect(port.fetchReceiptLogs).not.toHaveBeenCalled();
    expect(port.fetchTransaction).not.toHaveBeenCalled();
    expect(port.fetchReceiptStatus).not.toHaveBeenCalled();
  });

  it("repairs a lend or prediction leg from its declared mints", async () => {
    mockListCandidates.mockResolvedValue([
      solanaRow({
        eventRole: "lend_withdraw",
        kind: "lend",
        protocol: "jupiter",
        tokenInAddress: JUP_USD,
        tokenOutAddress: USDC,
      }),
    ]);

    await repairMissingExecutedAmounts(deps(found(multiHop)));

    expect(mockFill).toHaveBeenCalledWith(
      expect.objectContaining({
        amounts: {
          executedAmountInRaw: "4584000",
          executedAmountInHuman: "4.584",
          executedAmountOutRaw: "4572791",
          executedAmountOutHuman: "4.572791",
        },
      }),
    );
  });

  it("repairs a swap through its persisted settlement profile", async () => {
    mockListCandidates.mockResolvedValue([
      solanaRow({
        eventRole: "swap",
        kind: "swap",
        protocol: "jupiter",
        tokenInAddress: JUP_USD,
        tokenOutAddress: USDC,
        routeProvenance: {
          settlement: {
            v: 1,
            kind: "jupiter_fee_swap_exact_in",
            inputMint: JUP_USD,
            outputMint: USDC,
            inputAmountRaw: "4584000",
            tipRecipient: null,
            tipLamports: 0,
            wrapAndUnwrapSol: false,
          },
        },
      }),
    ]);

    await repairMissingExecutedAmounts(deps(found(multiHop)));

    expect(mockFill).toHaveBeenCalledWith(
      expect.objectContaining({
        amounts: expect.objectContaining({ executedAmountInRaw: "4584000", executedAmountOutRaw: "4572791" }),
      }),
    );
  });
});

describe("the Solana arm - refusals", () => {
  it.each([
    ["a wallet that owns nothing in this transaction", { walletAddress: "SomeoneElse111111111111111111111111111111" }],
    ["a mint this wallet never moved", { tokenInAddress: "MintNobodyMovedHere111111111111111111111111" }],
    ["a deposit whose declared mint was GAINED, not spent", { tokenInAddress: USDC }],
  ])("declines %s, and stamps it so the row stops being re-read", async (_label, over) => {
    // The third case uses the multi-hop body, where USDC was credited: a deposit
    // that gained its declared input is not a deposit we can read.
    mockListCandidates.mockResolvedValue([solanaRow(over)]);

    const result = await repairMissingExecutedAmounts(deps(found(multiHop)));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(11, "amounts_undecodable");
    expect(mockNoteVersion).toHaveBeenCalledWith(11, SETTLEMENT_DECODER_SET_VERSION);
    expect(result).toMatchObject({ declined: 1, filled: 0 });
  });

  it("declines an ambiguous delta - two of our accounts moved the mint", async () => {
    const balance = (accountIndex: number, amount: string): unknown => ({
      accountIndex,
      mint: USDC,
      owner: WALLET,
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: amount },
    });
    mockListCandidates.mockResolvedValue([solanaRow()]);

    const result = await repairMissingExecutedAmounts(
      deps(
        found({
          meta: {
            err: null,
            preTokenBalances: [balance(1, "5000"), balance(2, "9000")],
            postTokenBalances: [balance(1, "1000"), balance(2, "4000")],
          },
        }),
      ),
    );

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(11, "amounts_undecodable");
    expect(result).toMatchObject({ declined: 1 });
  });

  it("declines a row no mint can bound, without spending a body fetch", async () => {
    mockListCandidates.mockResolvedValue([solanaRow({ tokenInAddress: null })]);
    const port = deps(found(usdcSpent));

    await repairMissingExecutedAmounts(port);

    expect(port.solanaBodyPort.getFinalizedTransaction).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(11, "amounts_undecodable");
  });

  it("declines a signature a trusted RPC no longer has - re-asking cannot change that", async () => {
    mockListCandidates.mockResolvedValue([solanaRow()]);

    const result = await repairMissingExecutedAmounts(deps({ outcome: "not_found" as const }));

    expect(mockDeclined).toHaveBeenCalledWith(11, "amounts_undecodable");
    expect(result).toMatchObject({ declined: 1 });
  });
});

describe("the Solana arm - deferrals rotate rather than conclude", () => {
  it("defers an unreadable body and touches the ordering key", async () => {
    mockListCandidates.mockResolvedValue([solanaRow()]);

    const result = await repairMissingExecutedAmounts(deps({ outcome: "unavailable" as const }));

    expect(mockDeclined).not.toHaveBeenCalled();
    expect(mockNoteVersion).not.toHaveBeenCalled();
    expect(mockTouchChecked).toHaveBeenCalledWith(11);
    expect(result).toMatchObject({ deferred: 1, declined: 0, filled: 0 });
  });

  it("bounds body fetches per pass, and rotates every row past the budget", async () => {
    const rows = Array.from({ length: SOLANA_AMOUNT_REPAIR_BODY_FETCH_LIMIT + 2 }, (_unused, index) =>
      solanaRow({ id: index + 1 }),
    );
    mockListCandidates.mockResolvedValue(rows);
    const port = deps(found(usdcSpent));

    const result = await repairMissingExecutedAmounts(port, rows.length);

    expect(port.solanaBodyPort.getFinalizedTransaction).toHaveBeenCalledTimes(
      SOLANA_AMOUNT_REPAIR_BODY_FETCH_LIMIT,
    );
    expect(result).toMatchObject({ filled: SOLANA_AMOUNT_REPAIR_BODY_FETCH_LIMIT, deferred: 2 });
    expect(mockTouchChecked).toHaveBeenCalledTimes(2);
  });

  it("surfaces a conflict instead of merging it", async () => {
    mockFill.mockResolvedValue({ outcome: "conflict", row: solanaRow() });
    mockListCandidates.mockResolvedValue([solanaRow()]);

    const result = await repairMissingExecutedAmounts(deps(found(usdcSpent)));

    expect(mockDeclined).not.toHaveBeenCalled();
    expect(result).toMatchObject({ conflicted: 1, filled: 0 });
  });
});
