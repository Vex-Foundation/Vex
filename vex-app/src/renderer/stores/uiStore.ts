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
 * Theme: the persisted slot is `themePreference` ("chronos" | "celeris" |
 * "system"); `theme` is the RESOLVED value driving `data-vex-theme` on
 * documentElement (runtime logic in uiStore/theme.ts; pre-paint twin in
 * public/theme-boot.js). Everything else here stays UI-only per skill §5
 * (domain/IPC data belongs in TanStack Query).
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ReasoningEffort } from "@shared/schemas/chat.js";

export const MAX_RENDER_LOGS = 500;

/**
 * Theme runtime types + logic live in the same-named sibling module
 * (`uiStore/theme.ts`); re-exported so the store stays the single public
 * entry point. `theme` is the RESOLVED value that rides on documentElement's
 * `data-vex-theme`; `themePreference` is the persisted user choice
 * ("system" tracks the OS scheme live).
 */
export type { VexTheme, VexThemePreference } from "./uiStore/theme.js";
export type { RuntimeMode } from "./uiStore/runtime-mode.js";

import {
  applyThemeToDocument,
  bindSystemThemeListener,
  DEFAULT_THEME_PREFERENCE,
  resolveTheme,
  systemPrefersDark,
  type VexTheme,
  type VexThemePreference,
} from "./uiStore/theme.js";
import {
  clampBookWidth,
  clampSidebarWidth,
  DEFAULT_BOOK_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
} from "./uiStore/layout.js";
import {
  mergeUiState,
  migrateUiState,
  partializeUiState,
} from "./uiStore/persistence.js";
import {
  DEFAULT_RUNTIME_MODE,
  type RuntimeMode,
} from "./uiStore/runtime-mode.js";

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

// Single-member since Decision C retired the reconfigure-wizard door —
// Settings now owns every back-edit form (export lives only there). The type
// and the openWizard(mode) plumbing survive so re-adding a launch mode later
// stays a one-line widening, not a re-wire.
export type WizardEntryMode = "setup";
export type UnlockReturnView = "wizard" | "appShell";
export type SessionModeFilter = "all" | "agent" | "mission";

/**
 * The shell-screen route contract lives in the same-named sibling module
 * (`uiStore/shell-route.ts`) and is re-exported here so this store stays the
 * single public entry point for every consumer's import.
 */
export type {
  ShellRoute,
  ShellRouteReturnTo,
  ShellRouteToken,
  ShellScreenOrigin,
  SettingsSection,
} from "./uiStore/shell-route.js";
export { RETURN_TO_SHELL } from "./uiStore/shell-route.js";

import type { ShellRoute } from "./uiStore/shell-route.js";

/** The BOOK panel's two instruments. See `UiState.bookTab`. */
export type BookTab = "portfolio" | "board";

export interface UiLogEntry {
  readonly id: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly ts: number;
}

/**
 * A first message — plus the reasoning effort SNAPSHOTTED at Send press, if
 * any — handed off from the welcome→create flow to the just-created
 * session's composer, which owns the actual `chat.submit` (and its success/
 * failure UX) so a failed first send is visible + recoverable, never lost.
 * `reasoningEffort` is REQUIRED-nullable: `null` is a DEFINITE omission (the
 * model capability hadn't resolved yet when Send was pressed, or the
 * eventual session turned out to be mission-mode — `SessionCreator` gates
 * that before `completeSessionCreate`), never "no opinion yet" — the
 * composer's hand-off never recomputes it.
 */
export interface CreateSessionInitialTurn {
  readonly message: string;
  readonly reasoningEffort: ReasoningEffort | null;
}

