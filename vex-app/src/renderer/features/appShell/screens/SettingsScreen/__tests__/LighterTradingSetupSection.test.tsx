/**
 * The Trading setup card as a person meets it, driven through the real hooks
 * over a stubbed `window.vex.settings` - the same bridge shape the preload
 * exposes.
 *
 * TWO PROPERTIES THIS SUITE OWNS, both of them measured failures of the first
 * implementation:
 *
 * 1. A market this account has no row for (BTC on an account that has only
 *    ever traded ETH) can be found, added and applied. The table stays the
 *    account's own markets; the picker spans every market the overview lists
 *    and browses without demanding a query first.
 * 2. An unresolved change survives the card. It is read from the overview,
 *    which reads main's durable intents table, so unmounting Settings and
 *    coming back still offers a Reconcile - and that Reconcile carries the
 *    INTENT ID main knows, not something this visit remembered.
 *
 * RED ON REVERT: hide the picker behind a typed query again and the browse
 * test loses its BTC button; read the unresolved list from component state
 * again and the remount test finds no Reconcile.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX } from "react";
import type { Result } from "@shared/ipc/result.js";
import type {
  ApplyLighterLeverageResult,
  LighterLeverageOverview,
  LighterLeverageProposal,
  LighterTradingLimits,
} from "@shared/schemas/lighter-trading-limits.js";
import { LighterTradingSetupSection } from "../LighterTradingSetupSection.js";
import { UNRESOLVED_TITLE } from "../lighter-trading-setup-copy.js";

/** The exact row shapes the overview contract carries, never a stand-in. */
type LeverageMarketRow = LighterLeverageOverview["markets"][number];
type UnresolvedRow = LighterLeverageOverview["unresolved"][number];

const WALLET = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";

const getLighterTradingLimits = vi.fn();
const setLighterTradingLimits = vi.fn();
const getLighterLeverageOverview = vi.fn();
const prepareLighterLeverage = vi.fn();
const confirmLighterLeverage = vi.fn();
const cancelLighterLeverage = vi.fn();
const reconcileLighterLeverage = vi.fn();

/** The account's own market: ETH has terms and an open position. */
const ETH_ROW: LeverageMarketRow = {
  marketId: 0,
  symbol: "ETH",
  current: {
    initialMarginFraction: 400,
    leverageDisplay: "25.00",
    marginMode: "cross",
    source: "position_row",
  },
  max: { initialMarginFraction: 200, leverageDisplay: "50.00" },
  openPosition: { size: "0.0050", side: "long" },
};

/** An active market this account has never touched: no row, market default. */
const BTC_ROW: LeverageMarketRow = {
  marketId: 1,
  symbol: "BTC",
  current: {
    initialMarginFraction: 5000,
    leverageDisplay: "2.00",
    marginMode: "cross",
    source: "market_default",
  },
  max: { initialMarginFraction: 200, leverageDisplay: "50.00" },
  openPosition: null,
};

function overview(
  unresolved: readonly UnresolvedRow[] = [],
  markets: readonly LeverageMarketRow[] = [ETH_ROW, BTC_ROW],
): Result<LighterLeverageOverview> {
  return {
    ok: true,
    data: {
      environment: "rhc",
      walletAddress: WALLET,
      accountIndex: 24226,
      vaultState: "unlocked",
      markets,
      omitted: { count: 0, reason: "none" },
      unresolved,
    },
  };
}

function limits(): Result<LighterTradingLimits> {
  return {
    ok: true,
    data: {
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 40,
      revision: 3,
    },
  };
}

function installBridge(): void {
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      settings: {
        getLighterTradingLimits,
        setLighterTradingLimits,
        getLighterLeverageOverview,
        prepareLighterLeverage,
        confirmLighterLeverage,
        cancelLighterLeverage,
        reconcileLighterLeverage,
      },
    },
  });
}

function renderCard(): { readonly unmount: () => void } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <LighterTradingSetupSection environment="rhc" walletAddress={WALLET} />
    </QueryClientProvider> as JSX.Element,
  );
  return { unmount: view.unmount };
}

beforeEach(() => {
  vi.clearAllMocks();
  getLighterTradingLimits.mockResolvedValue(limits());
  getLighterLeverageOverview.mockResolvedValue(overview());
  installBridge();
});

afterEach(cleanup);

