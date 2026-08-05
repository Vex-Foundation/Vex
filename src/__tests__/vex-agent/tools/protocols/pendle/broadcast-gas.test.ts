/**
 * Every Pendle Router broadcast must be signed with the SHARED gas headroom,
 * never with a bare `eth_estimateGas` result (G-40 / P0-5, D2).
 *
 * DEFECT: all nine `sendTransaction` sites passed no `gas`, so viem filled
 * `request.gas` with the node's bare estimate
 * (`prepareTransactionRequest.js:331-332`) — 0% headroom. That is exactly what
 * burned funds on 2026-07-24: four Base swaps mined-REVERTED having consumed
 * ~97.3% of a bare-estimate limit, and the same calldata's estimate moved 2.07x
 * across twelve consecutive blocks. Pendle routes carry ~2.6 KB of aggregator
 * `extCalldata`, precisely the shape with that spread, and the Convert response
 * carries NO gas field of its own (live-verified: the tx object is only
 * `{data, to, from, value}`), so the bound has to be ours.
 *
 * CARD B1 moved the mechanics into the shared `signStageBroadcast` primitive so
 * the staged-evidence write protocol and the gas bound live on one path. That
 * makes THIS suite's job narrower and more important, not obsolete: it pins that
 * Pendle still ends up SIGNING a headroomed limit. A refactor that quietly
 * dropped the headroom would otherwise be caught by no Pendle test at all.
 *
 * The assertion is on the SIGNED request, not on the estimate call, for the
 * reason `staged-broadcast.ts` states inline: viem can route preparation through
 * the node's `wallet_fillTransaction`, whose reply overwrites `gas` with the
 * node's own unbuffered figure. The signed bytes are what the chain enforces.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAddress, keccak256, type Hex } from "viem";

import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: vi.fn(async () => ({ executionId: 1, events: [{ id: 1 }] })),
  markActivityBroadcast: vi.fn(async () => ({ applied: true, row: {} })),
  markBroadcastAccepted: vi.fn(async () => ({ applied: true, row: {} })),
  confirmActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  failActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  createAgentActivityPreBroadcastFailure: vi.fn(async () => ({ executionId: 1, event: {} })),
  // Real export since migration 067. Without it the handler's best-effort
  // `noteHandlerPendingReason` throws inside its own catch and the pending-reason
  // path is silently skipped instead of exercised.
  notePendingReason: vi.fn(async () => ({ applied: true })),
}));
vi.mock("@vex-agent/sync/pendle-acquisition-pin.js", () => ({
  pinConfirmedPendleAcquisition: vi.fn(async () => undefined),
}));

const { sendPendleRouterTx } = await import(
  "@vex-agent/tools/protocols/pendle/handlers/signed-broadcast.js"
);

const TO = getAddress("0x888888888889758F76e7103c6CbF23ABbF58F946");
const DATA = "0xdeadbeef" as Hex;
const WALLET = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");
const SERIALIZED = "0x02f8b10101" as Hex;
const TX_HASH = keccak256(SERIALIZED);

const PLAN = {
  toolId: "pendle.pt.buy",
  eventRole: "yield_pt",
  chainId: 8453,
  chainSlug: "base",
  walletAddress: WALLET,
  sessionId: "s",
  intentParams: {},
} as const;

function clients(estimate: bigint | Error) {
  const estimateGas = vi.fn(async (_request: Record<string, unknown>) => {
    if (estimate instanceof Error) throw estimate;
    return estimate;
  });
  const signTransaction = vi.fn(
    async (_request: { gas: bigint; value?: bigint }) => SERIALIZED,
  );
  const sendRawTransaction = vi.fn(async () => TX_HASH);
  return {
    publicClient: {
      estimateGas,
      sendRawTransaction,
      // The receipt is irrelevant to gas: these cases end at the signed bytes.
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs: [], blockNumber: 1n })),
    } as never,
    walletClient: {
      account: { address: WALLET },
      chain: { id: 8453 },
      prepareTransactionRequest: vi.fn(async (r: Record<string, unknown>) => ({ ...r, nonce: 7 })),
      signTransaction,
    } as never,
    estimateGas,
    signTransaction,
    sendRawTransaction,
  };
}

/** The gas limit that actually went into the SIGNED transaction. */
function signedGas(c: ReturnType<typeof clients>): bigint {
  const call = c.signTransaction.mock.calls[0];
  if (call === undefined) throw new Error("signTransaction was never called");
  return call[0].gas;
}

beforeEach(() => vi.clearAllMocks());

describe("sendPendleRouterTx signs the headroomed limit, not the bare estimate", () => {
  it("applies gasLimitWithHeadroom to a FRESH per-transaction estimate", async () => {
    const c = clients(1_000_000n);
    const result = await sendPendleRouterTx(c.publicClient, c.walletClient, { to: TO, data: DATA, value: 0n }, PLAN);

    expect(result.txHash).toBe(TX_HASH);
    expect(c.estimateGas).toHaveBeenCalledTimes(1);
    // Estimated for the EXACT call that will run — same to/data/value.
    expect(c.estimateGas.mock.calls[0]?.[0]).toMatchObject({ to: TO, data: DATA, value: 0n });
    expect(signedGas(c)).toBe(gasLimitWithHeadroom(1_000_000n));
    expect(signedGas(c)).toBe(2_000_000n);
  });

  it("would have survived the 2026-07-24 Base burn (needed ~1.63x its signed limit)", async () => {
    // Replaying that transaction proved the route was fine: it reverted at the
    // signed limit 1,026,236 and succeeded at 2,000,000, needing ~1,634,838.
    const c = clients(1_026_236n);
    await sendPendleRouterTx(c.publicClient, c.walletClient, { to: TO, data: DATA, value: 0n }, PLAN);
    expect(signedGas(c)).toBeGreaterThan(1_634_838n);
  });

  it("carries the native value through for a value-bearing call", async () => {
    const c = clients(500_000n);
    await sendPendleRouterTx(c.publicClient, c.walletClient, { to: TO, data: DATA, value: 7n }, PLAN);
    expect(c.estimateGas.mock.calls[0]?.[0]).toMatchObject({ value: 7n });
    expect(c.signTransaction.mock.calls[0]?.[0]).toMatchObject({ value: 7n });
  });

  it("BROADCASTS NOTHING when the estimate fails — a would-revert call is not signed", async () => {
    const c = clients(new Error("execution reverted"));
    await expect(
      sendPendleRouterTx(c.publicClient, c.walletClient, { to: TO, data: DATA, value: 0n }, PLAN),
    ).rejects.toThrow(/execution reverted/);
    expect(c.signTransaction).not.toHaveBeenCalled();
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("never signs a bare estimate — the signed limit always exceeds it", async () => {
    for (const estimate of [21_000n, 350_000n, 1_660_619n]) {
      vi.clearAllMocks();
      const c = clients(estimate);
      await sendPendleRouterTx(c.publicClient, c.walletClient, { to: TO, data: DATA, value: 0n }, PLAN);
      expect(signedGas(c)).toBeGreaterThan(estimate);
    }
  });
});
