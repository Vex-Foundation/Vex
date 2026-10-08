/**
 * Engine wallet resolver (resolve.ts) — puzzle 5 phase 5B.
 *
 * Pins the address-only vs signing split + mission-policy enforcement.
 * `resolveSelectedEntry` / `loadWalletFromEntry` are mocked so these tests
 * isolate resolve.ts's POLICY logic (no config/keystore). `walletAddressesEqual`
 * is the real implementation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorCodes, VexError } from "../../../../../errors.js";
import type { WalletPolicy } from "../../../../../vex-agent/engine/types.js";

const mockResolveSelectedEntry = vi.fn();
const mockLoadWalletFromEntry = vi.fn();

vi.mock("@tools/wallet/multi-auth.js", () => ({
  resolveSelectedEntry: (...a: unknown[]) => mockResolveSelectedEntry(...a),
  loadWalletFromEntry: (...a: unknown[]) => mockLoadWalletFromEntry(...a),
}));

const {
  resolveSelectedAddress,
  resolveSigningWallet,
  resolveSelectedAddressSet,
  resolveSelectedAddressForRead,
  resolveSelectedAddressSetForRead,
} = await import("../../../../../vex-agent/tools/internal/wallet/resolve.js");

const EVM = "0xabcdef1234567890abcdef1234567890abcdef12";
const SESSION = { source: "session" as const, evm: { id: "evm_x", address: EVM }, solana: null };
const NONE: WalletPolicy = { kind: "none" };

function selectedIs(address = EVM): void {
  mockResolveSelectedEntry.mockReturnValue({
    family: "evm",
    entry: { id: "evm_x", address, label: "x", createdAt: "" },
  });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e: unknown) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e: unknown) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveSelectedAddress — address only, never decrypts", () => {
  it("returns the selected entry address without loading the key", () => {
    selectedIs();
    expect(resolveSelectedAddress(SESSION, NONE, "eip155")).toBe(EVM);
    expect(mockLoadWalletFromEntry).not.toHaveBeenCalled();
  });

  it("mission_allowed + address in the allowed set → ok", () => {
    selectedIs();
    const policy: WalletPolicy = { kind: "mission_allowed", allowedWallets: [EVM] };
    expect(resolveSelectedAddress(SESSION, policy, "eip155")).toBe(EVM);
  });

  it("mission_allowed + address NOT in set → SCOPE_MISMATCH", () => {
    selectedIs();
    const policy: WalletPolicy = {
      kind: "mission_allowed",
      allowedWallets: ["0x0000000000000000000000000000000000000000"],
    };
    expect(codeOf(() => resolveSelectedAddress(SESSION, policy, "eip155"))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
  });

  it("invalid policy → SCOPE_MISMATCH (mission drift). Enforced from the policy, NOT sessionKind — any session carrying an invalid mission policy fails closed.", () => {
    selectedIs();
    const policy: WalletPolicy = { kind: "invalid", reason: "empty_allowed_wallets" };
    expect(codeOf(() => resolveSelectedAddress(SESSION, policy, "eip155"))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
  });
});

describe("resolveSigningWallet — decrypts only after policy passes", () => {
  it("loads the wallet via loadWalletFromEntry when policy allows", async () => {
    selectedIs();
    mockLoadWalletFromEntry.mockResolvedValue({ family: "eip155", address: EVM, privateKey: "0x" });
    expect((await resolveSigningWallet(SESSION, NONE, "eip155")).address).toBe(EVM);
    expect(mockLoadWalletFromEntry).toHaveBeenCalledTimes(1);
  });

  it("policy violation throws BEFORE the key is decrypted", async () => {
    selectedIs();
    const policy: WalletPolicy = {
      kind: "mission_allowed",
      allowedWallets: ["0x0000000000000000000000000000000000000000"],
    };
    expect(await asyncCodeOf(() => resolveSigningWallet(SESSION, policy, "eip155"))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
    expect(mockLoadWalletFromEntry).not.toHaveBeenCalled();
  });
});

describe("resolveSelectedAddressSet — read-side wallet set", () => {
  const SOL = "SoLAddrAAA";

  it("returns BOTH selected addresses for a fully-selected session", () => {
    mockResolveSelectedEntry.mockImplementation((family: string) =>
      family === "solana"
        ? { family: "solana", entry: { id: "sol_x", address: SOL, label: "s", createdAt: "" } }
        : { family: "evm", entry: { id: "evm_x", address: EVM, label: "e", createdAt: "" } },
    );
    const set = resolveSelectedAddressSet(SESSION, NONE);
    expect(set.evm).toBe(EVM);
    expect(set.solana).toBe(SOL);
    expect(set.all).toEqual([EVM, SOL]);
  });

  it("a family with no selection (WALLET_NOT_SELECTED) → null, not an error", () => {
    mockResolveSelectedEntry.mockImplementation((family: string) => {
      if (family === "solana") throw new VexError(ErrorCodes.WALLET_NOT_SELECTED, "no sol");
      return { family: "evm", entry: { id: "evm_x", address: EVM, label: "e", createdAt: "" } };
    });
    const set = resolveSelectedAddressSet(SESSION, NONE);
    expect(set.evm).toBe(EVM);
    expect(set.solana).toBeNull();
    expect(set.all).toEqual([EVM]);
  });

  it("default resolution with no wallet configured for a family (WALLET_NOT_CONFIGURED) -> empty set", () => {
    mockResolveSelectedEntry.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_NOT_CONFIGURED, "none configured");
    });
    const set = resolveSelectedAddressSet({ source: "default" }, NONE);
    expect(set.all).toEqual([]);
  });

  it("invalid mission policy fails closed FIRST (resolveSelectedEntry never called)", () => {
    const policy: WalletPolicy = { kind: "invalid", reason: "empty_allowed_wallets" };
    expect(codeOf(() => resolveSelectedAddressSet(SESSION, policy))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
    expect(mockResolveSelectedEntry).not.toHaveBeenCalled();
  });

  it("address drift / removed wallet (WALLET_SCOPE_MISMATCH) re-throws (never silently empties)", () => {
    mockResolveSelectedEntry.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_SCOPE_MISMATCH, "drift");
    });
    expect(codeOf(() => resolveSelectedAddressSet(SESSION, NONE))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
  });
});

// ── Mission SETUP read exception (least-privilege) ────────────────
//
// During a mission's SETUP phase the policy is invalid with reason
// "mission_without_active_run" (mission exists, no active run yet). Read-only
// resolvers (`*ForRead`) opt in so the session can READ its own selected wallet
// to research+plan the contract. MUTATING/signing paths (the DEFAULT resolvers)
// stay fail-closed. Active-run contract drift still fails closed even for reads.
describe("mission-setup read exception — security envelope", () => {
  const SOL = "SoLAddrAAA";
  const SETUP: WalletPolicy = { kind: "invalid", reason: "mission_without_active_run" };
  const DRIFT_SNAPSHOT: WalletPolicy = {
    kind: "invalid",
    reason: "missing_or_malformed_snapshot",
  };
  const DRIFT_EMPTY: WalletPolicy = { kind: "invalid", reason: "empty_allowed_wallets" };

  function bothSelected(): void {
    mockResolveSelectedEntry.mockImplementation((family: string) =>
      family === "solana"
        ? { family: "solana", entry: { id: "sol_x", address: SOL, label: "s", createdAt: "" } }
        : { family: "evm", entry: { id: "evm_x", address: EVM, label: "e", createdAt: "" } },
    );
  }

  it("setup + resolveSelectedAddressForRead → returns the selected address (no throw)", () => {
    selectedIs();
    expect(resolveSelectedAddressForRead(SESSION, SETUP, "eip155")).toBe(EVM);
    expect(mockLoadWalletFromEntry).not.toHaveBeenCalled();
  });

  it("setup + resolveSelectedAddressSetForRead → returns the selected set (no throw)", () => {
    bothSelected();
    const set = resolveSelectedAddressSetForRead(SESSION, SETUP);
    expect(set.evm).toBe(EVM);
    expect(set.solana).toBe(SOL);
    expect(set.all).toEqual([EVM, SOL]);
  });

  it("setup + DEFAULT resolveSelectedAddress → STILL throws (wallet_send_prepare stays blocked in setup)", () => {
    selectedIs();
    expect(codeOf(() => resolveSelectedAddress(SESSION, SETUP, "eip155"))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
  });

  it("setup + DEFAULT resolveSelectedAddressSet → STILL throws", () => {
    selectedIs();
    expect(codeOf(() => resolveSelectedAddressSet(SESSION, SETUP))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
  });

  it("setup + resolveSigningWallet → STILL throws BEFORE any key decrypt", async () => {
    selectedIs();
    expect(await asyncCodeOf(() => resolveSigningWallet(SESSION, SETUP, "eip155"))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
    expect(mockLoadWalletFromEntry).not.toHaveBeenCalled();
  });

  it("active-run drift (missing_or_malformed_snapshot) + ForRead helpers → STILL throw", () => {
    selectedIs();
    expect(codeOf(() => resolveSelectedAddressForRead(SESSION, DRIFT_SNAPSHOT, "eip155"))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
    // Set resolver fails closed FIRST — never reaches per-family resolution.
    mockResolveSelectedEntry.mockClear();
    expect(codeOf(() => resolveSelectedAddressSetForRead(SESSION, DRIFT_SNAPSHOT))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
    expect(mockResolveSelectedEntry).not.toHaveBeenCalled();
  });

  it("active-run drift (empty_allowed_wallets) + ForRead helpers → STILL throw", () => {
    selectedIs();
    expect(codeOf(() => resolveSelectedAddressForRead(SESSION, DRIFT_EMPTY, "eip155"))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
    expect(codeOf(() => resolveSelectedAddressSetForRead(SESSION, DRIFT_EMPTY))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
  });

  it("kind:none + ForRead helpers → unchanged pass", () => {
    bothSelected();
    expect(resolveSelectedAddressForRead(SESSION, NONE, "eip155")).toBe(EVM);
    const set = resolveSelectedAddressSetForRead(SESSION, NONE);
    expect(set.all).toEqual([EVM, SOL]);
  });

  it("mission_allowed membership via ForRead → allowed passes, non-member throws", () => {
    selectedIs();
    const allowed: WalletPolicy = { kind: "mission_allowed", allowedWallets: [EVM] };
    expect(resolveSelectedAddressForRead(SESSION, allowed, "eip155")).toBe(EVM);

    const nonMember: WalletPolicy = {
      kind: "mission_allowed",
      allowedWallets: ["0x0000000000000000000000000000000000000000"],
    };
    expect(codeOf(() => resolveSelectedAddressForRead(SESSION, nonMember, "eip155"))).toBe(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
    );
  });

  it("setup + a family with no selection (WALLET_NOT_SELECTED) via ForRead → null, not an error", () => {
    mockResolveSelectedEntry.mockImplementation((family: string) => {
      if (family === "solana") throw new VexError(ErrorCodes.WALLET_NOT_SELECTED, "no sol");
      return { family: "evm", entry: { id: "evm_x", address: EVM, label: "e", createdAt: "" } };
    });
    const set = resolveSelectedAddressSetForRead(SESSION, SETUP);
    expect(set.evm).toBe(EVM);
    expect(set.solana).toBeNull();
    expect(set.all).toEqual([EVM]);
  });
});