it("adds a market this account has no terms on, and applies to it", async () => {
  renderCard();
  await screen.findByRole("button", { name: "Change leverage for ETH" });
  // BTC has no row of its own, so it is not in the table by default: the
  // account's markets are the table, every market is the picker.
  expect(screen.queryByRole("button", { name: "Change leverage for BTC" })).toBeNull();

  // No query typed. The picker browses, which is how a person discovers that
  // a market they have never traded can be configured at all.
  fireEvent.click(screen.getByRole("button", { name: "BTC" }));

  const row = screen.getByRole("row", { name: /BTC/ });
  expect(within(row).getByText("2x default")).not.toBeNull();
  expect(within(row).getByText("50x")).not.toBeNull();

  // Change opens the shared sheet; Apply there sends the selector.
  fireEvent.click(screen.getByRole("button", { name: "Change leverage for BTC" }));
  fireEvent.change(screen.getByLabelText("New leverage for BTC"), {
    target: { value: "25" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review leverage change for BTC" }));

  await waitFor(() => {
    expect(prepareLighterLeverage).toHaveBeenCalledWith({
      environment: "rhc",
      walletAddress: WALLET,
      marketId: 1,
      leverage: 25,
      marginMode: "cross",
    });
  });
});

it("keeps Confirm pending until the applied leverage has been read back", async () => {
  const proposal: Result<LighterLeverageProposal> = {
    ok: true,
    data: {
      kind: "proposal",
      proposalId: "proposal-refresh-1",
      environment: "rhc",
      walletAddress: WALLET,
      accountIndex: 24226,
      apiKeyIndex: 4,
      marketId: 0,
      symbol: "ETH",
      current: ETH_ROW.current,
      target: { initialMarginFraction: 200, leverageDisplay: "50.00", marginMode: "cross" },
      marketMinInitialMarginFraction: 200,
      openPosition: ETH_ROW.openPosition,
      observations: { liquidationPrice: null, openOrders: { count: 0 } },
      expiresAt: "2026-09-10T12:05:00.000Z",
    },
  };
  const applied: Result<ApplyLighterLeverageResult> = {
    ok: true,
    data: {
      status: "completed",
      intentId: "proposal-refresh-1",
      observed: {
        initialMarginFraction: 200,
        leverageDisplay: "50.00",
        marginMode: "cross",
        source: "position_row",
      },
    },
  };
  const refreshedEth: LeverageMarketRow = {
    ...ETH_ROW,
    current: applied.data.status === "completed" && applied.data.observed !== null
      ? applied.data.observed
      : ETH_ROW.current,
  };
  let releaseRefresh!: (value: Result<LighterLeverageOverview>) => void;
  const refresh = new Promise<Result<LighterLeverageOverview>>((resolve) => {
    releaseRefresh = resolve;
  });
  getLighterLeverageOverview
    .mockResolvedValueOnce(overview())
    .mockReturnValue(refresh);
  prepareLighterLeverage.mockResolvedValue(proposal);
  confirmLighterLeverage.mockReturnValue({ promise: Promise.resolve(applied), cancel: vi.fn() });

  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Change leverage for ETH" }));
  fireEvent.change(screen.getByLabelText("New leverage for ETH"), {
    target: { value: "50" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review leverage change for ETH" }));
  const confirm = await screen.findByRole("button", { name: "Confirm" });
  fireEvent.click(confirm);

  await waitFor(() => {
    expect(confirmLighterLeverage).toHaveBeenCalledWith({ proposalId: "proposal-refresh-1" });
    expect(getLighterLeverageOverview).toHaveBeenCalledTimes(2);
  });
  expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);

  releaseRefresh(overview([], [refreshedEth, BTC_ROW]));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });
  const refreshedRow = screen.getByRole("button", { name: "Change leverage for ETH" }).closest("tr");
  expect(refreshedRow).not.toBeNull();
  expect(within(refreshedRow as HTMLElement).getByText("50x cross")).not.toBeNull();
});

it("keeps an unresolved change after a remount and reconciles it by intent id", async () => {
  getLighterLeverageOverview.mockResolvedValue(
    overview([
      {
        intentId: "intent-9",
        marketId: 0,
        symbol: "ETH",
        executionState: "ambiguous",
        updatedAt: "2026-09-10T12:00:00.000Z",
      },
    ]),
  );
  const first = renderCard();
  const list = await screen.findByLabelText(UNRESOLVED_TITLE);
  expect(list.textContent).toContain("ETH");

  // The card is closed and opened again: nothing this visit remembered
  // survives, and the change must still be here.
  first.unmount();
  renderCard();
  const reconcile = await screen.findByRole("button", {
    name: "Reconcile the unresolved ETH change",
  });

  const settled: Result<ApplyLighterLeverageResult> = {
    ok: true,
    data: {
      status: "completed",
      intentId: "intent-9",
      observed: {
        initialMarginFraction: 400,
        leverageDisplay: "25.00",
        marginMode: "cross",
        source: "position_row",
      },
    },
  };
  reconcileLighterLeverage.mockResolvedValue(settled);
  fireEvent.click(reconcile);

  await waitFor(() => {
    expect(reconcileLighterLeverage).toHaveBeenCalledWith({ proposalId: "intent-9" });
  });
  // One outcome store, two surfaces: the market's row and the unresolved list
  // state the same answer rather than disagreeing about the same intent.
  const stated = await screen.findAllByText(
    "Applied. Lighter now reports 25x cross for ETH.",
  );
  expect(stated).toHaveLength(2);
});

it("says nothing about unresolved changes when there are none", async () => {
  renderCard();
  await screen.findByRole("button", { name: "Change leverage for ETH" });
  expect(screen.queryByLabelText(UNRESOLVED_TITLE)).toBeNull();
});

it("cancels the durable review before returning to the editable sheet", async () => {
  const proposal: Result<LighterLeverageProposal> = {
    ok: true,
    data: {
      kind: "proposal",
      proposalId: "proposal-cancel-1",
      environment: "rhc",
      walletAddress: WALLET,
      accountIndex: 24226,
      apiKeyIndex: 4,
      marketId: 0,
      symbol: "ETH",
      current: ETH_ROW.current,
      target: { initialMarginFraction: 200, leverageDisplay: "50.00", marginMode: "cross" },
      marketMinInitialMarginFraction: 200,
      openPosition: ETH_ROW.openPosition,
      observations: { liquidationPrice: null, openOrders: { count: 0 } },
      expiresAt: "2026-09-10T12:05:00.000Z",
    },
  };
  prepareLighterLeverage.mockResolvedValue(proposal);
  cancelLighterLeverage.mockResolvedValue({
    ok: true,
    data: { status: "cancelled", proposalId: "proposal-cancel-1" },
  });

  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Change leverage for ETH" }));
  fireEvent.change(screen.getByLabelText("New leverage for ETH"), {
    target: { value: "50" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review leverage change for ETH" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

  await waitFor(() => {
    expect(cancelLighterLeverage).toHaveBeenCalledWith({ proposalId: "proposal-cancel-1" });
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });
  expect((screen.getByLabelText("New leverage for ETH") as HTMLInputElement).value).toBe("50");
  expect(
    (screen.getByRole("button", { name: "Review leverage change for ETH" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it("offers Reconcile for an unanswered confirmation before the overview is read again", async () => {
  const proposal: Result<LighterLeverageProposal> = {
    ok: true,
    data: {
      kind: "proposal",
      proposalId: "proposal-77",
      environment: "rhc",
      walletAddress: WALLET,
      accountIndex: 24226,
      apiKeyIndex: 4,
      marketId: 0,
      symbol: "ETH",
      current: ETH_ROW.current,
      target: { initialMarginFraction: 200, leverageDisplay: "50.00", marginMode: "cross" },
      marketMinInitialMarginFraction: 200,
      openPosition: ETH_ROW.openPosition,
      observations: { liquidationPrice: null, openOrders: { count: 0 } },
      expiresAt: "2026-09-10T12:05:00.000Z",
    },
  };
  prepareLighterLeverage.mockResolvedValue(proposal);
  // The invocation never answers: main may still have signed, so the card must
  // offer the recorded id rather than invite a second attempt.
  // Rejected on a later turn, not eagerly: an already-rejected promise created
  // before the component attaches its handler is an artefact of the stub, not
  // of the path under test.
  confirmLighterLeverage.mockImplementation(() => ({
    promise: new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("the invocation never answered")), 0);
    }),
    cancel: vi.fn(),
  }));
  reconcileLighterLeverage.mockResolvedValue({
    ok: true,
    data: { status: "ambiguous", intentId: "proposal-77", reason: "no proof yet" },
  } satisfies Result<ApplyLighterLeverageResult>);

  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Change leverage for ETH" }));
  fireEvent.change(screen.getByLabelText("New leverage for ETH"), {
    target: { value: "50" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review leverage change for ETH" }));
  const confirm = await screen.findByRole("button", { name: "Confirm" });
  const openDialogs = document.querySelectorAll("dialog[open]");
  expect(openDialogs).toHaveLength(1);
  expect(openDialogs[0]?.hasAttribute("data-vex-lighter-leverage-confirm")).toBe(true);
  fireEvent.click(confirm);

  // The outcome lands back on the sheet and on the table row behind it; either
  // Reconcile is the same read.
  const [reconcile] = await screen.findAllByRole("button", { name: "Reconcile" });
  fireEvent.click(reconcile as HTMLElement);
  await waitFor(() => {
    expect(reconcileLighterLeverage).toHaveBeenCalledWith({ proposalId: "proposal-77" });
  });
});
