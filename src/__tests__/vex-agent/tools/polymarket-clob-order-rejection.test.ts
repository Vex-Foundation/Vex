/**
 * polymarket.clob.buy/sell ToolResult honesty on venue rejection.
 *
 * Uses the exact fixture already present in polymarket-handlers.test.ts
 * ("preserves a non-empty errorMsg in the lean output", success: false,
 * orderID: "", errorMsg: "order rejected") — that existing test proves the
 * lean-output SHAPING is correct (errorMsg survives), but it never asserted
 * `r.success` or `_tradeCapture`. Before the fix, both handlers returned
 * `success: true` and emitted a phantom `_tradeCapture` with status "open"
 * for an order the venue never accepted (proven: 4/4 red against the
 * unmodified handler). Now the venue's `success: false` drives the
 * ToolResult and the capture pipeline directly.
 *
 * Mirrors the polymarket.clob.cancel guard a few lines below in the same
 * file ("reports success=false when the requested order lands in
 * not_canceled") — cancel already treated venue rejection as a ToolResult
 * failure; buy/sell now get the same treatment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPostOrder = vi.fn();
const mockGetFeeRate = vi.fn(() => Promise.resolve({ base_fee: 0 }));
const mockResolveMarket = vi.fn();

vi.mock("@tools/polymarket/clob/client.js", () => ({
  getPolyClobClient: () => ({
    postOrder: (...a: unknown[]) => mockPostOrder(...a),
    getFeeRate: (...a: unknown[]) => mockGetFeeRate(...a),
  }),
}));
vi.mock("@tools/polymarket/gamma/client.js", () => ({
  getPolyGammaClient: () => ({ resolveMarket: (...a: unknown[]) => mockResolveMarket(...a) }),
}));
vi.mock("@tools/polymarket/auth.js", () => ({
  requirePolyClobCredentials: () => ({ apiKey: "test-api-key", apiSecret: "secret", passphrase: "pass" }),
}));
vi.mock("@tools/polymarket/clob/signing.js", () => ({
  buildClobOrder: () => ({ maker: "0xMAKER", side: "BUY" }),
  signClobOrder: () => Promise.resolve("0xSIGNATURE"),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/internal/wallet/resolve.js")>();
  return {
    ...actual,
    resolveSelectedAddress: () => "0x1111111111111111111111111111111111111111",
    resolveSigningWallet: () => ({
      family: "eip155" as const,
      address: "0x1111111111111111111111111111111111111111",
      privateKey: "0xabc",
    }),
  };
});

const { POLYMARKET_HANDLERS } = await import("../../../vex-agent/tools/protocols/polymarket/handlers.js");

const SIGNING_CTX = {
  sessionPermission: "full" as const,
  approved: true,
  walletResolution: { source: "session" as const, evm: null, solana: null },
  walletPolicy: { kind: "none" as const },
};

const BUY_PARAMS = { conditionId: "0xCOND", outcome: "YES", amount: 10, price: 0.5 };
const SELL_PARAMS = { conditionId: "0xCOND", outcome: "YES", amount: 8, price: 0.4 };

// The venue's own rejection response — the shape sendOrderResponseSchema
// actually produces (success: isTrue -> false, errorMsg carries the reason).
// Not hypothetical: this is the CLOB's real "order not accepted" response.
const REJECTED = {
  success: false,
  orderID: "",
  status: "live" as const,
  errorMsg: "not enough balance/allowance",
};

beforeEach(() => {
  mockPostOrder.mockReset().mockResolvedValue(REJECTED);
  mockGetFeeRate.mockReset().mockResolvedValue({ base_fee: 0 });
  mockResolveMarket.mockReset().mockResolvedValue({
    clobTokenIds: '["yesTok","noTok"]',
    negRisk: false,
    question: "Test market?",
  });
});

describe("polymarket.clob.buy — venue rejection must fail the tool result", () => {
  it("venue said success:false, errorMsg set, no orderID — ToolResult is a failure", async () => {
    const r = await POLYMARKET_HANDLERS["polymarket.clob.buy"]!(BUY_PARAMS, SIGNING_CTX);
    expect(r.success).toBe(false);
  });

  it("venue said success:false — no _tradeCapture (no phantom open order)", async () => {
    const r = await POLYMARKET_HANDLERS["polymarket.clob.buy"]!(BUY_PARAMS, SIGNING_CTX);
    expect(r.data?._tradeCapture).toBeUndefined();
  });

  it("venue said success:false — errorMsg/orderID/status still readable in output", async () => {
    const r = await POLYMARKET_HANDLERS["polymarket.clob.buy"]!(BUY_PARAMS, SIGNING_CTX);
    const out = JSON.parse(r.output);
    expect(out.errorMsg).toBe(REJECTED.errorMsg);
    expect(out.orderID).toBe("");
    expect(out.filled).toBe(false);
  });

  it("regression: a matched order still succeeds and still captures", async () => {
    mockPostOrder.mockResolvedValue({
      success: true,
      orderID: "0xORDER",
      status: "matched",
      errorMsg: "",
    });
    const r = await POLYMARKET_HANDLERS["polymarket.clob.buy"]!(BUY_PARAMS, SIGNING_CTX);
    expect(r.success).toBe(true);
    expect(r.data?._tradeCapture).toMatchObject({ status: "executed" });
  });
});

describe("polymarket.clob.sell — venue rejection must fail the tool result", () => {
  it("venue said success:false, errorMsg set, no orderID — ToolResult is a failure", async () => {
    const r = await POLYMARKET_HANDLERS["polymarket.clob.sell"]!(SELL_PARAMS, SIGNING_CTX);
    expect(r.success).toBe(false);
  });

  it("venue said success:false — no _tradeCapture (no phantom open order)", async () => {
    const r = await POLYMARKET_HANDLERS["polymarket.clob.sell"]!(SELL_PARAMS, SIGNING_CTX);
    expect(r.data?._tradeCapture).toBeUndefined();
  });

  it("regression: a matched order still succeeds and still captures", async () => {
    mockPostOrder.mockResolvedValue({
      success: true,
      orderID: "0xSELLORDER",
      status: "matched",
      errorMsg: "",
    });
    const r = await POLYMARKET_HANDLERS["polymarket.clob.sell"]!(SELL_PARAMS, SIGNING_CTX);
    expect(r.success).toBe(true);
    expect(r.data?._tradeCapture).toMatchObject({ status: "closed" });
  });
});
