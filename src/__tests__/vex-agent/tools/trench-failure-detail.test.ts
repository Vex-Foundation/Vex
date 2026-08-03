/**
 * Owner decree (2026-08-02): a trench tool error surfaces the REAL cause,
 * sanitized — never a bare "unexpected error". Pinned here so the generic
 * label cannot quietly return: the live failure that forced this was
 * launch_preview retried blind four times while the wallet simply lacked gas.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@utils/logger.js", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { trenchFailureDetail } = await import(
  "../../../vex-agent/tools/protocols/trench/handlers/failure.js"
);

describe("trenchFailureDetail — real cause, agent-friendly", () => {
  it("classifies the balance failure by name with the remedy", () => {
    const err = new Error(
      "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.",
    );
    const detail = trenchFailureDetail("trench.launch_preview", err);
    expect(detail).toContain("insufficient_funds");
    expect(detail).toContain("top up the wallet");
    expect(detail).toContain("exceeds the balance");
    expect(detail).not.toBe("unexpected error");
  });

  it("surfaces the provider message sanitized — URLs and calldata blobs stripped", () => {
    const err = new Error(
      `request to https://rpc.example.com/v1 failed: execution reverted with data 0x${"ab".repeat(60)}`,
    );
    const detail = trenchFailureDetail("trench.trade_execute", err);
    expect(detail).toContain("provider error:");
    expect(detail).toContain("execution reverted");
    expect(detail).not.toContain("https://");
    expect(detail).not.toContain("ab".repeat(60));
  });

  it("prefers viem's shortMessage when present and caps the length", () => {
    const err = Object.assign(new Error("x".repeat(2000)), { shortMessage: "nonce too low" });
    const detail = trenchFailureDetail("trench.trade_execute", err);
    expect(detail).toBe("provider error: nonce too low");
    expect(trenchFailureDetail("t", new Error("y".repeat(2000))).length).toBeLessThan(440);
  });
});
