/**
 * WALLETS (session) card — the copy-ready session wallet pair.
 *
 * Pins:
 *   - one row per family the session actually holds; an absent family renders
 *     no row at all (never an empty placeholder address),
 *   - the wallet's own label shows when set, and the family caption is always
 *     present so the row says WHICH chain family the address belongs to,
 *   - READ-ONLY: the session's wallet selection is immutable post-first-message,
 *     so the card offers no picker/change control at all — only the copy key,
 *   - a scope with neither family states the consequence (wallet tools stay
 *     disabled) rather than rendering an empty card.
 *
 * `useSessionWallets` is mocked — this suite owns the card's display rules,
 * not the query wiring.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SessionWalletScopeDto } from "@shared/schemas/wallets/session-available.js";

const mockUseSessionWallets = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/api/session-wallets.js", () => ({
  useSessionWallets: mockUseSessionWallets,
}));
const { SessionWalletsCard } = await import("../book/SessionWalletsCard.js");

const SESSION = "00000000-0000-4000-8000-00000000ddaa";
const EVM_ADDR = "0xAAAAbbbbccccddddeeeeffff0000111122223333";
const SOL_ADDR = "So11111111111111111111111111111111111111112";

function scope(overrides: Partial<SessionWalletScopeDto>): SessionWalletScopeDto {
  return {
    sessionId: SESSION,
    evm: null,
    solana: null,
    ...overrides,
  };
}

function mount(data: SessionWalletScopeDto | null, isLoading = false) {
  mockUseSessionWallets.mockReturnValue({
    isLoading,
    isError: false,
    data: data === null ? undefined : { ok: true, data },
  });
  return render(<SessionWalletsCard sessionId={SESSION} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SessionWalletsCard", () => {
  it("renders a copy-ready row per held family", () => {
    mount(
      scope({
        evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" },
        solana: { walletId: "w-sol", address: SOL_ADDR, label: "" },
      }),
    );
    expect(screen.getByText("0xAAAA…3333")).not.toBeNull();
    expect(screen.getByText("So1111…1112")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Copy address" })).toHaveLength(2);
  });

  it("shows the wallet's own label when set, and always the family caption", () => {
    mount(
      scope({ evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" } }),
    );
    expect(screen.getByText("Trading")).not.toBeNull();
    expect(screen.getByText("EVM")).not.toBeNull();
  });

  it("falls back to the family caption alone for an unlabeled wallet", () => {
    mount(scope({ solana: { walletId: "w-sol", address: SOL_ADDR, label: "" } }));
    expect(screen.getByText("SOL")).not.toBeNull();
  });

  it("renders NO row for an absent family", () => {
    mount(
      scope({ evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" } }),
    );
    expect(screen.getAllByRole("button", { name: "Copy address" })).toHaveLength(1);
    expect(screen.queryByText("SOL")).toBeNull();
  });

  it("is READ-ONLY - no picker or change control, only the copy key", () => {
    mount(
      scope({
        evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" },
        solana: { walletId: "w-sol", address: SOL_ADDR, label: "Spend" },
      }),
    );
    const buttons = screen.getAllByRole("button");
    for (const button of buttons) {
      expect(button.getAttribute("aria-label")).toBe("Copy address");
    }
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("states the consequence when the session has no wallets at all", () => {
    mount(scope({}));
    expect(
      screen.getByText(/wallet tools stay disabled/i),
    ).not.toBeNull();
  });
});
