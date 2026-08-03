/**
 * W9b — `bridge_status` / `khalani.orders.get` merges the provider's order
 * state with Vex's own `agent_activity` record.
 *
 * Before this, the read path was a pure provider pass-through: the agent's
 * status check saw Khalani's view only, while the bridge result a turn earlier
 * had deliberately reported `filled_unverified`. Nothing reconciled the two.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

const mockFindActivityByProviderOrderId = vi.fn();
const mockListActivityLegsByExecutionId = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity/watch-reads.js", () => ({
  findActivityByProviderOrderId: (...args: unknown[]) => mockFindActivityByProviderOrderId(...args),
}));
vi.mock("@vex-agent/db/repos/agent-activity/execution-legs.js", () => ({
  listActivityLegsByExecutionId: (...args: unknown[]) => mockListActivityLegsByExecutionId(...args),
}));

const { describeKhalaniOrderCorrelation } = await import(
  "@vex-agent/tools/protocols/khalani/order-correlation.js"
);

function leg(overrides: Partial<AgentActivityEvent>): AgentActivityEvent {
  return {
    protocolExecutionId: 77,
    eventRole: "bridge_deposit",
    status: "confirmed",
    chainSlug: "ethereum",
    txHash: "0xdeadbeef",
    failureReason: null,
    providerStatus: null,
    ...overrides,
  } as AgentActivityEvent;
}

describe("khalani order correlation (W9b)", () => {
  beforeEach(() => {
    mockFindActivityByProviderOrderId.mockReset();
    mockListActivityLegsByExecutionId.mockReset();
  });

  it("returns the execution id, every Vex leg, and the fee outcome", async () => {
    mockFindActivityByProviderOrderId.mockResolvedValue(leg({}));
    mockListActivityLegsByExecutionId.mockResolvedValue([
      leg({ eventRole: "allowance", status: "confirmed" }),
      leg({ eventRole: "bridge_deposit", status: "confirmed" }),
      leg({ eventRole: "bridge_fee", status: "confirmed" }),
      leg({ eventRole: "bridge_fill_expected", status: "pending", chainSlug: "base", txHash: null, providerStatus: "filled" }),
    ]);

    const { correlation, correlationNote } = await describeKhalaniOrderCorrelation("order_abc123");

    expect(correlationNote).toBeUndefined();
    expect(correlation?._executionId).toBe(77);
    expect(correlation?.legs.map((l) => l.role)).toEqual([
      "allowance",
      "bridge_deposit",
      "bridge_fee",
      "bridge_fill_expected",
    ]);
    expect(correlation?.vexFeeCollection).toBe("confirmed");
    // The LOGICAL row decides Vex's status, not the first leg.
    expect(correlation?.vexStatus).toBe("pending");
    expect(correlation?.lastRecordedProviderStatus).toBe("filled");
  });

  it("tells the agent a pending logical row is not a stalled bridge", async () => {
    mockFindActivityByProviderOrderId.mockResolvedValue(leg({}));
    mockListActivityLegsByExecutionId.mockResolvedValue([
      leg({ eventRole: "bridge_fill_expected", status: "pending", providerStatus: "filled" }),
    ]);

    const { correlation } = await describeKhalaniOrderCorrelation("order_abc123");
    expect(correlation?.note).toBe(
      'Vex has not yet verified this bridge on-chain (logical row still pending), so Khalani\'s "filled" '
      + "view can be ahead of Vex's. Vex finalizes the record itself — do not re-bridge.",
    );
  });

  it("reports NO fee leg as null rather than as an uncollected fee", async () => {
    mockFindActivityByProviderOrderId.mockResolvedValue(leg({}));
    mockListActivityLegsByExecutionId.mockResolvedValue([leg({ eventRole: "bridge_deposit" })]);

    const { correlation } = await describeKhalaniOrderCorrelation("order_abc123");
    expect(correlation?.vexFeeCollection).toBeNull();
  });

  it("degrades to a stated note when no Vex record exists", async () => {
    mockFindActivityByProviderOrderId.mockResolvedValue(null);

    const { correlation, correlationNote } = await describeKhalaniOrderCorrelation("order_abc123");
    expect(correlation).toBeNull();
    expect(correlationNote).toContain("No Vex activity record is attached to this order id");
    expect(mockListActivityLegsByExecutionId).not.toHaveBeenCalled();
  });

  it("degrades to a stated note — never a throw — when the DB read fails", async () => {
    mockFindActivityByProviderOrderId.mockRejectedValue(new Error("connection refused to 10.0.0.5"));

    const { correlation, correlationNote } = await describeKhalaniOrderCorrelation("order_abc123");
    expect(correlation).toBeNull();
    expect(correlationNote).toContain("Treat the provider status as unreconciled.");
    // No provider/infra detail leaks into agent-facing text.
    expect(correlationNote).not.toContain("10.0.0.5");
  });
});
