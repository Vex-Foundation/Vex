/**
 * inventory-wallets tests — the extracted GLOBAL wallet allow-list resolver
 * shared by `portfolio-db.ts` and `token-history-db.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listWallets: vi.fn(),
}));

vi.mock("@vex-lib/wallet.js", () => ({
  listWallets: mocks.listWallets,
}));

const { listInventoryWalletEntries, resolveInventoryWalletAddressLookupVariants } =
  await import("../inventory-wallets.js");

const EVM_A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const EVM_B = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
const SOL_A = "So11111111111111111111111111111111111111112";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("listInventoryWalletEntries", () => {
  it("concatenates EVM entries then Solana entries", () => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm"
        ? [{ id: "1", address: EVM_A, label: "", createdAt: "" }]
        : [{ id: "2", address: SOL_A, label: "", createdAt: "" }],
    );
    const entries = listInventoryWalletEntries();
    expect(entries.map((e) => e.address)).toEqual([EVM_A, SOL_A]);
  });

  it("returns an empty array when no wallets are configured", () => {
    mocks.listWallets.mockReturnValue([]);
    expect(listInventoryWalletEntries()).toEqual([]);
  });
});

describe("resolveInventoryWalletAddressLookupVariants", () => {
  it("adds raw+lowercase lookup variants for EVM but keeps Solana exact", () => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm"
        ? [
            { id: "1", address: EVM_A, label: "", createdAt: "" },
            { id: "2", address: EVM_B, label: "", createdAt: "" },
          ]
        : [{ id: "3", address: SOL_A, label: "", createdAt: "" }],
    );
    const addresses = resolveInventoryWalletAddressLookupVariants();
    expect(addresses).toEqual([
      EVM_A,
      EVM_A.toLowerCase(),
      EVM_B,
      EVM_B.toLowerCase(),
      SOL_A,
    ]);
    expect(addresses).not.toContain(SOL_A.toLowerCase());
  });

  it("dedupes an EVM address already stored in lowercase", () => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm"
        ? [
            { id: "1", address: EVM_A, label: "", createdAt: "" },
            { id: "2", address: EVM_A.toLowerCase(), label: "", createdAt: "" },
          ]
        : [],
    );
    expect(resolveInventoryWalletAddressLookupVariants()).toEqual([
      EVM_A,
      EVM_A.toLowerCase(),
    ]);
  });

  it("does not broaden an invalid EVM-shaped inventory value", () => {
    const invalid = "0xNotACompleteWalletAddress";
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm" ? [{ id: "1", address: invalid, label: "", createdAt: "" }] : [],
    );
    expect(resolveInventoryWalletAddressLookupVariants()).toEqual([invalid]);
  });
});
