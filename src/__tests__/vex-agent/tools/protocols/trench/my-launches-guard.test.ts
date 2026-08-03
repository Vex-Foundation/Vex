/**
 * `trench.my_launches` — an unreadable index is a NAMED failure, not a throw.
 *
 * The local launch-index read was the one unguarded call in the namespace:
 * every sibling read handler wraps its IO in `trenchFailureDetail`, this one
 * did not, so a database that was down threw past the handler and the agent got
 * whatever generic shape the runtime produced. That matters more here than
 * elsewhere because the ALTERNATIVE reading is "you have launched nothing" —
 * and the handler's own output already goes out of its way to say an empty list
 * means exactly that. Silence would have made the two indistinguishable.
 */

import { describe, it, expect, vi } from "vitest";

const { listForWallets } = vi.hoisted(() => ({
  listForWallets: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/launched-tokens.js", () => ({ listForWallets }));

// Wallet resolution has its own suite; what is under test here is what the
// handler does with the index read, so the resolved wallet is a fixed input.
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: () => "0x33eF000000000000000000000000000000000001",
}));

import { trenchMyLaunchesHandler } from "@vex-agent/tools/protocols/trench/handlers/my-launches.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const WALLET = "0x33eF000000000000000000000000000000000001";

function context(): ProtocolExecutionContext {
  return {
    sessionId: "my-launches-guard",
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "session", evm: { id: "w1", address: WALLET }, solana: null },
    walletPolicy: { kind: "none" },
  } as never;
}

describe("trench.my_launches — the local index read is guarded", () => {
  it("returns a named failure carrying the real cause when the index cannot be read", async () => {
    listForWallets.mockImplementation(async () => {
      throw new Error("connection to the launch index was refused");
    });

    const result = await trenchMyLaunchesHandler({}, context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("trench.my_launches");
    expect(result.output).toContain("connection to the launch index was refused");
    // The distinction that makes this worth a guard at all.
    expect(result.output).toContain("NOT an empty launch history");
  });

  it("still reports a genuinely empty history as an empty history", async () => {
    listForWallets.mockResolvedValue([]);

    const result = await trenchMyLaunchesHandler({}, context());

    expect(result.success).toBe(true);
    expect(result.output).toContain('"count":0');
    expect(result.output).not.toContain("NOT an empty launch history");
  });
});
