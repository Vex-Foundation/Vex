import { afterEach, describe, expect, it, vi } from "vitest";

import {
  builderForOrders,
  resetBuilderFeeAllowanceMemoForTests,
} from "@vex-agent/tools/protocols/hyperliquid/handlers.js";

vi.mock("@vex-agent/db/repos/executions.js", () => ({
  createExecutionIntent: vi.fn().mockResolvedValue(1),
  completeExecutionIntent: vi.fn().mockResolvedValue(undefined),
}));

const BUILDER = "0x4cE6CD494E3586A8075A6fBBE4B214cb5B7Be020" as const;
const USER = "0x0000000000000000000000000000000000000001";

afterEach(() => {
  delete process.env.VEX_HYPERLIQUID_BUILDER_ADDRESS;
  resetBuilderFeeAllowanceMemoForTests();
});

async function flushAllowanceTask(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("Hyperliquid builder fee order attachment", () => {
  it("does not delay the current order, then attaches after maxBuilderFee confirms", async () => {
    process.env.VEX_HYPERLIQUID_BUILDER_ADDRESS = BUILDER;
    const approveBuilderFee = vi.fn();
    const info = { maxBuilderFee: vi.fn().mockResolvedValue(25) } as never;
    const first = builderForOrders(
      info,
      { approveBuilderFee } as never,
      USER,
      { sessionId: "builder-confirmed" },
    );
    // The maxBuilderFee read happens in the memoized background task. The
    // first signing path must not await it or hold up an otherwise-valid order.
    expect(first).toBeUndefined();
    expect(approveBuilderFee).not.toHaveBeenCalled();
    await flushAllowanceTask();

    const attachment = builderForOrders(
      info,
      { approveBuilderFee } as never,
      USER,
      { sessionId: "builder-confirmed" },
    );
    expect(attachment).toEqual({ b: BUILDER, f: 25 });
    expect(approveBuilderFee).not.toHaveBeenCalled();
  });

  it("submits one best-effort approval while leaving concurrent current orders unblocked", async () => {
    process.env.VEX_HYPERLIQUID_BUILDER_ADDRESS = BUILDER;
    let complete: ((value: { readonly kind: "orders"; readonly statuses: readonly []; readonly raw: object }) => void) | undefined;
    const approveBuilderFee = vi.fn(() => new Promise<{ readonly kind: "orders"; readonly statuses: readonly []; readonly raw: object }>((resolve) => {
      complete = resolve;
    }));
    const info = { maxBuilderFee: vi.fn().mockResolvedValue(0) } as never;
    const context = { sessionId: "builder-pending" };

    expect(builderForOrders(info, { approveBuilderFee } as never, USER, context)).toBeUndefined();
    expect(builderForOrders(info, { approveBuilderFee } as never, USER, context)).toBeUndefined();
    await vi.waitFor(() => expect(approveBuilderFee).toHaveBeenCalledTimes(1));
    expect(approveBuilderFee).toHaveBeenCalledWith({ builder: BUILDER, maxFeeRate: "0.025%" });

    complete?.({ kind: "orders", statuses: [], raw: {} });
    await flushAllowanceTask();
  });

  it("clears a failed attempt so the next order can retry without a builder field", async () => {
    process.env.VEX_HYPERLIQUID_BUILDER_ADDRESS = BUILDER;
    const approveBuilderFee = vi.fn().mockResolvedValue({ kind: "batch_error", message: "rejected", raw: {} });
    const info = { maxBuilderFee: vi.fn().mockResolvedValue(0) } as never;
    const context = { sessionId: "builder-retry" };

    expect(builderForOrders(info, { approveBuilderFee } as never, USER, context)).toBeUndefined();
    await vi.waitFor(() => expect(approveBuilderFee).toHaveBeenCalledTimes(1));
    expect(builderForOrders(info, { approveBuilderFee } as never, USER, context)).toBeUndefined();
    await vi.waitFor(() => expect(approveBuilderFee).toHaveBeenCalledTimes(2));
  });

  it("uses persisted builder-fee consent to skip a repeated allowance submission", () => {
    process.env.VEX_HYPERLIQUID_BUILDER_ADDRESS = BUILDER;
    const result = builderForOrders(
      { maxBuilderFee: vi.fn() } as never,
      { approveBuilderFee: vi.fn() } as never,
      USER,
      { sessionId: "builder-consented", hyperliquidPolicy: { kind: "available", snapshot: { policy: { builderFeeConsent: { kind: "approved", maxFeeRate: "0.025%" } } } } } as never,
    );
    expect(result).toEqual({ b: BUILDER, f: 25 });
  });
});
