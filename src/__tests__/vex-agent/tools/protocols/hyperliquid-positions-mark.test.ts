/**
 * W1 regression: the live BTC perp read failed with `Invalid decimal "62026.0"`
 * because `markForCoin` parsed the venue's OPTIONAL display markPx through the
 * strict canonical parser. The mark is display-only, so a non-canonical
 * trailing-zero decimal must normalize (or drop) — never fail the positions read.
 *
 * The `hyperliquid.perp.positions` handler builds its own HyperliquidInfoClient
 * and resolves the wallet through a dynamic import, so both are mocked to drive
 * the metaAndAssetCtxs mark deterministically.
 */

import { describe, expect, it, vi } from "vitest";

import { markForCoin } from "@vex-agent/tools/protocols/hyperliquid/handler-shared.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const mocks = vi.hoisted(() => ({
  clearinghouseState: vi.fn(),
  frontendOpenOrders: vi.fn(),
  metaAndAssetCtxs: vi.fn(),
  resolveSelectedAddressForRead: vi.fn(),
}));

vi.mock("@tools/hyperliquid/info.js", () => ({
  HyperliquidInfoClient: class {
    clearinghouseState = mocks.clearinghouseState;
    frontendOpenOrders = mocks.frontendOpenOrders;
    metaAndAssetCtxs = mocks.metaAndAssetCtxs;
  },
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: mocks.resolveSelectedAddressForRead,
  // Faithful to the real helper: a non-VexError (the decimal parse failure)
  // re-throws, so on HEAD the whole positions read rejects.
  walletScopeErrorToResult: (error: unknown) => { throw error; },
}));

const { HYPERLIQUID_HANDLERS } = await import(
  "@vex-agent/tools/protocols/hyperliquid/handlers.js"
);

const ADDRESS = "0x00000000000000000000000000000000000000ab";

function context(): ProtocolExecutionContext {
  return {
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
  } as ProtocolExecutionContext;
}

describe("hyperliquid.perp.positions venue mark parsing", () => {
  it("reads an open position when the venue mark is a non-canonical trailing-zero decimal", async () => {
    mocks.resolveSelectedAddressForRead.mockReturnValue(ADDRESS);
    mocks.clearinghouseState.mockResolvedValue({
      assetPositions: [{ position: { coin: "BTC", szi: "0.5", entryPx: "60000" } }],
    });
    mocks.frontendOpenOrders.mockResolvedValue([]);
    mocks.metaAndAssetCtxs.mockResolvedValue([
      { universe: [{ name: "BTC" }] },
      [{ markPx: "62026.0" }],
    ]);

    const handler = HYPERLIQUID_HANDLERS["hyperliquid.perp.positions"];
    if (handler === undefined) throw new Error("Missing hyperliquid.perp.positions handler.");

    const result = await handler({}, context());

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?._displayBlock).toMatchObject({
      kind: "position_summary",
      coin: "BTC",
      side: "long",
      markPx: "62026",
    });
  });
});

describe("markForCoin", () => {
  it("normalizes a trailing-zero venue mark to canonical form", () => {
    const response = [{ universe: [{ name: "BTC" }] }, [{ markPx: "62026.0" }]];
    expect(markForCoin(response, "BTC")).toBe("62026");
  });

  it("drops a malformed venue mark instead of throwing", () => {
    const response = [{ universe: [{ name: "BTC" }] }, [{ markPx: "not-a-number" }]];
    expect(markForCoin(response, "BTC")).toBeUndefined();
  });
});
