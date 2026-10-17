/**
 * WalletPairCard - the Portfolio page's Wallets section for "This chat" and
 * "This project": the wallet PAIR (1 EVM + 1 Solana) the scope holds, as the
 * same Wallet, Address and Value table the inventory scope draws.
 *
 * Pins:
 *   - one row per family the scope actually holds; an absent family renders
 *     no row at all (never an empty placeholder address),
 *   - the wallet's own label shows when set, the family ("EVM", "SOL") when
 *     not; a project selection carries no label, so its rows show the family
 *     alone; no "Primary" word and no Total row (that is the inventory table),
 *   - the short address in `<code>` with the full one in its tooltip, and each
 *     row's value from ITS OWN per-address read ("Not available" until it
 *     resolves, never a zero),
 *   - READ-ONLY: a session's selection is immutable and a project's is edited
 *     in project settings, so the card has no picker and no "Add wallet", only
 *     the row actions key whose menu holds "Copy address"; a copy is confirmed
 *     in a polite status line and never claimed when the host refused it,
 *   - a scope with neither family states the consequence (wallet tools stay
 *     disabled) rather than rendering an empty card,
 *   - the scope's own read, nothing wider: a project card never calls the
 *     session read (and the other way round), and a failed or unknown project
 *     read lands on the project's OWN error line, never a wider wallet list.
 *
 * `useSessionWallets`, `useProject` and the per-wallet read are mocked: this
 * suite owns the card's display rules, not the query wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PortfolioDto } from "@shared/schemas/portfolio.js";
import type { SessionWalletScopeDto } from "@shared/schemas/wallets/session-available.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";

interface ProjectWalletRefStub {
  readonly id: string;
  readonly address: string;
}

interface ProjectStub {
  readonly id: string;
  readonly name: string;
  readonly wallets: {
    readonly evm: ProjectWalletRefStub | null;
    readonly solana: ProjectWalletRefStub | null;
  };
}

interface SessionQueryStub {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly data: Result<SessionWalletScopeDto> | undefined;
}

interface ProjectQueryStub {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly data: Result<ProjectStub | null> | undefined;
}

interface WalletReadStub {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly data: Result<PortfolioDto> | undefined;
}

const mockUseSessionWallets = vi.hoisted(() =>
  vi.fn<(sessionId: string | null) => SessionQueryStub>(),
);
const mockUseProject = vi.hoisted(() =>
  vi.fn<(projectId: string | null) => ProjectQueryStub>(),
);
const mockUseWalletPortfolio = vi.hoisted(() =>
  vi.fn<(address: string | null) => WalletReadStub>(),
);
const mockWriteClipboard = vi.hoisted(() =>
  vi.fn<(text: string) => Promise<boolean>>(),
);

vi.mock("../../../lib/api/session-wallets.js", () => ({
  useSessionWallets: mockUseSessionWallets,
}));
vi.mock("../../../lib/api/projects.js", () => ({
  useProject: mockUseProject,
}));
vi.mock("../../../lib/api/portfolio.js", () => ({
  usePortfolio: vi.fn(),
  useWalletPortfolio: mockUseWalletPortfolio,
}));
vi.mock("../../../lib/clipboard.js", () => ({
  writeClipboard: mockWriteClipboard,
}));

const { WalletPairCard } = await import("../book/WalletPairCard.js");

const SESSION = "00000000-0000-4000-8000-00000000ddaa";
const PROJECT = "9c1b0e8e-0000-4000-8000-000000000001";
const EVM_ADDR = "0xAAAAbbbbccccddddeeeeffff0000111122223333";
const SOL_ADDR = "So11111111111111111111111111111111111111112";
const EVM_SHORT = "0xAAAA…3333";
const SOL_SHORT = "So1111…1112";

/** A full error envelope, as main would hand the renderer on a failed read. */
const READ_FAILED: VexError = {
  code: "internal.unexpected",
  domain: "system",
  message: "boom",
  retryable: false,
  userActionable: false,
  redacted: true,
  correlationId: "00000000-0000-4000-8000-0000000000ee",
};

const IDLE_SESSION: SessionQueryStub = {
  isLoading: false,
  isError: false,
  data: undefined,
};
const IDLE_PROJECT: ProjectQueryStub = {
  isLoading: false,
  isError: false,
  data: undefined,
};
const FAILED = err(READ_FAILED);

function sessionScope(overrides: Partial<SessionWalletScopeDto>): SessionWalletScopeDto {
  return {
    sessionId: SESSION,
    evm: null,
    solana: null,
    ...overrides,
  };
}

