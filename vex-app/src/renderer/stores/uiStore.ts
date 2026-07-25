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
 * Shell theme (`theme`) IS persisted (partialize whitelist below): today the
 * union holds only "chronos" (the dark Eclipse desk), but the slot and its
 * persistence survive so the planned "celeris" light theme lands without
 * another storage migration. It drives the `data-vex-theme` attribute on the
 * shell root. Everything else here stays UI-only per skill §5 (domain/IPC
 * data belongs in TanStack Query).
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ReasoningEffort } from "@shared/schemas/chat.js";

export const MAX_RENDER_LOGS = 500;

/**
 * Shell colour theme. `chronos` = the dark Eclipse desk (Focused · Quiet ·
 * Precise) — currently the only theme; the planned light `celeris` (Bright ·
 * Clear · Fast, Aurora backdrop) will widen this union. App-wide by
 * construction — the value rides on the shell root's `data-vex-theme`
 * attribute. (The retired `vex`/`robinhood` pair coerces to `chronos` on
 * rehydrate.)
 */
export type VexTheme = "chronos";

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
 * Viewport rect of the trigger control that opened the current shell screen —
 * the expand-from-trigger anchor for the screen's enter animation. Plain
 * numbers (not a live DOMRect) so the store stays serializable. `null` = no
 * origin (the screen falls back to a centered expand). NOT persisted.
 */
