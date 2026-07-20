/**
 * Zustand UI-only store per skill §5.
 *
 * Layer rules:
 *  - Domain/IPC data lives in TanStack Query, NEVER here.
 *  - Persist whitelist is intentionally narrow (sidebarOpen). currentView
 *    is recomputed on launch; logBuffer is in-memory only.
 *  - logBuffer is bounded to MAX_RENDER_LOGS to honor skill §11 (no
 *    unbounded buffers).
 *
 * Shell theme (`theme`) IS persisted (partialize whitelist below): the
 * "Robinhood mode" flip (T2) is a deliberate user choice that must survive
 * relaunch. It drives the `data-vex-theme` attribute on the shell root, which
 * re-tints the whole app through the `--vex-accent*` tokens. Everything else
 * here stays UI-only per skill §5 (domain/IPC data belongs in TanStack Query).
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ReasoningEffort } from "@shared/schemas/chat.js";

export const MAX_RENDER_LOGS = 500;

/**
 * Shell colour theme. `vex` = the landing cobalt Signal Desk (default);
 * `robinhood` = the neon-lime "Robinhood mode". App-wide by construction —
 * the value rides on the shell root's `data-vex-theme` attribute.
 */
export type VexTheme = "vex" | "robinhood";

/**
 * Hypervexing workspace mode. This is a SEPARATE flag layered over `theme`,
 * NOT a third `VexTheme` value:
 *  - it is agent-driven and transient (entered via an agent tool push, exited
 *    via the in-mode EXIT control), so it must NOT persist — a relaunch always
 *    starts in `normal` mode (excluded from the persist whitelist below);
 *  - `data-vex-theme` is DERIVED from it in AppShell
 *    (`workspaceMode === "hypervexing" ? "hypervexing" : theme`), so EXIT
 *    restores the user's persisted theme (navy vs lime) exactly.
 * `theme` stays the user's own choice; the mode never overwrites it.
 */
export type WorkspaceMode = "normal" | "hypervexing";

/**
 * Which mission/plan review dialog (if any) the DESK RULE header cluster
 * (`MissionRail`) should show. Lifted out of `MissionRail`'s local state so a
 * DIFFERENT component in a different tree branch — `MissionControls`' "Review
 * & accept contract" bar, mounted in the session body, not the header — can
 * open the same dialog `MissionRail` owns. UI-ephemeral, NOT persisted: a
 * relaunch always starts with no dialog open. The single enum value keeps
 * mission/plan mutual exclusion for free (setting one closes the other).
 */
export type ReviewModal = "none" | "mission" | "plan";

export type View =
  | "splash"
  | "systemCheck"
  | "dockerBootstrap"
  | "composeBootstrap"
  | "migrations"
  | "wizard"
  | "unlock"
  | "appShell";

export type WizardEntryMode = "setup" | "reconfigure";
export type UnlockReturnView = "wizard" | "appShell";
export type SessionModeFilter = "all" | "agent" | "mission";
/**
 * Sub-view of the app shell panel area. `session` is the default chat/
 * welcome panel; `sessionsLibrary` is the dedicated "browse all sessions"
 * screen; `memory` is the read-only long-term + session-memory panel.
 * Settings is NOT a sub-view — the Settings button opens the onboarding
 * wizard (reconfigure). NOT persisted — launch-ephemeral, like activeSessionId.
 */
export type AppShellView =
  | "session"
  | "sessionsLibrary"
  // Read-only long-term + session-memory panel (stage 7-2a, S9 rewire).
  | "memory"
  // Read-only mission results ledger (WP-J).
  | "missionHistory";

export interface UiLogEntry {
  readonly id: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly ts: number;
}

/**
 * A first message handed off from the welcome→create flow to the just-created
 * session's composer, which owns the actual `chat.submit` (and its success/
 * failure UX) so a failed first send is visible + recoverable, never lost.
 */
export interface PendingFirstMessage {
  readonly sessionId: string;
  readonly message: string;
}