function walletRead(liveTotalUsd: number): WalletReadStub {
  const dto: PortfolioDto = {
    scope: "global",
    walletCount: 1,
    liveTotalUsd,
    snapshotTotalUsd: null,
    pnlVsPrev: null,
    snapshotAt: null,
    tokens: [],
    chains: [],
  };
  return { isLoading: false, isError: false, data: ok(dto) };
}

const UNRESOLVED_READ: WalletReadStub = {
  isLoading: true,
  isError: false,
  data: undefined,
};

function mountSession(data: SessionWalletScopeDto | null, isLoading = false) {
  mockUseSessionWallets.mockReturnValue({
    isLoading,
    isError: false,
    data: data === null ? undefined : ok(data),
  });
  mockUseProject.mockReturnValue(IDLE_PROJECT);
  return render(<WalletPairCard scope={{ kind: "session", sessionId: SESSION }} />);
}

function mountSessionState(state: SessionQueryStub) {
  mockUseSessionWallets.mockReturnValue(state);
  mockUseProject.mockReturnValue(IDLE_PROJECT);
  return render(<WalletPairCard scope={{ kind: "session", sessionId: SESSION }} />);
}

function projectDto(wallets: ProjectStub["wallets"]): ProjectStub {
  return { id: PROJECT, name: "Acme", wallets };
}

function mountProject(state: Partial<ProjectQueryStub>) {
  mockUseSessionWallets.mockReturnValue(IDLE_SESSION);
  mockUseProject.mockReturnValue({ ...IDLE_PROJECT, ...state });
  return render(<WalletPairCard scope={{ kind: "project", projectId: PROJECT }} />);
}

