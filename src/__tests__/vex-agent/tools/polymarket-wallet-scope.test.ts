/**
 * Polymarket per-session wallet scope (puzzle 5 phase 5D-protocols p3).
 *
 * Proves the CLOB handlers resolve the SESSION wallet (not the zero-arg primary)
 * and thread it as auth to the singleton client per call:
 *   - buy uses the selected address as order maker/signer, postOrder auth, and
 *     capture; signs with the selected key;
 *   - a preview (dryRun) never decrypts a signing key;
 *   - a wallet-scope failure fails closed BEFORE postOrder (no broadcast);
 *   - cancels / authenticated reads pass the selected address as auth;
 *   - client.ts no longer imports the zero-arg signer primitive.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const SEL = "0x1111111111111111111111111111111111111111";
const SIGNER = { family: "eip155" as const, address: SEL, privateKey: ("0x" + "ab".repeat(32)) as `0x${string}` };

const mockResolveSigningWallet = vi.fn(() => SIGNER);
const mockResolveSelectedAddress = vi.fn(() => SEL);
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: (...a: unknown[]) => mockResolveSigningWallet(...a),
  resolveSelectedAddress: (...a: unknown[]) => mockResolveSelectedAddress(...a),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: err instanceof Error ? err.message : String(err) }),
}));

const mockGetPrice = vi.fn().mockResolvedValue({ price: 0.5 });
const mockGetFeeRate = vi.fn().mockResolvedValue({ base_fee: 0 });
const mockPostOrder = vi.fn().mockResolvedValue({ status: "matched", orderID: "oid-1" });
const mockCancelOrder = vi.fn().mockResolvedValue({ canceled: ["oid-1"], not_canceled: {} });
const mockGetTrades = vi.fn().mockResolvedValue({ data: [], next_cursor: "" });
vi.mock("@tools/polymarket/clob/client.js", () => ({
  getPolyClobClient: () => ({
    getPrice: (...a: unknown[]) => mockGetPrice(...a),
    getFeeRate: (...a: unknown[]) => mockGetFeeRate(...a),
    postOrder: (...a: unknown[]) => mockPostOrder(...a),
    cancelOrder: (...a: unknown[]) => mockCancelOrder(...a),
    getTrades: (...a: unknown[]) => mockGetTrades(...a),
  }),
}));

vi.mock("@tools/polymarket/gamma/client.js", () => ({
  getPolyGammaClient: () => ({
    resolveMarket: vi.fn().mockResolvedValue({ clobTokenIds: "x", negRisk: false, question: "Q?" }),
  }),
}));

const mockBuildClobOrder = vi.fn(() => ({ salt: "1", maker: SEL, signer: SEL }));
vi.mock("@tools/polymarket/clob/signing.js", () => ({
  buildClobOrder: (...a: unknown[]) => mockBuildClobOrder(...a),
  signClobOrder: vi.fn().mockResolvedValue("0xsig"),
}));

const mockRequireCreds = vi.fn(() => ({ apiKey: "ak", apiSecret: "as", passphrase: "pp" }));
vi.mock("@tools/polymarket/auth.js", () => ({
  requirePolyClobCredentials: (...a: unknown[]) => mockRequireCreds(...a),
}));

vi.mock("@tools/polymarket/helpers.js", () => ({
  parseClobTokenIds: () => ({ yes: "tok-yes", no: "tok-no" }),
}));

const { CLOB_HANDLERS } = await import("@vex-agent/tools/protocols/polymarket/handlers-clob.js");

const SESSION_CTX: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "session", evm: { id: "w-evm-1", address: SEL }, solana: null },
  walletPolicy: { kind: "none" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSigningWallet.mockReturnValue(SIGNER);
  mockResolveSelectedAddress.mockReturnValue(SEL);
  mockGetPrice.mockResolvedValue({ price: 0.5 });
  mockGetFeeRate.mockResolvedValue({ base_fee: 0 });
  mockPostOrder.mockResolvedValue({ success: true, status: "matched", orderID: "oid-1" });
  mockCancelOrder.mockResolvedValue({ canceled: ["oid-1"], not_canceled: {} });
  mockGetTrades.mockResolvedValue({ data: [], next_cursor: "" });
  mockBuildClobOrder.mockReturnValue({ salt: "1", maker: SEL, signer: SEL });
  mockRequireCreds.mockReturnValue({ apiKey: "ak", apiSecret: "as", passphrase: "pp" });
});

describe("polymarket clob session wallet scope", () => {
  const buyParams = { conditionId: "0xcond", outcome: "YES", amount: 10 };

  it("buy uses the SESSION address for order maker/signer, postOrder auth, and capture", async () => {
    const r = await CLOB_HANDLERS["polymarket.clob.buy"]!(buyParams, SESSION_CTX);
    expect(r.success).toBe(true);
    // order maker + signer
    expect(mockBuildClobOrder).toHaveBeenCalledWith(expect.objectContaining({ maker: SEL, signer: SEL }));
    // postOrder auth context (FIRST arg) is the session address
    expect(mockPostOrder.mock.calls[0][0]).toEqual({ address: SEL });
    // credential lookup is scoped to the SESSION signer address (B-core)
    expect(mockRequireCreds).toHaveBeenCalledWith(SEL);
    // capture records the session wallet
    expect((r.data?._tradeCapture as Record<string, unknown>).walletAddress).toBe(SEL);
  });

  it("buy dryRun does NOT decrypt a signing wallet", async () => {
    const r = await CLOB_HANDLERS["polymarket.clob.buy"]!({ ...buyParams, dryRun: true }, SESSION_CTX);
    expect(r.success).toBe(true);
    expect(mockResolveSigningWallet).not.toHaveBeenCalled();
    expect(mockPostOrder).not.toHaveBeenCalled();
  });

  it("buy fails closed on wallet-scope error BEFORE postOrder (no broadcast)", async () => {
    mockResolveSigningWallet.mockImplementationOnce(() => { throw new Error("WALLET_SCOPE_MISMATCH"); });
    const r = await CLOB_HANDLERS["polymarket.clob.buy"]!(buyParams, SESSION_CTX);
    expect(r.success).toBe(false);
    expect(mockPostOrder).not.toHaveBeenCalled();
  });

  it("buy with MISSING creds fails BEFORE decrypting the key (no resolveSigningWallet / postOrder)", async () => {
    // B-core-2 reorder: resolveSelectedAddress -> requireCreds -> resolveSigningWallet.
    // A creds miss must short-circuit before the signing wallet is ever decrypted.
    mockRequireCreds.mockImplementationOnce(() => { throw new Error("POLYMARKET_NOT_CONFIGURED"); });
    await expect(CLOB_HANDLERS["polymarket.clob.buy"]!(buyParams, SESSION_CTX)).rejects.toThrow();
    expect(mockResolveSigningWallet).not.toHaveBeenCalled();
    expect(mockPostOrder).not.toHaveBeenCalled();
  });

  it("cancel threads the session address as auth", async () => {
    await CLOB_HANDLERS["polymarket.clob.cancel"]!({ orderId: "oid-1" }, SESSION_CTX);
    expect(mockCancelOrder.mock.calls[0][0]).toEqual({ address: SEL });
  });

  it("trades threads the session address as auth + maker_address", async () => {
    await CLOB_HANDLERS["polymarket.clob.trades"]!({}, SESSION_CTX);
    expect(mockGetTrades.mock.calls[0][0]).toEqual({ address: SEL });
    expect((mockGetTrades.mock.calls[0][1] as Record<string, unknown>).maker_address).toBe(SEL);
  });
});

describe("polymarket clob client signer regression", () => {
  it("clob/client.ts no longer imports the zero-arg signer primitive", () => {
    const src = readFileSync(join(process.cwd(), "src/tools/polymarket/clob/client.ts"), "utf-8");
    expect(/\brequireEvmWallet\b/.test(src)).toBe(false);
  });
});
