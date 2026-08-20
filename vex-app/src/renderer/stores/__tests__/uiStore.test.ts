/**
 * Unit tests for the renderer UI store. Verifies:
 *   1. Default state matches skill §5 expectations.
 *   2. Action mutations behave atomically.
 *   3. logBuffer is hard-bounded to MAX_RENDER_LOGS (skill §11 — no
 *      unbounded buffers in renderer state).
 *   4. localStorage persist whitelist contains ONLY sidebarOpen — never
 *      logBuffer (would leak), never currentView (transient).
 *   5. clearLogs zeros the buffer.
 *   6. `hideDustBalances` (Portfolio tab dust filter) defaults true, has a
 *      setter, and persists.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_RENDER_LOGS, useUiStore } from "../uiStore.js";

const STORAGE_KEY = "vex-ui";

function resetStoreToDefaults(): void {
  useUiStore.setState({
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
    reviewModal: "none",
    hideDustBalances: true,
      notificationsEnabled: true,
    bookSectionOrder: [],
  });
}

describe("uiStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStoreToDefaults();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetStoreToDefaults();
  });

  it("starts with the expected defaults", () => {
    const state = useUiStore.getState();
    expect(state.theme).toBe("chronos");
    expect(state.sidebarOpen).toBe(true);
    expect(state.currentView).toBe("splash");
    expect(state.setupGateActive).toBe(true);
    expect(state.unlockCurtainActive).toBe(false);
    expect(state.wizardEntryMode).toBe("setup");
    expect(state.unlockReturnView).toBe("appShell");
    expect(state.sessionModeFilter).toBe("all");
    expect(state.activeSessionId).toBeNull();
    expect(state.shellRoute).toEqual({ kind: "none" });
    expect(state.logBuffer).toEqual([]);
    expect(state.createSessionOpen).toBe(false);
    expect(state.createSessionInitialTurn).toBeNull();
    expect(state.reviewModal).toBe("none");
    expect(state.hideDustBalances).toBe(true);
    expect(state.bookSectionOrder).toEqual([]);
  });

  it("setReviewModal mutates and reflects new value, without persisting it", () => {
    useUiStore.getState().setReviewModal("mission");
    expect(useUiStore.getState().reviewModal).toBe("mission");
    useUiStore.getState().setReviewModal("plan");
    expect(useUiStore.getState().reviewModal).toBe("plan");
    useUiStore.getState().setReviewModal("none");
    expect(useUiStore.getState().reviewModal).toBe("none");
    // UI-ephemeral — never in the persist whitelist (a relaunch always starts
    // with no dialog open).
    useUiStore.getState().setReviewModal("mission");
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.reviewModal).toBeUndefined();
  });

  it("theme defaults to 'chronos'; the persisted slot is themePreference", () => {
    expect(useUiStore.getState().theme).toBe("chronos");
    useUiStore.getState().setSidebarOpen(false);
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.state.themePreference).toBe("chronos");
    expect("theme" in parsed.state).toBe(false);
  });

  it("migrate v2→v5 collapses the retired theme pair to 'chronos' without disturbing v2 fields", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { sidebarOpen: false, bookOpen: false, theme: "robinhood" },
        version: 2,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().theme).toBe("chronos");
    // v2 fields are preserved (bookOpen is only forced open on the v1→v2 hop).
    expect(useUiStore.getState().sidebarOpen).toBe(false);
    expect(useUiStore.getState().bookOpen).toBe(false);
  });

  it("migrate v5→v6 seeds hideDustBalances TRUE for a pre-v6 install (no field yet)", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { sidebarOpen: true, bookOpen: true, theme: "chronos" },
        version: 5,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().hideDustBalances).toBe(true);
  });

  it("migrate v10→v11 seeds notificationsEnabled TRUE for a pre-v11 install (no field yet)", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { sidebarOpen: true, bookOpen: true, themePreference: "chronos" },
        version: 10,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().notificationsEnabled).toBe(true);
  });

  it("coerces a non-boolean persisted notificationsEnabled to true on rehydrate (a tampered payload can never reach the notify path)", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { notificationsEnabled: "yes please" },
        version: 11,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().notificationsEnabled).toBe(true);
  });

  it("a persisted notificationsEnabled FALSE survives rehydrate - the opt-out sticks", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { notificationsEnabled: false },
        version: 11,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().notificationsEnabled).toBe(false);
  });

  it("coerces a non-boolean persisted hideDustBalances to true on rehydrate (tampered localStorage must not crash the shell)", async () => {
    // Current version + invalid value: `migrate` is skipped (no version hop),
    // so only the rehydrate-time `merge` coercion stands between a
    // hand-edited payload and the checkbox's `checked` prop.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { theme: "chronos", hideDustBalances: "yes" },
        version: 6,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().hideDustBalances).toBe(true);
  });

  it("coerces an off-union persisted theme to 'chronos' on rehydrate (tampered localStorage must not crash the shell)", async () => {
    // Current version + invalid theme: `migrate` is skipped (no version hop),
    // so only the rehydrate-time `merge` coercion stands between a hand-edited
    // payload and the `data-vex-theme` attribute on the shell root.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { theme: "neon-hack", sidebarOpen: false, bookOpen: true },
        version: 5,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().theme).toBe("chronos");
    // Other persisted prefs still hydrate normally.
    expect(useUiStore.getState().sidebarOpen).toBe(false);
    expect(useUiStore.getState().bookOpen).toBe(true);
  });

  it("openCreateSession seeds + trims the first message with no effort by default; the sidebar path clears it", () => {
    useUiStore.getState().openCreateSession("  research TAO  ");
    expect(useUiStore.getState().createSessionOpen).toBe(true);
    expect(useUiStore.getState().createSessionInitialTurn).toEqual({
      message: "research TAO",
      reasoningEffort: null,
    });
    // Sidebar "New session" passes no message → clears any prior seed.
    useUiStore.getState().openCreateSession();
    expect(useUiStore.getState().createSessionOpen).toBe(true);
    expect(useUiStore.getState().createSessionInitialTurn).toBeNull();
  });

  it("openCreateSession snapshots the reasoning effort argument verbatim", () => {
    useUiStore.getState().openCreateSession("research TAO", "high");
    expect(useUiStore.getState().createSessionInitialTurn).toEqual({
      message: "research TAO",
      reasoningEffort: "high",
    });
  });

  it("openCreateSession with whitespace-only text stores null regardless of effort", () => {
    useUiStore.getState().openCreateSession("   ", "high");
    expect(useUiStore.getState().createSessionInitialTurn).toBeNull();
  });

  it("closeCreateSession (Cancel/Escape/backdrop) clears the modal AND discards the pending hand-off", () => {
    useUiStore.getState().openCreateSession("seed", "medium");
    useUiStore.getState().closeCreateSession();
    expect(useUiStore.getState().createSessionOpen).toBe(false);
    // Discarded, not merely closed — an abandoned draft must never ride into
    // whichever session the operator opens next (the wrong-session leak the
    // hand-off effect's sessionless struct depends on this store action to
    // prevent).
    expect(useUiStore.getState().createSessionInitialTurn).toBeNull();
  });

  it("completeSessionCreate installs the gated effort, closes the modal, and activates the session in one transition", () => {
    useUiStore.getState().openCreateSession("seed", "high");
    useUiStore.getState().completeSessionCreate("session-1", "high");
    const state = useUiStore.getState();
    expect(state.activeSessionId).toBe("session-1");
    expect(state.createSessionOpen).toBe(false);
    // The message survives untouched; the effort field is (re)installed with
    // whatever the caller passed (SessionCreator has already mode-gated it).
    expect(state.createSessionInitialTurn).toEqual({
      message: "seed",
      reasoningEffort: "high",
    });
    // Does NOT seed reasoningEffortBySession itself — that is the new
    // composer's own hand-off effect's job once it consumes the turn.
    expect(state.reasoningEffortBySession["session-1"]).toBeUndefined();
  });

  it("completeSessionCreate installs null when the caller mode-gates a mission create, even if the raw pick was non-null", () => {
    useUiStore.getState().openCreateSession("seed", "high");
    useUiStore.getState().completeSessionCreate("session-1", null);
    expect(useUiStore.getState().createSessionInitialTurn).toEqual({
      message: "seed",
      reasoningEffort: null,
    });
  });

  it("completeSessionCreate is a no-op on createSessionInitialTurn when there was no pending message", () => {
    useUiStore.getState().completeSessionCreate("session-1", "high");
    expect(useUiStore.getState().createSessionInitialTurn).toBeNull();
    expect(useUiStore.getState().activeSessionId).toBe("session-1");
  });

  it("clearCreateSessionInitialTurn drops the hand-off", () => {
    useUiStore.getState().openCreateSession("seed", "medium");
    useUiStore.getState().clearCreateSessionInitialTurn();
    expect(useUiStore.getState().createSessionInitialTurn).toBeNull();
  });

  it("never persists create-modal state or the first message text", () => {
    useUiStore.getState().openCreateSession("super secret first message", "high");
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.state).toEqual({
      themePreference: "chronos",
      sidebarOpen: true,
      sidebarWidth: 280,
      bookWidth: 360,
      bookOpen: true,
      hideDustBalances: true,
      notificationsEnabled: true,
      bookSectionOrder: [],
    });
    expect(parsed.state.createSessionOpen).toBeUndefined();
    expect(parsed.state.createSessionInitialTurn).toBeUndefined();
    expect(raw).not.toContain("super secret first message");
  });

  it("setShellRoute opens a screen with its trigger origin and closes atomically", () => {
    useUiStore.getState().setShellRoute({
      kind: "sessions",
      origin: { x: 12, y: 640, width: 240, height: 44 },
    });
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "sessions",
      origin: { x: 12, y: 640, width: 240, height: 44 },
    });
    // Opening with a null origin = the centered expand.
    useUiStore.getState().setShellRoute({ kind: "memory", origin: null });
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "memory",
      origin: null,
    });
    // Closing replaces the WHOLE route — no origin/payload can linger.
    useUiStore.getState().setShellRoute({ kind: "none" });
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("setShellRoute carries the token-history payload (token identity + returnTo) atomically", () => {
    useUiStore.getState().setShellRoute({
      kind: "tokenHistory",
      origin: { x: 5, y: 6, width: 20, height: 20 },
      token: {
        chainId: 8453,
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        symbol: "USDC",
        tokenName: "USD Coin",
      },
      returnTo: { kind: "assets", sessionId: null },
    });
    const route = useUiStore.getState().shellRoute;
    expect(route.kind).toBe("tokenHistory");
    if (route.kind !== "tokenHistory") throw new Error("route kind mismatch");
    expect(route.token).toEqual({
      chainId: 8453,
      tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      symbol: "USDC",
      tokenName: "USD Coin",
    });
    expect(route.returnTo).toEqual({ kind: "assets", sessionId: null });
    // Closing drops the payload with the route — nothing to clear separately.
    useUiStore.getState().setShellRoute({ kind: "none" });
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("setShellRoute carries the settings section payload atomically (deep-link + register)", () => {
    // Deep-link (welcome Portfolio "Add wallet") lands straight on Wallets.
    useUiStore.getState().setShellRoute({
      kind: "settings",
      origin: { x: 12, y: 640, width: 240, height: 44 },
      section: "wallets",
    });
    const route = useUiStore.getState().shellRoute;
    expect(route.kind).toBe("settings");
    if (route.kind !== "settings") throw new Error("route kind mismatch");
    expect(route.section).toBe("wallets");
    // The profile-menu row opens the landing register (section null).
    useUiStore.getState().setShellRoute({
      kind: "settings",
      origin: null,
      section: null,
    });
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "settings",
      origin: null,
      section: null,
    });
    useUiStore.getState().setShellRoute({ kind: "none" });
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("dismissSetupGate is the one-way boot-gate flip (defaults active)", () => {
    expect(useUiStore.getState().setupGateActive).toBe(true);
    useUiStore.getState().dismissSetupGate();
    expect(useUiStore.getState().setupGateActive).toBe(false);
  });

  it("beginUnlockCurtain / dismissUnlockCurtain arm and clear the exit curtain", () => {
    expect(useUiStore.getState().unlockCurtainActive).toBe(false);
    useUiStore.getState().beginUnlockCurtain();
    expect(useUiStore.getState().unlockCurtainActive).toBe(true);
    useUiStore.getState().dismissUnlockCurtain();
    expect(useUiStore.getState().unlockCurtainActive).toBe(false);
  });

  it("setSidebarOpen mutates and reflects new value", () => {
    useUiStore.getState().setSidebarOpen(false);
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it("setHideDustBalances mutates, defaults true, and persists the choice", () => {
    expect(useUiStore.getState().hideDustBalances).toBe(true);
    useUiStore.getState().setHideDustBalances(false);
    expect(useUiStore.getState().hideDustBalances).toBe(false);
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.state.hideDustBalances).toBe(false);
    useUiStore.getState().setHideDustBalances(true);
    expect(useUiStore.getState().hideDustBalances).toBe(true);
  });

  it("setBookSectionOrder persists the rail order and survives a rehydrate", async () => {
    useUiStore.getState().setBookSectionOrder(["trench", "position"]);
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.state.bookSectionOrder).toEqual(["trench", "position"]);
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().bookSectionOrder).toEqual([
      "trench",
      "position",
    ]);
  });

  it("migrate v7→v8 seeds bookSectionOrder [] and preserves every earlier pref", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          theme: "chronos",
          sidebarOpen: false,
          bookOpen: false,
          hideDustBalances: false,
          prologueVersion: "0.1.9",
        },
        version: 7,
      }),
    );
    await useUiStore.persist.rehydrate();
    const state = useUiStore.getState();
    expect(state.bookSectionOrder).toEqual([]);
    expect(state.sidebarOpen).toBe(false);
    expect(state.bookOpen).toBe(false);
    expect(state.hideDustBalances).toBe(false);
    // v12 drops the retired `prologueVersion` key on the way through.
    expect("prologueVersion" in state).toBe(false);
  });

  it("migrate v11→v12 drops the retired prologueVersion key and preserves every other pref", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          themePreference: "chronos",
          sidebarOpen: false,
          bookOpen: false,
          sidebarWidth: 280,
          bookWidth: 360,
          hideDustBalances: false,
          notificationsEnabled: false,
          prologueVersion: "0.2.5",
          bookSectionOrder: ["position"],
        },
        version: 11,
      }),
    );
    await useUiStore.persist.rehydrate();
    const state = useUiStore.getState();
    expect("prologueVersion" in state).toBe(false);
    expect(state.sidebarOpen).toBe(false);
    expect(state.bookOpen).toBe(false);
    expect(state.hideDustBalances).toBe(false);
    expect(state.notificationsEnabled).toBe(false);
    expect(state.bookSectionOrder).toEqual(["position"]);
  });

  it("coerces every off-shape persisted bookSectionOrder back to [] (a tampered payload must not blank the rail)", async () => {
    // Current version + garbage: `migrate` is skipped, so only the
    // rehydrate-time `merge` coercion stands between the payload and the rail.
    const rejected: readonly unknown[] = [
      "nope",
      [1, 2, 3],
      Array.from({ length: 100 }, () => "position"),
      ["x".repeat(200)],
      [""],
      null,
    ];
    for (const bookSectionOrder of rejected) {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ state: { theme: "chronos", bookSectionOrder }, version: 8 }),
      );
      await useUiStore.persist.rehydrate();
      expect(useUiStore.getState().bookSectionOrder).toEqual([]);
    }
  });

  it("setSessionModeFilter mutates and reflects new value", () => {
    useUiStore.getState().setSessionModeFilter("mission");
    expect(useUiStore.getState().sessionModeFilter).toBe("mission");
  });

  it("openWizard sets the wizard view and entry mode together", () => {
    useUiStore.getState().openWizard("setup");
    expect(useUiStore.getState().currentView).toBe("wizard");
    expect(useUiStore.getState().wizardEntryMode).toBe("setup");
  });

  it("openUnlock sets the unlock view and return target together", () => {
    useUiStore.getState().openUnlock("wizard");
    expect(useUiStore.getState().currentView).toBe("unlock");
    expect(useUiStore.getState().unlockReturnView).toBe("wizard");
  });

  it("appendLog hard-caps logBuffer at MAX_RENDER_LOGS", () => {
    const overflow = MAX_RENDER_LOGS + 100;
    for (let i = 0; i < overflow; i += 1) {
      useUiStore.getState().appendLog({
        id: `log-${i}`,
        level: "info",
        message: `entry ${i}`,
        ts: i,
      });
    }
    const buffer = useUiStore.getState().logBuffer;
    expect(buffer).toHaveLength(MAX_RENDER_LOGS);
    expect(buffer[0]?.id).toBe(`log-${overflow - MAX_RENDER_LOGS}`);
    expect(buffer[buffer.length - 1]?.id).toBe(`log-${overflow - 1}`);
  });

  it("clearLogs empties the buffer", () => {
    useUiStore.getState().appendLog({
      id: "x",
      level: "warn",
      message: "noise",
      ts: 1,
    });
    expect(useUiStore.getState().logBuffer).toHaveLength(1);
    useUiStore.getState().clearLogs();
    expect(useUiStore.getState().logBuffer).toEqual([]);
  });

  it("persists ONLY the UI prefs (sidebarOpen + bookOpen) to localStorage (never logBuffer / transient navigation state)", () => {
    useUiStore.getState().setSidebarOpen(false);
    useUiStore.getState().setCurrentView("systemCheck");
    useUiStore.getState().setSessionModeFilter("mission");
    useUiStore.getState().setActiveSessionId("64dd70f7-0ff6-462e-90c0-e528681d7e5d");
    useUiStore.getState().setShellRoute({
      kind: "tokenHistory",
      origin: { x: 12, y: 640, width: 240, height: 44 },
      token: {
        chainId: 8453,
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        symbol: "USDC",
        tokenName: "USD Coin",
      },
      returnTo: { kind: "shell" },
    });
    useUiStore.getState().openWizard("setup");
    useUiStore.getState().openUnlock("wizard");
    useUiStore.getState().appendLog({
      id: "secret-log",
      level: "error",
      message: "private payload",
      ts: 99,
    });

    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);

    expect(parsed.state).toEqual({
      themePreference: "chronos",
      sidebarOpen: false,
      sidebarWidth: 280,
      bookWidth: 360,
      bookOpen: true,
      hideDustBalances: true,
      notificationsEnabled: true,
      bookSectionOrder: [],
    });
    expect(parsed.state.logBuffer).toBeUndefined();
    expect(parsed.state.currentView).toBeUndefined();
    expect(parsed.state.wizardEntryMode).toBeUndefined();
    expect(parsed.state.unlockReturnView).toBeUndefined();
    expect(parsed.state.sessionModeFilter).toBeUndefined();
    expect(parsed.state.activeSessionId).toBeUndefined();
    expect(parsed.state.shellRoute).toBeUndefined();
    // Belt-and-braces: the message text must not appear anywhere serialized —
    // and neither may the token-history route payload (route state is
    // launch-ephemeral; a wallet's token interest never lands in localStorage).
    expect(raw).not.toContain("private payload");
    expect(raw).not.toContain("secret-log");
    expect(raw).not.toContain("tokenHistory");
    expect(raw).not.toContain("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  });
});
