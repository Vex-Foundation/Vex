/**
 * The Vex fee leg's invariants, which are money invariants and not bookkeeping.
 *
 * THE ONE THAT MATTERS MOST: a trade that did not happen is never charged, and a
 * fee that did not happen never touches the trade. The worst case this lane
 * allows is that Vex misses revenue; the case it forbids is that the user pays
 * for nothing.
 *
 * Pinned here:
 *
 *  1. the BUY fee is the exact amount split off the input before the curve;
 *  2. the SELL fee is 25 bps of the PROVEN proceeds decoded from the receipt -
 *     and an UNDECODABLE settlement means NO FEE AT ALL, because Vex will not
 *     charge a percentage of a number nobody observed;
 *  3. a REVERTED fee is recorded with its hash and reported as reverted, never
 *     downgraded to "not attempted" by a bookkeeping failure;
 *  4. an AMBIGUOUS fee is left PENDING and NEVER re-sent - a blind retry of an
 *     unconfirmed transfer could charge the user twice. MetaMask's
 *     PendingTransactionTracker marks such a transaction failed on a not-found
 *     timeout (`PendingTransactionTracker.ts:456-497`); our wallet-reference
 *     audit records that as an explicit REJECTION and this test keeps it
 *     rejected;
 *  5. NOTHING here ever throws - every path returns a report, because the caller
 *     holds a CONFIRMED trade and may not turn it into a failure.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { decodeFunctionData, getAddress, parseAbi, type Hex } from "viem";

import { publicClientDouble, walletClientDouble } from "../../../../_test-evm-clients.js";
import { definedValue } from "../../../../_test-value-guards.js";

/**
 * The fee leg builds its transfer through `buildEvmVexFeeTransfer`, which owns
 * its own minimal ERC-20 ABI. Decoding with a locally declared `transfer` proves
 * the produced bytes rather than round-tripping the builder's own encoder.
 */
const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 value)"]);

const staged = vi.fn();
vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: (...args: unknown[]) => staged(...args),
}));

/**
 * Typed at the shape the reconciler can really return - a row that is already
 * `failed` or already `confirmed`, with or without a hash - so a case can script
 * any of them without asserting past the return type.
 */
const confirmActivityEvent = vi.fn(
  async (): Promise<{ applied: boolean; row: { status: string; txHash: Hex | null } }> => ({
    applied: true,
    row: { status: "confirmed", txHash: null },
  }),
);
const failActivityEvent = vi.fn(async () => undefined);
const markActivityBroadcast = vi.fn(async () => ({ applied: true }));
const markBroadcastAccepted = vi.fn(async () => ({ applied: true }));
const reserveActivityEvmNonce = vi.fn(async () => undefined);
const abortPlannedEvents = vi.fn(async () => undefined);
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  confirmActivityEvent: (...a: unknown[]) => confirmActivityEvent(...(a as [])),
  failActivityEvent: (...a: unknown[]) => failActivityEvent(...(a as [])),
  markActivityBroadcast: (...a: unknown[]) => markActivityBroadcast(...(a as [])),
  markBroadcastAccepted: (...a: unknown[]) => markBroadcastAccepted(...(a as [])),
  reserveActivityEvmNonce: (...a: unknown[]) => reserveActivityEvmNonce(...(a as [])),
  abortPlannedEvents: (...a: unknown[]) => abortPlannedEvents(...(a as [])),
  createAgentActivityPreBroadcastFailure: vi.fn(),
}));

const noteHandlerPendingReason = vi.fn(async () => undefined);
vi.mock("@vex-agent/tools/protocols/runtime/pending-provenance.js", () => ({
  noteHandlerPendingReason: (...a: unknown[]) => noteHandlerPendingReason(...(a as [])),
}));

const { runCurveFeeLeg } = await import(
  "@vex-agent/tools/protocols/virtuals/handlers/trade/fee-leg.js"
);
const { virtualsCurveDeployment, VIRTUALS_CURVE_FEE_BPS, VIRTUALS_CURVE_FEE_RECEIVER_EVM } =
  await import("@tools/virtuals/curve/index.js");
const { VEX_TREASURY_EVM } = await import("../../../../../lib/vex-treasury.js");

/**
 * The REAL product constant, not a stub. Asserting the leg pays the address the
 * treasury module declares is the point: a mock here would let the receiver
 * drift to anything and still pass.
 */
const RECEIVER = VIRTUALS_CURVE_FEE_RECEIVER_EVM;