interface UiState {
  /**
   * Shell colour theme, persisted so "Robinhood mode" survives relaunch.
   * Defaults to `vex` (the cobalt Signal Desk).
   */
  readonly theme: VexTheme;
  /**
   * Hypervexing workspace mode. Defaults to `normal` and is NOT persisted
   * (see partialize) — a relaunch always starts in `normal`, never inside the
   * mode. Drives the DERIVED `data-vex-theme` in AppShell without touching the
   * user's own `theme`.
   */
  readonly workspaceMode: WorkspaceMode;
  readonly sidebarOpen: boolean;
  /**
   * The on-demand right-side BOOK panel (per-session instrument: MOVES /
   * RUNTIME / SESSION / POSITION). Defaults CLOSED — unlike sidebarOpen — and is
   * persisted so the user's choice survives relaunch.
   */
  readonly bookOpen: boolean;
  readonly currentView: View;
  readonly wizardEntryMode: WizardEntryMode;
  readonly unlockReturnView: UnlockReturnView;
  readonly logBuffer: ReadonlyArray<UiLogEntry>;
  readonly sessionModeFilter: SessionModeFilter;
  /**
   * Currently-selected session in the app shell sidebar. `null` means
   * the welcome state is shown (no session opened yet). NOT persisted —
   * session selection is launch-ephemeral; domain data still lives in
   * TanStack Query.
   */
  readonly activeSessionId: string | null;
  readonly appShellView: AppShellView;
  /**
   * New-session modal state + the first message typed in the welcome
   * composer that should seed creation. NOT persisted (see partialize).
   */
  readonly createSessionOpen: boolean;
  readonly createSessionInitialMessage: string | null;
  readonly pendingFirstMessage: PendingFirstMessage | null;
  /**
   * Signing-stroke state for the sidebar's New-session key: "signing"
   * while the create mutation is in flight (the ink loop runs), "signed"
   * for the one-shot success glint, then back to "idle" when the glint's
   * animationend fires. UI-only, NOT persisted (see partialize).
   */
  readonly signingState: "idle" | "signing" | "signed";
  /**
   * Per-session reasoning-effort choice for the composer's REASON control
   * (S6). Absent key = engine default ("medium"). NOT persisted —
   * launch-ephemeral by design (see partialize), so a fresh launch starts
   * every session back at the default; the engine owns the real default.
   */
  readonly reasoningEffortBySession: Readonly<Record<string, ReasoningEffort>>;
  /**
   * Hypervexing market-picker favorites (starred coins). Persisted — a
   * trader's watch set is a deliberate choice that must survive relaunch.
   * Pure UI preference: rows come from the markets query, this only stars.
   */
  readonly hlFavorites: readonly string[];
  /**
   * Mission runs whose finished summary card the operator has dismissed
   * from the Missions view.
   *
   * VIEW STATE ONLY. Dismissing hides a card the user has already read; it
   * does NOT delete, archive or otherwise touch the `mission_results`
   * ledger row, the `mission_runs` record, or any trade. That data is the
   * audit trail of real-money trades and stays intact — the register totals
   * above the list still count every dismissed run, and "Show hidden"
   * brings the cards back.
   *
   * Persisted (like `hlFavorites`) so a dismissed card does not reappear on
   * every relaunch.
   */
  readonly dismissedMissionRunIds: readonly string[];
  /** See `ReviewModal`. NOT persisted — see partialize. */
  readonly reviewModal: ReviewModal;
  readonly setTheme: (value: VexTheme) => void;
  readonly toggleTheme: () => void;
  readonly setWorkspaceMode: (value: WorkspaceMode) => void;
  readonly setSidebarOpen: (value: boolean) => void;
  readonly setBookOpen: (value: boolean) => void;
  readonly toggleBook: () => void;
  readonly setSessionModeFilter: (value: SessionModeFilter) => void;
  readonly setCurrentView: (value: View) => void;
  readonly openWizard: (mode: WizardEntryMode) => void;
  readonly openUnlock: (returnView: UnlockReturnView) => void;
  readonly setActiveSessionId: (value: string | null) => void;
  readonly setAppShellView: (value: AppShellView) => void;
  /** Open the new-session modal, optionally seeding the first message. */
  readonly openCreateSession: (initialMessage?: string | null) => void;
  /** Close the modal + clear its draft. Does NOT touch pendingFirstMessage. */
  readonly closeCreateSession: () => void;
  readonly setPendingFirstMessage: (value: PendingFirstMessage) => void;
  readonly clearPendingFirstMessage: () => void;
  readonly setSessionReasoningEffort: (
    sessionId: string,
    effort: ReasoningEffort,
  ) => void;
  readonly setSigningState: (value: "idle" | "signing" | "signed") => void;
  readonly toggleHlFavorite: (coin: string) => void;
  /** Hide one finished mission's card. Never touches persisted mission data. */
  readonly dismissMissionRun: (missionRunId: string) => void;
  /** Bring every dismissed mission card back into the list. */
  readonly restoreDismissedMissionRuns: () => void;
  readonly setReviewModal: (value: ReviewModal) => void;
  readonly appendLog: (entry: UiLogEntry) => void;
  readonly clearLogs: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "vex",
      workspaceMode: "normal",
      sidebarOpen: true,
      bookOpen: true,
      currentView: "splash",
      wizardEntryMode: "setup",
      unlockReturnView: "appShell",
      logBuffer: [],
      sessionModeFilter: "all",
      activeSessionId: null,
      appShellView: "session",
      createSessionOpen: false,
      createSessionInitialMessage: null,
      pendingFirstMessage: null,
      signingState: "idle",
      reasoningEffortBySession: {},
      hlFavorites: [],
      dismissedMissionRunIds: [],
      reviewModal: "none",
      setTheme: (theme) => set({ theme }),
      toggleTheme: () =>
        set((state) => ({ theme: state.theme === "vex" ? "robinhood" : "vex" })),
      setWorkspaceMode: (workspaceMode) => set({ workspaceMode }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setBookOpen: (bookOpen) => set({ bookOpen }),
      toggleBook: () => set((state) => ({ bookOpen: !state.bookOpen })),
      setSessionModeFilter: (sessionModeFilter) => set({ sessionModeFilter }),
      setCurrentView: (currentView) => set({ currentView }),
      openWizard: (wizardEntryMode) =>
        set({ currentView: "wizard", wizardEntryMode }),
      openUnlock: (unlockReturnView) =>
        set({ currentView: "unlock", unlockReturnView }),
      setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
      setAppShellView: (appShellView) => set({ appShellView }),
      openCreateSession: (initialMessage = null) => {
        const trimmed =
          typeof initialMessage === "string" ? initialMessage.trim() : "";
        set({
          createSessionOpen: true,
          createSessionInitialMessage: trimmed.length > 0 ? trimmed : null,
        });
      },
      closeCreateSession: () =>
        set({ createSessionOpen: false, createSessionInitialMessage: null }),
      setPendingFirstMessage: (pendingFirstMessage) =>
        set({ pendingFirstMessage }),
      clearPendingFirstMessage: () => set({ pendingFirstMessage: null }),
      setSessionReasoningEffort: (sessionId, effort) =>
        set((state) => ({
          reasoningEffortBySession: {
            ...state.reasoningEffortBySession,
            [sessionId]: effort,
          },
        })),
      setSigningState: (signingState) => set({ signingState }),
      toggleHlFavorite: (coin) =>
        set((state) => ({
          hlFavorites: state.hlFavorites.includes(coin)
            ? state.hlFavorites.filter((c) => c !== coin)
            : [...state.hlFavorites, coin],
        })),
      dismissMissionRun: (missionRunId) =>
        set((state) =>
          state.dismissedMissionRunIds.includes(missionRunId)
            ? state
            : {
                dismissedMissionRunIds: [
                  ...state.dismissedMissionRunIds,
                  missionRunId,
                ],
              },
        ),
      restoreDismissedMissionRuns: () => set({ dismissedMissionRunIds: [] }),
      setReviewModal: (reviewModal) => set({ reviewModal }),
      appendLog: (entry) =>
        set((state) => ({
          logBuffer: [...state.logBuffer, entry].slice(-MAX_RENDER_LOGS),
        })),
      clearLogs: () => set({ logBuffer: [] }),
    }),
    {
      name: "vex-ui",
      version: 5,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        sidebarOpen: state.sidebarOpen,
        bookOpen: state.bookOpen,
        hlFavorites: state.hlFavorites,
        dismissedMissionRunIds: state.dismissedMissionRunIds,
      }),
      // Expand-only migrations, oldest first:
      //   v2: BOOK now opens by default — force it open once on upgrade from v1
      //       so existing installs pick up the new default (later toggles
      //       persist normally).
      //   v3: `theme` added — seed the cobalt default so a pre-theme install
      //       hydrates into `vex`, not `undefined`.
      //   v4: `hlFavorites` added (Hypervexing market-picker stars) — seed [].
      //   v5: `dismissedMissionRunIds` added (hidden mission cards) — seed [].
      migrate: (persisted, version) => {
        if (persisted === null || typeof persisted !== "object") {
          return persisted;
        }
        let next = persisted as Record<string, unknown>;
        if (version < 2) next = { ...next, bookOpen: true };
        if (version < 3 && !("theme" in next)) next = { ...next, theme: "vex" };
        if (version < 4 && !("hlFavorites" in next)) {
          next = { ...next, hlFavorites: [] };
        }
        if (version < 5 && !("dismissedMissionRunIds" in next)) {
          next = { ...next, dismissedMissionRunIds: [] };
        }
        return next;
      },
      // localStorage is user-writable (untrusted input), and `migrate` only
      // runs on version hops — a hand-edited current-version payload skips it.
      // Coerce on EVERY rehydrate: an off-union `theme` degrades to the cobalt
      // default instead of reaching `data-vex-theme` / `SKY_ACCENTS[theme]`
      // (SignalSky indexes accents by theme and would crash on `undefined`).
      merge: (persisted, current) => {
        const incoming =
          persisted !== null && typeof persisted === "object"
            ? (persisted as Partial<UiState>)
            : undefined;
        const theme: VexTheme =
          incoming?.theme === "robinhood" ? "robinhood" : "vex";
        // Same hand-edited-payload coercion for the favorites list: anything
        // that is not a string array degrades to no stars, never a crash.
        const hlFavorites: readonly string[] = Array.isArray(
          incoming?.hlFavorites,
        )
          ? incoming.hlFavorites.filter(
              (coin): coin is string => typeof coin === "string",
            )
          : [];
        // Same coercion for the dismissed list — a hand-edited payload can
        // only ever cost the user a hidden card, never a crash.
        const dismissedMissionRunIds: readonly string[] = Array.isArray(
          incoming?.dismissedMissionRunIds,
        )
          ? incoming.dismissedMissionRunIds.filter(
              (id): id is string => typeof id === "string",
            )
          : [];
        return {
          ...current,
          ...incoming,
          theme,
          hlFavorites,
          dismissedMissionRunIds,
        };
      },
    }
  )
);
