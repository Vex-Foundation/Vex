import { afterEach, expect, it, vi } from "vitest";
import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";

const state = vi.hoisted(() => ({ logs: [] as Record<string, unknown>[], handler: vi.fn() }));
vi.mock("@utils/logger.js", () => ({ default: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  info: (event: string, facts: Record<string, unknown>) => { if (event === "protocol.execute.completed") state.logs.push(facts); } } }));
vi.mock("@vex-agent/tools/protocols/catalog.js", async original => ({
  ...await original<typeof import("@vex-agent/tools/protocols/catalog.js")>(), getProtocolHandler: () => state.handler,
}));
afterEach(() => vi.restoreAllMocks());

it("measures duration monotonically when wall time steps backwards inside a handler", async () => {
  state.logs = [];
  const wall = vi.spyOn(Date, "now").mockReturnValue(10000);
  const monotonic = vi.spyOn(performance, "now").mockReturnValue(100);
  state.handler.mockImplementationOnce(async () => {
    wall.mockReturnValue(1000);
    monotonic.mockReturnValue(142);
    return { success: true, output: "read-only test result" };
  });
  await executeProtocolTool({ toolId: "uniswap.swap.quote", params: { chain: "8453", tokenIn: "ETH",
    tokenOut: "0x1111111111111111111111111111111111111111", amountIn: "0.0001", slippageBps: 100 } },
  { sessionPermission: "full", approved: true, walletResolution: { source: "session", evm: null, solana: null }, walletPolicy: { kind: "none" } });
  expect(state.handler).toHaveBeenCalledOnce();
  expect(state.logs).toContainEqual(expect.objectContaining({ durationMs: 42 }));
});
