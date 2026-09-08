/**
 * The Plasma and MegaETH endpoints, still asserted after the RPC table moved.
 *
 * The original file asserted `DEFAULT_RPC.plasma` and `DEFAULT_RPC.megaeth`
 * against the KyberSwap-owned table. That table is gone: endpoints are owned by
 * `@tools/evm-chains/rpc-endpoints.ts` and keyed by chain id, not by slug. The
 * REGRESSION this file exists for is unchanged - both chains once shipped dead
 * endpoints - so it now asks the owner the same question through the resolver
 * every venue actually uses.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@config/store.js", () => ({ loadConfig: () => ({}) }));

const { resolveRpcEndpoints } = await import("@tools/evm-chains/rpc-endpoints.js");

describe("bundled RPC endpoints for the chains that once shipped dead URLs", () => {
  it("resolves the live plasma endpoint for chain 9745", () => {
    expect(resolveRpcEndpoints(9745).map((endpoint) => endpoint.url)).toEqual([
      "https://rpc.plasma.to",
    ]);
  });

  it("resolves the live megaeth endpoint for chain 4326", () => {
    expect(resolveRpcEndpoints(4326).map((endpoint) => endpoint.url)).toEqual([
      "https://mainnet.megaeth.com/rpc",
    ]);
  });
});