export interface ShellScreenOrigin {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Token identity + display metadata carried by the token-history route.
 * `chainId`/`tokenAddress` are the EXACT query identity (the IPC input schema
 * re-validates them at the boundary); `symbol` is RAW provider text —
 * consumers sanitize before display — and `tokenName` is the main-sanitized
 * display name. Neither symbol nor name is ever a query/cache/auth input.
 */
export interface ShellRouteToken {
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly symbol: string | null;
  readonly tokenName: string | null;
}

/** Where closing the token-history screen returns: the bare shell or the All-assets screen. */
export type ShellRouteReturnTo = "shell" | "assets";

/**
 * Settings screen sections (Phase 2b — the in-shell Settings rebuild that
 * retired the reconfigure-wizard "Edit infrastructure" entry). Each section
 * hosts the matching wizard step form in back-edit mode. Carried on the
 * `settings` route so callers can deep-link a section (the welcome
 * Portfolio "Add wallet" row lands directly on `wallets`); `null` opens
 * the landing register.
 */
export type SettingsSection =
  | "vault"
  | "wallets"
  | "apiKeys"
  | "model"
  | "memory"
  | "tuning";

/**
 * Full-app overlay screen route (Chronos screens redesign, 2026-07-20;
 * atomised into ONE discriminated union in the token-history round so a
 * screen and its payload can never desync). The center panel is ALWAYS the
 * session panel; Memory, the sessions library, and the "How Vex works"
 * article open as `ShellScreen` overlays expanding from their profile-menu
 * rows (the Missions screen is retired — the owner ruled Sessions covers
 * it); `assets` is the All-assets register (welcome Portfolio tab's Balances
 * footer); `tokenHistory` is the per-token history screen (the eye trigger
 * on a token row), carrying the row's token identity and the surface its
 * close returns to. `none` = no screen open. NOT persisted —
 * launch-ephemeral, like activeSessionId.
 */
export type ShellRoute =
  | { readonly kind: "none" }
  | {
      readonly kind: "memory" | "sessions" | "howItWorks";
      readonly origin: ShellScreenOrigin | null;
    }
  | { readonly kind: "assets"; readonly origin: ShellScreenOrigin | null }
  | {
      readonly kind: "settings";
      readonly origin: ShellScreenOrigin | null;
      readonly section: SettingsSection | null;
    }
  | {
      readonly kind: "tokenHistory";
      readonly origin: ShellScreenOrigin | null;
      readonly token: ShellRouteToken;
      readonly returnTo: ShellRouteReturnTo;
    };

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

interface UiState {
  /**
   * Shell colour theme, persisted (see the VexTheme doc — the slot outlives
   * the single-value union so the planned `celeris` lands migration-free).
   * Defaults to `chronos`.
   */
  readonly theme: VexTheme;
  readonly sidebarOpen: boolean;
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
  readonly setSidebarOpen: (value: boolean) => void;
  readonly setBookOpen: (value: boolean) => void;
  readonly toggleBook: () => void;
  readonly setSessionModeFilter: (value: SessionModeFilter) => void;
  readonly setCurrentView: (value: View) => void;
  /** One-way: the boot gate unmounts for the rest of the process. */
  readonly dismissSetupGate: () => void;
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
  readonly appendLog: (entry: UiLogEntry) => void;
  readonly clearLogs: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "chronos",
      sidebarOpen: true,
      bookOpen: true,
      currentView: "splash",
      setupGateActive: true,
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
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setBookOpen: (bookOpen) => set({ bookOpen }),
      toggleBook: () => set((state) => ({ bookOpen: !state.bookOpen })),
      setSessionModeFilter: (sessionModeFilter) => set({ sessionModeFilter }),
      setCurrentView: (currentView) => set({ currentView }),
      dismissSetupGate: () => set({ setupGateActive: false }),
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
      appendLog: (entry) =>
        set((state) => ({
          logBuffer: [...state.logBuffer, entry].slice(-MAX_RENDER_LOGS),
        })),
      clearLogs: () => set({ logBuffer: [] }),
    }),
    {
      name: "vex-ui",
      version: 6,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        sidebarOpen: state.sidebarOpen,
        bookOpen: state.bookOpen,
        hideDustBalances: state.hideDustBalances,
      }),
      // Expand-only migrations, oldest first:
      //   v2: BOOK now opens by default — force it open once on upgrade from v1
      //       so existing installs pick up the new default (later toggles
      //       persist normally).
      //   v3: `theme` added — seed the then-default so a pre-theme install
      //       hydrates into a defined value, not `undefined`.
      //   v4: `hlFavorites` added (Hypervexing market-picker stars) — seed [].
      //       Removed by the Hyperliquid deletion: the field no longer exists
      //       on `UiState`, so a leftover `hlFavorites` key in an old payload
      //       is simply ignored by `merge` below, never seeded again.
      //   v5: Chronos rebrand — the retired `vex`/`robinhood` theme pair
      //       collapses to `chronos` (the merge coercion below also enforces
      //       this on every rehydrate).
      //   v6: `hideDustBalances` added (Portfolio tab dust filter) — seed
      //       the same TRUE default a fresh install gets, so an upgrading
      //       install's dust airdrops hide immediately instead of the field
      //       hydrating `undefined`.
      migrate: (persisted, version) => {
        if (persisted === null || typeof persisted !== "object") {
          return persisted;
        }
        let next = persisted as Record<string, unknown>;
        if (version < 2) next = { ...next, bookOpen: true };
        if (version < 5) next = { ...next, theme: "chronos" };
        if (version < 6 && !("hideDustBalances" in next)) {
          next = { ...next, hideDustBalances: true };
        }
        return next;
      },
      // localStorage is user-writable (untrusted input), and `migrate` only
      // runs on version hops — a hand-edited current-version payload skips it.
      // Coerce on EVERY rehydrate: any off-union `theme` (including the
      // retired "vex"/"robinhood" values) degrades to "chronos" instead of
      // reaching `data-vex-theme` with an unknown value.
      merge: (persisted, current) => {
        const incoming =
          persisted !== null && typeof persisted === "object"
            ? (persisted as Partial<UiState>)
            : undefined;
        const theme: VexTheme = "chronos";
        // Same coercion for the dust filter: anything that is not a boolean
        // degrades to the TRUE default, never a crash or a stray non-boolean
        // reaching the checkbox's `checked` prop.
        const hideDustBalances: boolean =
          typeof incoming?.hideDustBalances === "boolean"
            ? incoming.hideDustBalances
            : true;
        return { ...current, ...incoming, theme, hideDustBalances };
      },
    }
  )
);