function bodyRows(): readonly HTMLTableRowElement[] {
  return [...document.querySelectorAll("tbody tr")].filter(
    (row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement,
  );
}

function cellsOf(row: HTMLTableRowElement): readonly string[] {
  return [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "");
}

function rowWith(text: string): HTMLTableRowElement {
  const row = bodyRows().find((candidate) => (candidate.textContent ?? "").includes(text));
  if (row === undefined) throw new Error(`no wallet row containing ${text}`);
  return row;
}

function copyFromMenu(rowName: string): void {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${rowName}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy address" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSessionWallets.mockReturnValue(IDLE_SESSION);
  mockUseProject.mockReturnValue(IDLE_PROJECT);
  mockUseWalletPortfolio.mockReturnValue(UNRESOLVED_READ);
  mockWriteClipboard.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WalletPairCard - session scope", () => {
  it("draws the Wallet, Address and Value table with a row per held family", () => {
    mountSession(
      sessionScope({
        evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" },
        solana: { walletId: "w-sol", address: SOL_ADDR, label: "" },
      }),
    );

    expect(screen.getByRole("region", { name: "Wallets" })).not.toBeNull();
    const table = document.querySelector('[data-vex-area="portfolio-wallets"]');
    expect(table?.tagName).toBe("TABLE");
    expect(
      [...document.querySelectorAll("thead th")].map((th) => th.textContent),
    ).toEqual(["Wallet", "Address", "Value", "Actions"]);
    expect(bodyRows()).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^Actions for/ })).toHaveLength(2);
  });

  it("shows the short address with the full one in its tooltip", () => {
    mountSession(
      sessionScope({
        evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" },
        solana: { walletId: "w-sol", address: SOL_ADDR, label: "" },
      }),
    );

    expect(screen.getByText(EVM_SHORT).getAttribute("title")).toBe(EVM_ADDR);
    expect(screen.getByText(SOL_SHORT).getAttribute("title")).toBe(SOL_ADDR);
  });

  it("shows the wallet's own label when set, else the family caption", () => {
    mountSession(
      sessionScope({
        evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" },
        solana: { walletId: "w-sol", address: SOL_ADDR, label: "" },
      }),
    );

    const [evmRow, solRow] = bodyRows();
    if (evmRow === undefined || solRow === undefined) throw new Error("rows missing");
    expect(cellsOf(evmRow)[0]).toBe("Trading");
    expect(cellsOf(solRow)[0]).toBe("SOL");
    // The pair is not the inventory: no Primary word, no Total row.
    expect(screen.queryByText(/Primary/)).toBeNull();
    expect(screen.queryByText("Total")).toBeNull();
  });

  it("falls back to the family caption alone for an unlabeled EVM wallet", () => {
    mountSession(
      sessionScope({ evm: { walletId: "w-evm", address: EVM_ADDR, label: "" } }),
    );
    expect(cellsOf(rowWith(EVM_SHORT))[0]).toBe("EVM");
  });

  it("renders NO row for an absent family", () => {
    mountSession(
      sessionScope({ evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" } }),
    );

    expect(bodyRows()).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Actions for/ })).toHaveLength(1);
    expect(screen.queryByText("SOL")).toBeNull();
    expect(screen.queryByText(SOL_SHORT)).toBeNull();
  });

  it("reads each row's value from that wallet's own read, Not available until it resolves", () => {
    mockUseWalletPortfolio.mockImplementation((address) =>
      address === EVM_ADDR ? walletRead(1234.56) : UNRESOLVED_READ,
    );
    mountSession(
      sessionScope({
        evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" },
        solana: { walletId: "w-sol", address: SOL_ADDR, label: "" },
      }),
    );

    expect(cellsOf(rowWith(EVM_SHORT))[2]).toBe("$1,234.56");
    expect(cellsOf(rowWith(SOL_SHORT))[2]).toBe("Not available");
    // A read that has not resolved is never a zero.
    expect(screen.queryByText("$0.00")).toBeNull();
    // Only the pair's own addresses are ever read, nothing wider.
    for (const [address] of mockUseWalletPortfolio.mock.calls) {
      expect([EVM_ADDR, SOL_ADDR]).toContain(address);
    }
  });

  it("is READ-ONLY - no picker, no Add wallet, only the row actions keys", () => {
    mountSession(
      sessionScope({
        evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" },
        solana: { walletId: "w-sol", address: SOL_ADDR, label: "Spend" },
      }),
    );

    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("aria-label")).toMatch(/^Actions for /);
    }
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add wallet/ })).toBeNull();

    // The one thing a row offers is copying its address.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Trading" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Copy address",
    ]);
  });

  it("copies the row's FULL address from its menu and confirms it in that row only", async () => {
    mountSession(
      sessionScope({
        evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" },
        solana: { walletId: "w-sol", address: SOL_ADDR, label: "Spend" },
      }),
    );

    copyFromMenu("Spend");

    expect(mockWriteClipboard).toHaveBeenCalledTimes(1);
    expect(mockWriteClipboard).toHaveBeenCalledWith(SOL_ADDR);
    await screen.findByText("Address copied");
    expect(rowWith(SOL_SHORT).textContent).toContain("Address copied");
    expect(rowWith(EVM_SHORT).textContent).not.toContain("Address copied");
    // The confirmation is a polite live region, one per row.
    const live = rowWith(SOL_SHORT).querySelector('[role="status"]');
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toBe("Address copied");
    expect(screen.getAllByRole("status")).toHaveLength(2);
  });

  it("never claims a copy the host refused", async () => {
    mockWriteClipboard.mockResolvedValue(false);
    mountSession(
      sessionScope({
        evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" },
      }),
    );

    copyFromMenu("Trading");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(mockWriteClipboard).toHaveBeenCalledWith(EVM_ADDR);
    expect(screen.queryByText("Address copied")).toBeNull();
  });

  it("clears the confirmation after its window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mountSession(
      sessionScope({
        evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" },
      }),
    );

    copyFromMenu("Trading");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Address copied")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText("Address copied")).toBeNull();
  });

  it("states the consequence when the session has no wallets at all", () => {
    mountSession(sessionScope({}));

    expect(
      screen.getByText("No wallets selected for this session - wallet tools stay disabled."),
    ).not.toBeNull();
    expect(document.querySelector('[data-vex-area="portfolio-wallets"]')).toBeNull();
  });

  it("says Loading while the pair is being read", () => {
    mountSession(null, true);

    expect(screen.getByText("Loading…")).not.toBeNull();
    expect(document.querySelector('[data-vex-area="portfolio-wallets"]')).toBeNull();
    expect(screen.queryByText(/wallet tools stay disabled/)).toBeNull();
  });

  it("a failed read or a transport error is the session's error line, never an empty pair", () => {
    mountSessionState({ isLoading: false, isError: false, data: FAILED });
    expect(screen.getByText("Couldn't load this session's wallets.")).not.toBeNull();
    expect(screen.queryByText(/wallet tools stay disabled/)).toBeNull();
    expect(bodyRows()).toHaveLength(0);
    cleanup();

    mountSessionState({ isLoading: false, isError: true, data: undefined });
    expect(screen.getByText("Couldn't load this session's wallets.")).not.toBeNull();
  });

  it("reads exactly the session's pair and never asks for a project", () => {
    mountSession(
      sessionScope({ evm: { walletId: "w-evm", address: EVM_ADDR, label: "Trading" } }),
    );

    for (const [sessionId] of mockUseSessionWallets.mock.calls) {
      expect(sessionId).toBe(SESSION);
    }
    for (const [projectId] of mockUseProject.mock.calls) {
      expect(projectId).toBeNull();
    }
  });
});

/**
 * PROJECT scope. The property that carries the risk: a project read the card
 * cannot answer for must land on the project's OWN error line. Nothing here
 * may reach the global wallet inventory - the card must never name a wallet
 * the project did not select.
 */