const DEPLOYMENT = definedValue(virtualsCurveDeployment("base"), "the base curve deployment");
const FEE_ROW_ID = 77;
const EXECUTION_ID = 9;
const TRADE_LEG_COUNT = 2;
const HASH = "0xabc0000000000000000000000000000000000000000000000000000000000001" as Hex;

const FEE_SIGNER = getAddress("0x1111111111111111111111111111111111111111");
const CLIENTS: Parameters<typeof runCurveFeeLeg>[0]["clients"] = {
  publicClient: publicClientDouble({}, DEPLOYMENT.chainId),
  walletClient: walletClientDouble(FEE_SIGNER, {}, DEPLOYMENT.chainId),
};

function call(over: Partial<Parameters<typeof runCurveFeeLeg>[0]> = {}) {
  return runCurveFeeLeg({
    side: "buy",
    deployment: DEPLOYMENT,
    feeRowId: FEE_ROW_ID,
    executionId: EXECUTION_ID,
    tradeLegCount: TRADE_LEG_COUNT,
    buyFeeRaw: 1_250_000_000_000_000n,
    provenProceedsRaw: null,
    clients: CLIENTS,
    priorLeg: undefined,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  staged.mockResolvedValue({ kind: "confirmed", txHash: HASH, receipt: { blockNumber: 1n } });
});

describe("what is transferred", () => {
  it("sends an ERC-20 VIRTUAL transfer to the Vex treasury and no native value", async () => {
    await call();
    const [, , txParams] = definedValue(staged.mock.calls[0], "the signed fee transaction");
    const tx = txParams as { to: string; data: Hex; value: bigint };
    expect(getAddress(tx.to)).toBe(getAddress(DEPLOYMENT.virtual));
    expect(tx.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: TRANSFER_ABI, data: tx.data });
    expect(decoded.functionName).toBe("transfer");
    expect(getAddress(decoded.args[0])).toBe(getAddress(RECEIVER));
    expect(decoded.args[1]).toBe(1_250_000_000_000_000n);
  });

  it("pays the Vex treasury, which is a product constant and never a parameter", () => {
    expect(getAddress(RECEIVER)).toBe(getAddress(VEX_TREASURY_EVM));
  });

  it("reports the receiver on every outcome, including the ones that take nothing", async () => {
    const confirmed = await call();
    const nothing = await call({ buyFeeRaw: 0n });
    expect(getAddress(confirmed.receiver)).toBe(getAddress(RECEIVER));
    expect(getAddress(nothing.receiver)).toBe(getAddress(RECEIVER));
  });
});

describe("the BUY arm charges the exact amount split off the input", () => {
  it("confirms and records the amount it actually moved", async () => {
    const result = await call();
    expect(result.collection).toBe("confirmed");
    expect(result.txHash).toBe(HASH);
    expect(result.feeAmountRaw).toBe("1250000000000000");
    expect(confirmActivityEvent).toHaveBeenCalledWith(FEE_ROW_ID, {
      executedAmountInRaw: "1250000000000000",
      executedAmountInHuman: "0.00125",
    });
  });

  it("takes nothing when the fee floored to zero, and finalizes the unused row", async () => {
    const result = await call({ buyFeeRaw: 0n });
    expect(result.collection).toBe("not_charged");
    expect(result.collectionNote).toContain("rounds to zero");
    expect(staged).not.toHaveBeenCalled();
    expect(abortPlannedEvents).toHaveBeenCalledWith(EXECUTION_ID, TRADE_LEG_COUNT, expect.any(String));
  });
});

describe("the SELL arm charges only what the receipt proved", () => {
  const PROCEEDS = 2_000_000_000_000_000_000n;

  it("takes 25 bps of the PROVEN proceeds, not of a quoted gross", async () => {
    const result = await call({ side: "sell", buyFeeRaw: null, provenProceedsRaw: PROCEEDS });
    const expected = (PROCEEDS * BigInt(VIRTUALS_CURVE_FEE_BPS)) / 10_000n;
    expect(result.feeAmountRaw).toBe(expected.toString());
    const tx = definedValue(staged.mock.calls[0], "the signed fee transaction")[2] as { data: Hex };
    expect(decodeFunctionData({ abi: TRANSFER_ABI, data: tx.data }).args[1]).toBe(expected);
  });

  it("takes NO FEE AT ALL when the settlement could not be decoded", async () => {
    const result = await call({ side: "sell", buyFeeRaw: null, provenProceedsRaw: null });
    expect(result.collection).toBe("not_charged");
    expect(result.collectionNote).toContain("could not be decoded");
    expect(result.collectionNote).toContain("never charges a percentage of an amount nobody observed");
    expect(staged).not.toHaveBeenCalled();
    expect(result.feeAmountRaw).toBeNull();
  });

  it("ignores the buy amount entirely on a sell", async () => {
    // A sell that read `buyFeeRaw` would charge a fee on the input token's size.
    const result = await call({ side: "sell", buyFeeRaw: 9_999_999n, provenProceedsRaw: null });
    expect(result.collection).toBe("not_charged");
    expect(staged).not.toHaveBeenCalled();
  });
});

