import { describe, expect, it } from "vitest";

import { auditCapture } from "../../../../vex-agent/tools/protocols/hyperliquid/handlers.js";

const accepted = { kind: "orders", statuses: [], raw: {} } as const;

describe("Hyperliquid Phase 5 audit captures", () => {
  it.each(["account", "transfer", "lp", "stake", "reward"] as const)("captures %s mutations without inventing PnL", (type) => {
    expect(auditCapture(type, accepted, "0x0000000000000000000000000000000000000001", { action: type })).toEqual({
      type,
      chain: "hyperliquid",
      status: "executed",
      walletAddress: "0x0000000000000000000000000000000000000001",
      valuationSource: "none",
      meta: { action: type },
    });
  });
});