describe("WalletPairCard - project scope", () => {
  it("renders the project's own selected pair, unlabeled rows keeping the family caption", () => {
    mountProject({
      data: ok(
        projectDto({
          evm: { id: "evm_1", address: EVM_ADDR },
          solana: { id: "sol_1", address: SOL_ADDR },
        }),
      ),
    });

    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByText(EVM_SHORT).getAttribute("title")).toBe(EVM_ADDR);
    expect(screen.getByText(SOL_SHORT).getAttribute("title")).toBe(SOL_ADDR);
    expect(cellsOf(rowWith(EVM_SHORT))[0]).toBe("EVM");
    expect(cellsOf(rowWith(SOL_SHORT))[0]).toBe("SOL");
    expect(screen.queryByText(/Primary/)).toBeNull();
    expect(screen.queryByText("Total")).toBeNull();
  });

  it("renders only the family the project selected", () => {
    mountProject({
      data: ok(projectDto({ evm: null, solana: { id: "sol_1", address: SOL_ADDR } })),
    });

    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText(SOL_SHORT)).not.toBeNull();
    expect(screen.queryByText("EVM")).toBeNull();
  });

  it("never calls the session read for a project scope, and reads exactly that project", () => {
    mountProject({
      data: ok(projectDto({ evm: null, solana: null })),
    });

    // The hook is declared unconditionally for stable order, but with `null`
    // so no session query is ever issued for a project card.
    expect(mockUseSessionWallets.mock.calls.length).toBeGreaterThan(0);
    for (const [sessionId] of mockUseSessionWallets.mock.calls) {
      expect(sessionId).toBeNull();
    }
    expect(mockUseProject).toHaveBeenCalledWith(PROJECT);
  });

  it("reads each row's value from the project's own addresses only", () => {
    mockUseWalletPortfolio.mockImplementation((address) =>
      address === EVM_ADDR ? walletRead(500) : UNRESOLVED_READ,
    );
    mountProject({
      data: ok(
        projectDto({
          evm: { id: "evm_1", address: EVM_ADDR },
          solana: { id: "sol_1", address: SOL_ADDR },
        }),
      ),
    });

    expect(cellsOf(rowWith(EVM_SHORT))[2]).toBe("$500.00");
    expect(cellsOf(rowWith(SOL_SHORT))[2]).toBe("Not available");
    for (const [address] of mockUseWalletPortfolio.mock.calls) {
      expect([EVM_ADDR, SOL_ADDR]).toContain(address);
    }
  });

  it("is READ-ONLY here too, and copies the project wallet's full address", async () => {
    mountProject({
      data: ok(projectDto({ evm: { id: "evm_1", address: EVM_ADDR }, solana: null })),
    });

    expect(screen.queryByRole("button", { name: /Add wallet/ })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    copyFromMenu("EVM");

    expect(mockWriteClipboard).toHaveBeenCalledWith(EVM_ADDR);
    await screen.findByText("Address copied");
  });

  it("a FAILED project read renders the project's error line, never a wider list", () => {
    mountProject({
      data: err({ ...READ_FAILED, code: "projects.wallet_drift", domain: "projects", message: "drift" }),
    });

    expect(screen.getByText("Couldn't load this project's wallets.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
    expect(bodyRows()).toHaveLength(0);
    expect(mockUseWalletPortfolio).not.toHaveBeenCalled();
  });

  it("a transport error on the project read is the same error line", () => {
    mountProject({ isError: true, data: undefined });
    expect(screen.getByText("Couldn't load this project's wallets.")).not.toBeNull();
    expect(screen.queryByText(/No wallets selected for this project/)).toBeNull();
  });

  it("an unknown project id is an ERROR, not an empty pair", () => {
    // `projects.get` resolves to null for a stale selection. Reporting that as
    // "no wallets selected" would be a different, wrong statement.
    mountProject({ data: ok(null) });

    expect(screen.getByText("Couldn't load this project's wallets.")).not.toBeNull();
    expect(screen.queryByText(/No wallets selected for this project/)).toBeNull();
  });

  it("states the consequence when the project selected no wallets", () => {
    mountProject({ data: ok(projectDto({ evm: null, solana: null })) });

    expect(
      screen.getByText("No wallets selected for this project - wallet tools stay disabled."),
    ).not.toBeNull();
    expect(screen.queryByText(/this session/)).toBeNull();
    expect(document.querySelector('[data-vex-area="portfolio-wallets"]')).toBeNull();
  });

  it("says Loading while the project is being read", () => {
    mountProject({ isLoading: true, data: undefined });

    expect(screen.getByText("Loading…")).not.toBeNull();
    expect(screen.queryByText(/wallet tools stay disabled/)).toBeNull();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });
});
