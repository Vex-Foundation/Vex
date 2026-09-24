import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LighterTradingEnvironment, LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import {
  lighterAccountSetupStatusQueryKey,
  useLighterAccountActivityRefresh,
  useLighterOnboardingChecklist,
  useLighterTradingAccount,
  useLighterTradingFills,
  useLighterTradingMarkets,
} from "../../../lib/api/lighter-trading.js";
import { useCreateSession, useSessionsList } from "../../../lib/api/sessions.js";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import type { AccountActions, LighterPositionRow } from "./AccountPanel.js";
import { deskSessionTitle, latestDeskSession } from "./desk-session.js";
import { shouldPresentLighterSetup } from "./lighter-setup-gate.js";
import {
  buildCancelAllOrdersMessage,
  buildReviewPositionMessage,
  buildWithdrawMessage,
} from "./desk-messages.js";
import { publishDeskSend } from "./desk-send-intent.js";
import { findLoadMarket, useDeskTicketLoadStore } from "./desk-ticket-load.js";
import { recordFunnelStep } from "./funnel.js";
import { accountRisk, portionOfSize, positionMetrics, type ClosePortion } from "./account-model.js";
import { buildChartLevels } from "./chart-levels.js";
import { marketSectionFor, type LighterMarketSection } from "./market-classification.js";
import { selectDefaultLighterMarket } from "./market-selection.js";
import { buildAskAboutDraftMessage, resolveTicketMargin, toDeskOrderDraft, type TradeDraft } from "./ticket-model.js";
import { useDeskLane } from "./useDeskLane.js";
import { useDeskStreams } from "./useDeskStreams.js";

/**
 * Everything the desk center reads and the actions it hands to its panels.
 * Environment, market and chart interval live in the analysis store so the
 * sidebar and chat rail see the same scope. Market data comes from
 * useDeskStreams and the approval round trip from useDeskLane; this hook
 * composes them with the account, the market list and the chat handoffs.
 */