export interface UiState {
  /** Resolved shell theme = f(themePreference, OS scheme). NOT persisted. */
  readonly theme: VexTheme;
  /** Persisted theme choice; "system" re-resolves on OS scheme changes. */
  readonly themePreference: VexThemePreference;
  /** vex-studio seam: no UI logic reads this yet. NOT persisted. */
  readonly runtimeMode: RuntimeMode;
  readonly sidebarOpen: boolean;
  /**
   * Persisted sidebar drag width (px, clamped 264-420). The rendered track is
   * solved by `lib/shell-columns.ts`; this is only the preference input.
   */
  readonly sidebarWidth: number;
  /** Persisted BOOK drag width (px, clamped 300-520). See `sidebarWidth`. */
  readonly bookWidth: number;
  /**
   * Below the auto-collapse breakpoint the sidebar renders the rail unless
   * the user manually re-expands it; this is that override. NOT persisted —
   * a relaunch under a narrow window starts back at the rail.
   */
  readonly sidebarNarrowExpanded: boolean;
  /**
   * The on-demand right-side BOOK panel (per-session instrument: MOVES /
   * RUNTIME / SESSION / POSITION). Defaults CLOSED — unlike sidebarOpen — and is
   * persisted so the user's choice survives relaunch.
   */
  readonly bookOpen: boolean;
  readonly currentView: View;
  /**
   * The Chronos Gate boot overlay (features/setup/SetupGate). `true` from
   * first paint until the launch pipeline resolves and the curtain reveal
   * completes — then dismissed for the rest of the process. NOT persisted.
   */
  readonly setupGateActive: boolean;
  /**
   * Bumped by the dev Setup Tour to replay the gate's cinematic prologue on
   * demand. It is the remount key for `ChronosGate` in App, which is what
   * makes a second click replay from the first frame rather than no-op.
   * Dev-only in practice (the tour is build-flag gated). NOT persisted.
   */
  readonly prologueReplayNonce: number;
  /**
   * The unlock-success exit curtain (features/setup/CurtainExit, mounted by
   * App): `true` from a successful unlock IPC until the cobalt curtain has
   * covered the screen, flipped `currentView` to `unlockReturnView`, and
   * split open over the revealed view. No cancel path. NOT persisted.
   */
  readonly unlockCurtainActive: boolean;
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
  /** See `ShellRoute`. NOT persisted (see partialize). */
  readonly shellRoute: ShellRoute;
  /**
   * @deprecated Dead compat keys: sibling test suites frozen by the
   * concurrent fix round still reset `{ shellScreen: "none",
   * shellScreenOrigin: null }` via `setState`. Typed to EXACTLY those reset
   * literals so any live (non-reset) use fails the compiler. Never read,
   * never set by the store itself — remove once the fix round lands and the
   * frozen suites migrate to `shellRoute`.
   */
  readonly shellScreen?: "none";
  /** @deprecated See `shellScreen` above. */
  readonly shellScreenOrigin?: null;
  /**
   * New-session modal state + the first message (+ snapshotted reasoning
   * effort) typed in the welcome composer that should seed creation. NOT
   * persisted (see partialize).
   */
  readonly createSessionOpen: boolean;
  readonly createSessionInitialTurn: CreateSessionInitialTurn | null;
  /**
   * Signing-stroke state for the sidebar's New-session key: "signing"
   * while the create mutation is in flight (the ink loop runs), "signed"
   * for the one-shot success glint, then back to "idle" when the glint's
   * animationend fires. UI-only, NOT persisted (see partialize).
   */
  readonly signingState: "idle" | "signing" | "signed";
  /**
   * Per-session reasoning-effort choice for the composer's effort selector.
   * Absent key does NOT mean omission by itself: with a VISIBLE selector
   * (capability non-null, agent session) the submit always carries the
   * computed dynamic default (`selectDefaultReasoningEffort`); the field is
   * omitted only when the capability is null or the session is not
   * eligible (mission/unresolved). There is no store-level or engine-level
   * "medium" fallback. NOT persisted — launch-ephemeral by design (see
   * partialize), so a fresh launch re-derives from the model's default.
   */
  readonly reasoningEffortBySession: Readonly<Record<string, ReasoningEffort>>;
  /** See `ReviewModal`. NOT persisted — see partialize. */
  readonly reviewModal: ReviewModal;
  /**
   * Hide-dust display preference for the welcome Portfolio tab's token
   * lists (Balances card + All-assets screen): rows priced below the
   * sub-cent `MIN_DISPLAY_USD` threshold are hidden when true (unpriced
   * rows always stay visible — no price is not the same as zero value).
   * Defaults to TRUE — the owner's wallets collect priced-at-$0 Solana
   * spam airdrops, so dust is hidden out of the box. The All-assets screen
   * owns the only control; BalancesCard silently follows this preference.
   * Persisted (see partialize) — a relaunch keeps the user's choice.
   */
  readonly hideDustBalances: boolean;
  /**
   * OS-native turn-complete notifications (A34). TRUE by default; the
   * settings surface owns the toggle. Persisted (see partialize) and coerced
   * on every rehydrate - the payload is user-writable localStorage.
   */
  readonly notificationsEnabled: boolean;
  /**
   * User's custom order for the session-stage BOOK rail sections. `[]` means
   * "no custom order — use the default". Stored as an ID LIST, never component
   * references, so a renamed component cannot invalidate a saved layout, and an
   * unknown id from an older/newer build is simply dropped by
   * `resolveBookSectionOrder`. COSMETIC, so it stays in the renderer's persist
   * whitelist and never crosses IPC (this store's Zustand persist is the only
   * sanctioned renderer localStorage path — `check-build-artifacts.mjs`).
   */
  readonly bookSectionOrder: readonly string[];
  /**
   * Which BOOK tab is selected: the portfolio instrument or the board.
   *
   * A RAIL PREFERENCE, in the same class as `bookOpen` and
   * `bookSectionOrder`: persisted, so the panel comes back the way the user
   * left it.
   *
   * NEVER WRITTEN PROGRAMMATICALLY. A newly composed board does not switch
   * the reader's panel out from under them; it lights the unseen dot in
   * `board-surface-store` and waits to be chosen. `setBookTab` exists for the
   * tab control and for nothing else.
   */
  readonly bookTab: BookTab;
  /** Set the theme choice: resolves + writes documentElement in one step. */
  readonly setThemePreference: (value: VexThemePreference) => void;
  readonly setSidebarOpen: (value: boolean) => void;
  /** Live drag write: clamps into the sidebar contract range. */
  readonly setSidebarWidth: (px: number) => void;
  /** Live drag write: clamps into the BOOK contract range. */
  readonly setBookWidth: (px: number) => void;
  readonly setSidebarNarrowExpanded: (value: boolean) => void;
  readonly setBookOpen: (value: boolean) => void;
  readonly toggleBook: () => void;
  readonly setSessionModeFilter: (value: SessionModeFilter) => void;
  readonly setCurrentView: (value: View) => void;
  /** One-way: the boot gate unmounts for the rest of the process. */
  readonly dismissSetupGate: () => void;
  /** Re-arm the boot gate and replay its full prologue (dev Setup Tour). */
  readonly replayPrologue: () => void;
  /** Arm the unlock-success curtain — called ONLY after the unlock IPC succeeds. */
  readonly beginUnlockCurtain: () => void;
  /** The curtain finished its reveal and unmounts. */
  readonly dismissUnlockCurtain: () => void;
  readonly openWizard: (mode: WizardEntryMode) => void;
  readonly openUnlock: (returnView: UnlockReturnView) => void;
  readonly setActiveSessionId: (value: string | null) => void;
  /**
   * Replace the shell-screen route atomically — open a screen (with its
   * trigger-rect origin and any payload) or close with `{ kind: "none" }`.
   * The route union carries origin + payload per kind, so a screen and its
   * payload can never desync (there is nothing to clear separately).
   */
  readonly setShellRoute: (route: ShellRoute) => void;
  /**
   * Open the new-session modal, optionally seeding the first message and
   * the reasoning effort SNAPSHOTTED at Send press (welcome stage only — a
   * plain "New session" open from the sidebar passes neither).
   */
  readonly openCreateSession: (
    initialMessage?: string | null,
    reasoningEffort?: ReasoningEffort | null,
  ) => void;
  /**
   * Close the modal — Cancel, Escape, or backdrop dismiss. Discards
   * `createSessionInitialTurn` too: an abandoned draft must never ride into
   * whichever session the operator opens next. Never called on the SUCCESS
   * path (see `completeSessionCreate`), which needs the turn to survive
   * into the new composer's hand-off.
   */
  readonly closeCreateSession: () => void;
  /**
   * Single atomic transition on a successful session create: installs the
   * MODE-GATED final reasoning effort into `createSessionInitialTurn`
   * (message unchanged; mission-mode callers pass `null` — mission turns
   * never carry the field), closes the modal, and activates the new
   * session — one `set()` so the newly-mounted composer never observes a
   * half-applied state. Does NOT seed `reasoningEffortBySession`: the
   * composer's own hand-off effect does that (the same place
   * `handleReasoningPick` writes it) once it actually consumes the turn.
   */
  readonly completeSessionCreate: (
    sessionId: string,
    reasoningEffort: ReasoningEffort | null,
  ) => void;
  /**
   * Consumed-once clear, called by the newly-created session's composer
   * after it reads `createSessionInitialTurn` and fires the hand-off submit.
   */
  readonly clearCreateSessionInitialTurn: () => void;
  readonly setSessionReasoningEffort: (
    sessionId: string,
    effort: ReasoningEffort,
  ) => void;
  readonly setSigningState: (value: "idle" | "signing" | "signed") => void;
  readonly setReviewModal: (value: ReviewModal) => void;
  readonly setHideDustBalances: (value: boolean) => void;
  readonly setNotificationsEnabled: (value: boolean) => void;
  readonly setBookSectionOrder: (order: readonly string[]) => void;
  /** User-driven only: the tab control calls this and nothing else does. */
  readonly setBookTab: (tab: BookTab) => void;
  readonly appendLog: (entry: UiLogEntry) => void;
  readonly clearLogs: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: resolveTheme(DEFAULT_THEME_PREFERENCE, systemPrefersDark()),
      themePreference: DEFAULT_THEME_PREFERENCE,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      setThemePreference: (themePreference) => {
        const theme = resolveTheme(themePreference, systemPrefersDark());
        applyThemeToDocument(theme);
        set({ themePreference, theme });
      },
      sidebarOpen: true,
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      bookWidth: DEFAULT_BOOK_WIDTH,
      sidebarNarrowExpanded: false,
      bookOpen: true,
      currentView: "splash",
      setupGateActive: true,
      prologueReplayNonce: 0,
      unlockCurtainActive: false,
      wizardEntryMode: "setup",
      unlockReturnView: "appShell",
      logBuffer: [],
      sessionModeFilter: "all",
      activeSessionId: null,
      shellRoute: { kind: "none" },
      createSessionOpen: false,
      createSessionInitialTurn: null,
      signingState: "idle",
      reasoningEffortBySession: {},
      reviewModal: "none",
      hideDustBalances: true,
      notificationsEnabled: true,
      bookSectionOrder: [],
      bookTab: "portfolio",
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setSidebarWidth: (px) => set({ sidebarWidth: clampSidebarWidth(px) }),
      setBookWidth: (px) => set({ bookWidth: clampBookWidth(px) }),
      setSidebarNarrowExpanded: (sidebarNarrowExpanded) =>
        set({ sidebarNarrowExpanded }),
      setBookOpen: (bookOpen) => set({ bookOpen }),
      toggleBook: () => set((state) => ({ bookOpen: !state.bookOpen })),
      setSessionModeFilter: (sessionModeFilter) => set({ sessionModeFilter }),
      setCurrentView: (currentView) => set({ currentView }),
      dismissSetupGate: () => set({ setupGateActive: false }),
      replayPrologue: () =>
        set((state) => ({
          setupGateActive: true,
          prologueReplayNonce: state.prologueReplayNonce + 1,
        })),
      beginUnlockCurtain: () => set({ unlockCurtainActive: true }),
      dismissUnlockCurtain: () => set({ unlockCurtainActive: false }),
      openWizard: (wizardEntryMode) =>
        set({ currentView: "wizard", wizardEntryMode }),
      openUnlock: (unlockReturnView) =>
        set({ currentView: "unlock", unlockReturnView }),
      setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
      setShellRoute: (shellRoute) => set({ shellRoute }),
      openCreateSession: (initialMessage = null, reasoningEffort = null) => {
        const trimmed =
          typeof initialMessage === "string" ? initialMessage.trim() : "";
        set({
          createSessionOpen: true,
          createSessionInitialTurn:
            trimmed.length > 0 ? { message: trimmed, reasoningEffort } : null,
        });
      },
      closeCreateSession: () =>
        set({ createSessionOpen: false, createSessionInitialTurn: null }),
      completeSessionCreate: (sessionId, reasoningEffort) =>
        set((state) => ({
          activeSessionId: sessionId,
          createSessionOpen: false,
          createSessionInitialTurn:
            state.createSessionInitialTurn !== null
              ? { message: state.createSessionInitialTurn.message, reasoningEffort }
              : null,
        })),
      clearCreateSessionInitialTurn: () =>
        set({ createSessionInitialTurn: null }),
      setSessionReasoningEffort: (sessionId, effort) =>
        set((state) => ({
          reasoningEffortBySession: {
            ...state.reasoningEffortBySession,
            [sessionId]: effort,
          },
        })),
      setSigningState: (signingState) => set({ signingState }),
      setReviewModal: (reviewModal) => set({ reviewModal }),
      setHideDustBalances: (hideDustBalances) => set({ hideDustBalances }),
      setNotificationsEnabled: (notificationsEnabled) => set({ notificationsEnabled }),
      setBookSectionOrder: (bookSectionOrder) => set({ bookSectionOrder }),
      setBookTab: (bookTab) => set({ bookTab }),
      appendLog: (entry) =>
        set((state) => ({
          logBuffer: [...state.logBuffer, entry].slice(-MAX_RENDER_LOGS),
        })),
      clearLogs: () => set({ logBuffer: [] }),
    }),
    {
      name: "vex-ui",
      version: 14,
      // Re-stamp the document root once the coerced, resolved theme is
      // known - theme-boot.js painted the pre-bundle frame from the RAW
      // payload, and a tampered value must not survive on <html>.
      onRehydrateStorage: () => (state) => {
        if (state !== undefined) applyThemeToDocument(state.theme);
      },
      storage: createJSONStorage(() => localStorage),
      // Whitelist + migrations + rehydrate coercion live in
      // uiStore/persistence.ts (same-named sibling folder).
      partialize: partializeUiState,
      migrate: migrateUiState,
      merge: mergeUiState,
    }
  )
);

// Keep the document root current: theme-boot.js painted the pre-bundle
// frame from raw localStorage; once the store has rehydrated (synchronous
// with localStorage), its coerced resolution is authoritative. The system
// listener re-resolves a "system" preference live; an explicit preference
// ignores OS changes by construction (resolveTheme). Both are no-ops in
// environments without a DOM/matchMedia (tests).
applyThemeToDocument(useUiStore.getState().theme);
bindSystemThemeListener((prefersDark) => {
  const { themePreference } = useUiStore.getState();
  const theme = resolveTheme(themePreference, prefersDark);
  applyThemeToDocument(theme);
  useUiStore.setState({ theme });
});
