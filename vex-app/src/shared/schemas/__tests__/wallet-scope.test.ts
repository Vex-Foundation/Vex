/**
 * Per-session wallet scope schemas (puzzle 5 phase 5C). The scope is an
 * explicit 1 EVM + 1 Solana pair (not an allow-list); available-wallet DTOs
 * are strict so leaked key material is rejected at the boundary.
 */

import { describe, it, expect } from "vitest";
import {
  availableWalletsDtoSchema,
  sessionWalletScopeDtoSchema,
  walletsSetScopeInputSchema,
} from "../wallets.js";

const SID = "00000000-0000-4000-8000-000000000001";

describe("sessionWalletScopeDtoSchema", () => {
  it("accepts explicit per-family selection + null", () => {
    expect(
      sessionWalletScopeDtoSchema.safeParse({
        sessionId: SID,
        evm: { walletId: "evm_1", address: "0xAbc", label: "Main" },
        solana: null,
      }).success,
    ).toBe(true);
  });

  it("rejects the legacy allowedWalletIds shape", () => {
    expect(
      sessionWalletScopeDtoSchema.safeParse({
        sessionId: SID,
        allowedWalletIds: [],
        defaultWalletId: null,
      }).success,
    ).toBe(false);
  });
});

describe("walletsSetScopeInputSchema", () => {
  it("is an explicit id pair (IDs only - addresses resolved server-side)", () => {
    expect(
      walletsSetScopeInputSchema.safeParse({
        sessionId: SID,
        evmWalletId: "evm_1",
        solanaWalletId: null,
      }).success,
    ).toBe(true);
  });
});

describe("availableWalletsDtoSchema", () => {
  it("accepts id/family/address/label", () => {
    expect(
      availableWalletsDtoSchema.safeParse({
        evm: [{ id: "evm_1", family: "evm", address: "0xAbc", label: "Main" }],
        solana: [],
      }).success,
    ).toBe(true);
  });

  it("rejects extra fields (strict) - leaked key material cannot pass the boundary", () => {
    expect(
      availableWalletsDtoSchema.safeParse({
        evm: [
          { id: "evm_1", family: "evm", address: "0xAbc", label: "Main", privateKey: "0xLEAK" },
        ],
        solana: [],
      }).success,
    ).toBe(false);
  });
});
