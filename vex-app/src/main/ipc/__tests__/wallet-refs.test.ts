/**
 * Server-side wallet-ref resolution (puzzle 5 phase 5C). The renderer sends
 * only IDs; main resolves id → address from the inventory. A renderer-supplied
 * address is never trusted; an unknown id fails closed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetWalletById = vi.fn();
const mockGetPrimaryEvmEntry = vi.fn();
vi.mock("@vex-lib/wallet.js", () => ({
  getWalletById: (...a: unknown[]) => mockGetWalletById(...a),
  getPrimaryEvmEntry: (...a: unknown[]) => mockGetPrimaryEvmEntry(...a),
}));

const { resolveWalletRef, deskWalletRef, invalidWalletSelectionError } =
  await import("../_wallet-refs.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveWalletRef", () => {
  it("null / empty id → null (unselected)", () => {
    expect(resolveWalletRef("evm", null)).toBeNull();
    expect(resolveWalletRef("evm", undefined)).toBeNull();
    expect(resolveWalletRef("evm", "")).toBeNull();
    expect(mockGetWalletById).not.toHaveBeenCalled();
  });

  it("known id → {id,address} resolved server-side from inventory", () => {
    mockGetWalletById.mockReturnValue({ id: "evm_1", address: "0xAbc", label: "Main", createdAt: "" });
    expect(resolveWalletRef("evm", "evm_1")).toEqual({ id: "evm_1", address: "0xAbc" });
    expect(mockGetWalletById).toHaveBeenCalledWith("evm", "evm_1");
  });

  it("unknown id → 'invalid' (caller fails closed)", () => {
    mockGetWalletById.mockReturnValue(null);
    expect(resolveWalletRef("solana", "sol_x")).toBe("invalid");
  });
});

/**
 * The desk mints its own session when a trader opens setup, and that flow has
 * no wallet picker in it. An absent selection there means "nobody was asked",
 * not "chat only" - and left unfilled it produced a desk session whose setup
 * modal could never read an account, because it had no address to read one for.
 */
describe("deskWalletRef", () => {
  beforeEach(() => {
    mockGetPrimaryEvmEntry.mockReturnValue({ id: "evm_legacy", address: "0x5D5D", label: "Primary" });
  });

  it("fills an unselected Lighter desk session with the primary wallet", () => {
    expect(deskWalletRef("lighter", null)).toEqual({ id: "evm_legacy", address: "0x5D5D" });
  });

  it("never overrides a wallet the caller did choose", () => {
    const chosen = { id: "evm_2", address: "0xBeef" };
    expect(deskWalletRef("lighter", chosen)).toBe(chosen);
    expect(mockGetPrimaryEvmEntry).not.toHaveBeenCalled();
  });

  it("leaves every other workspace exactly as it asked to be", () => {
    // An ordinary session with no wallet is a deliberate chat-only session.
    expect(deskWalletRef(null, null)).toBeNull();
    expect(deskWalletRef(undefined, null)).toBeNull();
    expect(mockGetPrimaryEvmEntry).not.toHaveBeenCalled();
  });

  it("stays null when there is no wallet to bind", () => {
    mockGetPrimaryEvmEntry.mockReturnValue(null);
    expect(deskWalletRef("lighter", null)).toBeNull();
  });
});

describe("invalidWalletSelectionError", () => {
  it("builds a redacted wallets.invalid_selection VexError with the correlation id", () => {
    const e = invalidWalletSelectionError("corr-1");
    expect(e.code).toBe("wallets.invalid_selection");
    expect(e.domain).toBe("wallets");
    expect(e.correlationId).toBe("corr-1");
    expect(e.redacted).toBe(true);
    expect(e.retryable).toBe(false);
  });
});