describe("a fee that fails leaves the trade alone", () => {
  it("never throws, whatever the broadcast does", async () => {
    staged.mockRejectedValue(new Error("gas estimate refused"));
    await expect(call()).resolves.toMatchObject({ collection: "not_attempted", txHash: null });
  });

  it("reports a REVERTED fee with its hash and records the revert", async () => {
    staged.mockResolvedValue({ kind: "reverted", txHash: HASH, receipt: {} });
    const result = await call();
    expect(result.collection).toBe("reverted");
    expect(result.txHash).toBe(HASH);
    expect(result.collectionNote).toContain("your trade is unaffected");
    expect(failActivityEvent).toHaveBeenCalledWith(FEE_ROW_ID, expect.objectContaining({ failureCode: "mined_revert" }));
  });

  it("keeps a receipt-proven revert even when the audit write fails", async () => {
    // Bookkeeping may not rewrite what the chain said: the hash and the outcome
    // survive a repository failure.
    staged.mockResolvedValue({ kind: "reverted", txHash: HASH, receipt: {} });
    failActivityEvent.mockRejectedValueOnce(new Error("db down"));
    const result = await call();
    expect(result.collection).toBe("reverted");
    expect(result.txHash).toBe(HASH);
  });

  it("leaves an AMBIGUOUS fee pending with its hash and NEVER re-sends it", async () => {
    staged.mockResolvedValue({ kind: "ambiguous", txHash: HASH, stage: "confirm" });
    const result = await call();
    expect(result.collection).toBe("unconfirmed");
    expect(result.txHash).toBe(HASH);
    expect(result.collectionNote).toContain("never");
    expect(result.collectionNote).toContain("re-sent");
    // Its OWN pending reason: a fee that did not confirm says nothing about the
    // trade, and the row must not inherit the trade's reason.
    expect(noteHandlerPendingReason).toHaveBeenCalledWith("virtuals.fee", FEE_ROW_ID, "fee_broadcast_ambiguous");
    expect(staged).toHaveBeenCalledTimes(1);
    expect(failActivityEvent).not.toHaveBeenCalled();
  });

  it("refuses to broadcast an UNTRACKED transfer when the staging CAS misses", async () => {
    markActivityBroadcast.mockResolvedValueOnce({ applied: false });
    staged.mockImplementation(async (_pc, _signer, _tx, hooks: { onHashStaged: (h: unknown) => Promise<void> }) => {
      await hooks.onHashStaged({ txHash: HASH });
      return { kind: "confirmed", txHash: HASH, receipt: { blockNumber: 1n } };
    });
    const result = await call();
    expect(result.collection).toBe("not_attempted");
    expect(result.feeAmountRaw).toBeNull();
  });

  it("does not report a clean confirm when the reconciler already finalized the row", async () => {
    confirmActivityEvent.mockResolvedValueOnce({ applied: false, row: { status: "failed", txHash: null } });
    const result = await call();
    expect(result.collection).toBe("confirmed_unrecorded");
    expect(result.txHash).toBe(HASH);
  });

  it("treats an already-confirmed row with the SAME hash as confirmed, not as a miss", async () => {
    confirmActivityEvent.mockResolvedValueOnce({ applied: false, row: { status: "confirmed", txHash: HASH } });
    await expect(call()).resolves.toMatchObject({ collection: "confirmed" });
  });
});

describe("a fee with no row is not signed", () => {
  it("reports not_attempted rather than moving money with no audit row", async () => {
    const result = await call({ feeRowId: null });
    expect(result.collection).toBe("not_attempted");
    expect(result.collectionNote).toContain("no recorded row");
    expect(staged).not.toHaveBeenCalled();
  });

  it("distinguishes that from 'no fee applies', which needs no row at all", async () => {
    const noRow = await call({ feeRowId: null });
    const noFee = await call({ buyFeeRaw: 0n });
    expect(noRow.collection).toBe("not_attempted");
    expect(noFee.collection).toBe("not_charged");
    expect(noRow.collection).not.toBe(noFee.collection);
  });
});