export function useLighterDesk() {
  const queryClient = useQueryClient();
  const activeSessionId = useUiStore((state) => state.activeSessionId);
  const bookOpen = useUiStore((state) => state.bookOpen);
  const setBookOpen = useUiStore((state) => state.setBookOpen);
  const setSidebarNarrowExpanded = useUiStore((state) => state.setSidebarNarrowExpanded);
  const setShellRoute = useUiStore((state) => state.setShellRoute);
  const openCreateSession = useUiStore((state) => state.openCreateSession);
  const lighterSetupRequested = useUiStore((state) => state.lighterSetupRequested);
  const requestLighterSetup = useUiStore((state) => state.requestLighterSetup);
  const clearLighterSetupRequest = useUiStore((state) => state.clearLighterSetupRequest);
  const completeSessionCreate = useUiStore((state) => state.completeSessionCreate);
  const desk = useLighterAnalysisStore((state) => state.desk);
  const saveDesk = useLighterAnalysisStore((state) => state.saveDesk);
  const { environment, marketId, resolution, skipCloseConfirm } = desk;

  const [marketPickerOpen, setMarketPickerOpen] = useState(false);
  const [focusComposer, setFocusComposer] = useState(false);
  // The ticket's margin chip opens the leverage sheet over the desk.
  const [leverageOpen, setLeverageOpen] = useState(false);
  const pendingEnvironmentMarket = useRef<{
    readonly symbol: LighterTradingMarket["symbol"];
    readonly marketType: LighterTradingMarket["marketType"];
    readonly section: LighterMarketSection;
  } | null>(null);

  const marketsQuery = useLighterTradingMarkets(environment, true);
  const marketList = marketsQuery.data?.ok === true ? marketsQuery.data.data : null;
  const market = marketList?.markets.find((row) => row.marketId === marketId) ?? null;

  // Persisted market gone from this environment (or first visit): pick a stable default.
  useEffect(() => {
    if (marketList === null || market !== null) return;
    const preferred = pendingEnvironmentMarket.current;
    pendingEnvironmentMarket.current = null;
    const next = preferred === null
      ? selectDefaultLighterMarket("perp", marketList.markets)
      : marketList.markets.find((row) => row.symbol === preferred.symbol && row.marketType === preferred.marketType)
        ?? marketList.markets.find((row) => row.symbol === preferred.symbol)
        ?? selectDefaultLighterMarket(preferred.section, marketList.markets)
        ?? selectDefaultLighterMarket("perp", marketList.markets);
    if (next !== null) saveDesk({ marketId: next.marketId });
  }, [market, marketList, saveDesk]);

  const {
    snapshotQuery,
    snapshot,
    candleStream,
    publicMarketStream,
    book,
    lastPrice,
    dataFresh,
  } = useDeskStreams({ environment, market, resolution });

  // The same read the bottom dock makes; TanStack dedupes it by key.
  const accountQuery = useLighterTradingAccount(environment, true, activeSessionId);
  useLighterAccountActivityRefresh(environment, true);
  const account = accountQuery.data?.ok === true ? accountQuery.data.data : null;
  const available = account !== null && account.status !== "unavailable"
    ? account.summary?.availableBalance ?? null
    : null;
  const baseAvailable = market?.marketType === "spot" && account !== null && account.status !== "unavailable"
    ? account.assets.find((asset) => asset.assetId === market.baseAssetId)?.available ?? null
    : null;
  // What the ticket's Risk mode sizes against: collateral plus open PnL.
  const equity = account !== null && account.status !== "unavailable" ? accountRisk(account.summary).equity : null;
  // Why the account read came back empty, so the ticket and dock can say what to do.
  const accountGap = account !== null && account.status === "unavailable" ? account.unavailableReason : null;
  const settlementSymbol = environment === "core" ? "USDC" : "USDG";
  // The ticket gate's checklist; read only while there is no account to trade from.
  const checklistQuery = useLighterOnboardingChecklist(activeSessionId, environment, accountGap === "not_onboarded");
  const onboardingChecklist = checklistQuery.data?.ok === true ? checklistQuery.data.data : null;

  // The composer lives in the BOOK rail; wait for it to mount after opening.
  useEffect(() => {
    if (!focusComposer) return;
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Session draft"]');
    if (textarea === null) return;
    textarea.focus({ preventScroll: true });
    setFocusComposer(false);
  }, [focusComposer, bookOpen]);

  const margin = market === null ? null : resolveTicketMargin(market, account?.marginTerms ?? null);
  // The fee THIS account pays, which the ticket sizes every order against.
  const exchangeFees = account !== null && account.status !== "unavailable" ? account.exchangeFees ?? null : null;
  const chartMarketId = market?.marketId ?? null;
  const chartLevels = useMemo(
    () => (chartMarketId === null || account === null ? [] : buildChartLevels(chartMarketId, account.positions, account.openOrders)),
    [chartMarketId, account],
  );
  // Same query the account panel's Fills tab reads, so this adds no request.
  const fillsQuery = useLighterTradingFills(environment, chartMarketId !== null, activeSessionId);
  const fillsSnapshot = fillsQuery.data?.ok === true ? fillsQuery.data.data : null;
  const fills = fillsSnapshot?.fills ?? null;
  // Fill arrows only accompany an open position on this market; a flat chart stays clean.
  const positionOpen = chartMarketId !== null && (account?.positions.some((position) => position.marketId === chartMarketId) ?? false);
  const chartFills = useMemo(
    () => (chartMarketId === null || fills === null || !positionOpen ? [] : fills.filter((fill) => fill.marketId === chartMarketId)),
    [chartMarketId, fills, positionOpen],
  );

  const {
    approvals,
    focusApprovalId,
    ticketPrefill,
    setTicketPrefill,
    pricePick,
    setPricePick,
    handoffError,
    setHandoffError,
    submitting,
    prepareStage,
    deskOutcome,
    closingPositions,
    cancellingOrders,
    prepareOnDesk,
    onApprovalResolved,
  } = useDeskLane({
    activeSessionId,
    environment,
    marketId,
    marketSymbol: market?.symbol ?? null,
    skipCloseConfirm,
    account,
    fills: fillsSnapshot,
    onNoSession: openCreateSession,
  });

  // The market bar's Perps | Stocks | Spot control: the section's default
  // market, unless the desk is already on that section.
  const selectSection = (section: LighterMarketSection): void => {
    if (marketList === null || (market !== null && marketSectionFor(environment, market) === section)) return;
    const next = selectDefaultLighterMarket(
      section,
      marketList.markets.filter((row) => marketSectionFor(environment, row) === section),
    );
    if (next !== null) saveDesk({ marketId: next.marketId });
  };
  // Core | RHC market ids do not line up. Carry the visible symbol/type across
  // when the destination lists it; otherwise fall back within the same product.
  const selectEnvironment = (next: LighterTradingEnvironment): void => {
    if (next !== environment) {
      pendingEnvironmentMarket.current = market === null
        ? null
        : {
            symbol: market.symbol,
            marketType: market.marketType,
            section: marketSectionFor(environment, market),
          };
      saveDesk({ environment: next, marketId: null });
    }
  };
  const selectMarket = (next: LighterTradingMarket): void => {
    saveDesk({ marketId: next.marketId });
    setMarketPickerOpen(false);
  };

  // The ticket's Long/Short: the draft becomes a desk order card (design §7.11).
  const submitDraft = (draft: TradeDraft): void => {
    if (market === null) return;
    const closePosition = (draft.mode === "market" || draft.mode === "limit") && draft.reduceOnly
      ? account?.positions.find((position) => position.marketId === market.marketId
        && position.side === (draft.side === "sell" ? "long" : "short")) ?? null
      : null;
    void prepareOnDesk({ kind: "order", marketId: market.marketId, draft: toDeskOrderDraft(draft) }, draft, closePosition);
  };

  // Open Vex via ⌘K: the rail's composer is the only
  // place to type, so this opens the rail and puts the caret there.
  const askVex = (revealRail = true): void => {
    if (revealRail) setBookOpen(true);
    setSidebarNarrowExpanded(false);
    if (activeSessionId === null) {
      openCreateSession();
      return;
    }
    setFocusComposer(true);
  };

  // The ticket's second opinion: a question about the draft, sent now, with
  // nothing loaded into the composer and nothing prepared.
  const askAboutDraft = (draft: TradeDraft): void => {
    if (market === null) return;
    sendToChat(buildAskAboutDraftMessage({ environment, market, draft }));
  };

  // Row actions that still need the agent (Cancel all, Review, Deposit,
  // Withdraw, Connect) send immediately: the agent prepares the change and
  // the approval card is the only thing that can execute it (design §7.3 b).
  const sendToChat = (message: string): void => {
    setBookOpen(true);
    setSidebarNarrowExpanded(false);
    if (activeSessionId === null) {
      openCreateSession(message);
      return;
    }
    publishDeskSend(activeSessionId, message);
    setHandoffError(null);
  };

  // Set up Lighter: the account-setup modal runs deposit, trading key and fee
  // authorization as one deterministic chain (design: no agent turn decides
  // this fixed sequence) - see `LighterAccountSetupModal`. The desk gates the
  // live panel behind a set-up trading key: entering it without one (any of
  // the three entry points - "light it up", the BOOK rail's Lighter button, or
  // the Arena banner) presents this modal rather than a tradeable ticket.
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  // A manual close (the operator chose not to set up now) parks the auto-gate
  // for this not-onboarded episode, so it does not immediately reopen; a change
  // in onboarding state re-arms it.
  const setupGateDismissed = useRef(false);
  const connectLighter = (): void => {
    recordFunnelStep("desk_setup_start", environment);
    setupGateDismissed.current = false;
    requestLighterSetup();
  };
  const closeLighterSetup = (): void => {
    setupGateDismissed.current = true;
    setSetupModalOpen(false);
  };

  // The gate itself: no Lighter trading key for this wallet (`not_onboarded` is
  // env-only - vault unlocked, no key) arms setup. A locked vault, several
  // onboarded accounts, or a provider error are the desk's OWN gates (Unlock /
  // Settings / retry), never a missing key, so they never force setup.
  const setupGated = shouldPresentLighterSetup(accountGap);
  useEffect(() => {
    if (!setupGated) {
      setupGateDismissed.current = false;
      return;
    }
    if (setupGateDismissed.current) return;
    requestLighterSetup();
  }, [setupGated, requestLighterSetup]);

  // The modal's status read and the deposit -> key -> fee chain both need a
  // live desk session. A first-time (not-onboarded) trader has none and nothing
  // to resume, so mint ONE Lighter-workspace session with the desk defaults;
  // every later entry resumes THAT session (LighterChatRail), so the desk never
  // litters the sidebar. `provisioning` guards against a double create while
  // the mutation is in flight.
  const sessionsQuery = useSessionsList();
  const createDeskSession = useCreateSession();
  const resumableDeskSession = sessionsQuery.data?.ok === true
    ? latestDeskSession(sessionsQuery.data.data) !== null
    : null; // null: the list has not answered yet - wait, do not create
  const provisioning = useRef(false);
  useEffect(() => {
    if (!lighterSetupRequested || activeSessionId !== null) return;
    if (resumableDeskSession !== false || provisioning.current) return;
    provisioning.current = true;
    void (async () => {
      try {
        const created = await createDeskSession.mutateAsync({
          mode: "agent",
          name: market === null ? "Lighter" : deskSessionTitle(market.symbol),
          permission: "restricted",
          selectedEvmWalletId: null,
          selectedSolanaWalletId: null,
          workspace: "lighter",
        });
        if (created.ok) completeSessionCreate(created.data.id, null);
      } finally {
        provisioning.current = false;
      }
    })();
  }, [lighterSetupRequested, activeSessionId, resumableDeskSession, createDeskSession, completeSessionCreate, market]);

  // Open the modal the instant the desk has a session (resumed or just minted).
  // Consumed exactly once; leaving Lighter mode clears any unconsumed request
  // in `transitionRuntimeMode`, so it never fires on a later entry.
  useEffect(() => {
    if (!lighterSetupRequested || activeSessionId === null) return;
    setSetupModalOpen(true);
    clearLighterSetupRequest();
  }, [lighterSetupRequested, activeSessionId, clearLighterSetupRequest]);
  const onLighterSetupDone = (doneEnvironment: LighterTradingEnvironment): void => {
    if (activeSessionId !== null) {
      void queryClient.invalidateQueries({
        queryKey: lighterAccountSetupStatusQueryKey(doneEnvironment, activeSessionId),
      });
      void queryClient.invalidateQueries({ queryKey: ["lighterTrading", "onboarding", doneEnvironment, activeSessionId] });
    }
    void queryClient.invalidateQueries({ queryKey: ["lighterTrading", "account", doneEnvironment] });
    void queryClient.invalidateQueries({ queryKey: ["lighterTrading", "fills", doneEnvironment] });
    if (doneEnvironment !== environment) saveDesk({ environment: doneEnvironment });
  };

  // Settings morphs out of the button that asked for it (the dock's Open
  // Settings, the leverage chip); with no trigger it expands from the center
  // as before.
  const openTradingSettings = (event?: { readonly currentTarget: EventTarget | null }): void => {
    const rect = event?.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null;
    const origin = rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    setShellRoute({ kind: "settings", origin, section: "lighterPoints" });
  };

  const openPositionMarket = (position: LighterPositionRow): LighterTradingMarket | null => {
    if (market !== null && position.marketId === market.marketId) return market;
    const target = marketList?.markets.find((row) => row.marketId === position.marketId) ?? null;
    if (target !== null) saveDesk({ marketId: target.marketId });
    return target;
  };

  // A limit close rests at the mark: the live one on this desk, else the
  // snapshot's. Reduce-only, so it can only ever shrink the position. A
  // partial market close also loads here: main's close selector is the whole
  // position, so a portion goes out as a reduce-only market order instead.
  const prefillFromPosition = (position: LighterPositionRow, mode: "market" | "limit" | "oco", portion: ClosePortion = 1): void => {
    const target = openPositionMarket(position);
    if (target === null) return;
    const size = position.size.startsWith("-") ? position.size.slice(1) : position.size;
    const mark = positionMetrics(position, target === market ? publicMarketStream.stats?.markPrice ?? null : null).mark;
    setTicketPrefill({
      key: Date.now(),
      mode,
      side: position.side === "long" ? "sell" : "buy",
      baseAmount: portionOfSize(size, portion, target.decimals.size),
      reduceOnly: mode !== "oco",
      ...(mode === "limit" && mark !== null ? { price: mark.toFixed(target.decimals.price) } : {}),
    });
  };

  // A preview the agent ran lands in the ticket once its market is on this
  // desk: the environment switches first, then the list for it resolves the
  // market by id or symbol, and only then does the prefill fire.
  const pendingLoad = useDeskTicketLoadStore((state) => state.pending);
  const clearDeskTicketLoad = useDeskTicketLoadStore((state) => state.clearDeskTicketLoad);
  useEffect(() => {
    if (pendingLoad === null) return;
    if (pendingLoad.environment !== environment) {
      saveDesk({ environment: pendingLoad.environment });
      return;
    }
    if (marketList === null) return;
    const target = findLoadMarket(marketList.markets, pendingLoad);
    clearDeskTicketLoad();
    if (target === null) {
      setHandoffError(`${pendingLoad.marketSymbol ?? `Market ${pendingLoad.marketId}`} is not on this desk, so the preview was not loaded.`);
      return;
    }
    saveDesk({ marketId: target.marketId });
    setTicketPrefill({ key: pendingLoad.key, ...pendingLoad.prefill });
  }, [clearDeskTicketLoad, environment, marketList, pendingLoad, saveDesk]);

  const accountActions: AccountActions = {
    onReviewPosition: (position) => sendToChat(buildReviewPositionMessage({ environment, position })),
    onClosePosition: (position, portion) => {
      if (portion === 1) void prepareOnDesk({ kind: "close", marketId: position.marketId }, null, position);
      else prefillFromPosition(position, "market", portion);
    },
    onProtectPosition: (position) => prefillFromPosition(position, "oco"),
    onCloseLimit: (position, portion) => prefillFromPosition(position, "limit", portion),
    onOpenMarket: (position) => { openPositionMarket(position); },
    onRestoreCloseConfirm: () => saveDesk({ skipCloseConfirm: false }),
    onCancelOrder: (order) => { void prepareOnDesk({ kind: "cancel", marketId: order.marketId, orderId: order.orderId }, null); },
    onCancelAllOrders: (orders) =>
      sendToChat(buildCancelAllOrdersMessage({ environment, orderCount: orders.length })),
    // Deposit is the setup modal's own first step; Lighter has no
    // withdrawal tool, so that leg still walks the user through chat.
    onFund: (kind) => (kind === "deposit" ? connectLighter() : sendToChat(buildWithdrawMessage({ environment }))),
    onConnect: connectLighter,
    onOpenSettings: openTradingSettings,
  };

  return {
    accountGap,
    activeSessionId,
    environment,
    resolution,
    setResolution: (next: typeof resolution) => saveDesk({ resolution: next }),
    marketsQuery,
    marketList,
    market,
    selectEnvironment,
    selectMarket,
    selectSection,
    marketPickerOpen,
    setMarketPickerOpen,
    snapshotQuery,
    snapshot,
    candleStream,
    publicMarketStream,
    book,
    lastPrice,
    dataFresh,
    available,
    baseAvailable,
    equity,
    settlementSymbol,
    margin,
    exchangeFees,
    chartLevels,
    chartFills,
    approvals,
    focusApprovalId,
    ticketPrefill,
    pricePick,
    setPricePick,
    handoffError,
    submitting,
    prepareStage,
    deskOutcome,
    closingPositions,
    cancellingOrders,
    submitDraft,
    onApprovalResolved,
    skipCloseConfirm,
    setSkipCloseConfirm: (next: boolean) => saveDesk({ skipCloseConfirm: next }),
    askVex,
    askAboutDraft,
    connectLighter,
    setupModalOpen,
    closeLighterSetup,
    onLighterSetupDone,
    openTradingSettings,
    accountActions,
    accountIndex: account?.accountIndex ?? null,
    onboardingChecklist,
    leverageOpen,
    openLeverage: () => setLeverageOpen(true),
    closeLeverage: () => setLeverageOpen(false),
  };
}

export type LighterDesk = ReturnType<typeof useLighterDesk>;
