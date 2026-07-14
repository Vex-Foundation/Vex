/**
 * Unit tests for the renderer UI store. Verifies:
 *   1. Default state matches skill §5 expectations.
 *   2. Action mutations behave atomically.
 *   3. logBuffer is hard-bounded to MAX_RENDER_LOGS (skill §11 — no
 *      unbounded buffers in renderer state).
 *   4. localStorage persist whitelist contains ONLY sidebarOpen — never
 *      logBuffer (would leak), never currentView (transient).
 *   5. clearLogs zeros the buffer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_RENDER_LOGS, useUiStore } from "../uiStore.js";

const STORAGE_KEY = "vex-ui";

function resetStoreToDefaults(): void {
  useUiStore.setState({
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
    expect(state.theme).toBe("vex");
    expect(state.workspaceMode).toBe("normal");
    expect(state.sidebarOpen).toBe(true);
    expect(state.currentView).toBe("splash");
    expect(state.wizardEntryMode).toBe("setup");
    expect(state.unlockReturnView).toBe("appShell");
    expect(state.sessionModeFilter).toBe("all");
    expect(state.activeSessionId).toBeNull();
    expect(state.appShellView).toBe("session");
    expect(state.logBuffer).toEqual([]);
    expect(state.createSessionOpen).toBe(false);
    expect(state.createSessionInitialMessage).toBeNull();
    expect(state.pendingFirstMessage).toBeNull();
  });

  it("setTheme + toggleTheme flip the persisted Robinhood-mode theme", () => {
    expect(useUiStore.getState().theme).toBe("vex");
    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("robinhood");
    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("vex");
    useUiStore.getState().setTheme("robinhood");
    expect(useUiStore.getState().theme).toBe("robinhood");
    // Theme is in the persist whitelist so the choice survives relaunch.
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.state.theme).toBe("robinhood");
  });

  it("setWorkspaceMode flips the transient Hypervexing flag without persisting it", () => {
    expect(useUiStore.getState().workspaceMode).toBe("normal");
    useUiStore.getState().setWorkspaceMode("hypervexing");
    expect(useUiStore.getState().workspaceMode).toBe("hypervexing");
    useUiStore.getState().setWorkspaceMode("normal");
    expect(useUiStore.getState().workspaceMode).toBe("normal");
    // A relaunch must always start in `normal` mode — the flag is agent-driven
    // and transient, so it is excluded from the persist whitelist.
    useUiStore.getState().setWorkspaceMode("hypervexing");
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.workspaceMode).toBeUndefined();
    expect(raw).not.toContain("hypervexing");
  });

  it("migrate v2→v3 seeds the cobalt theme without disturbing v2 fields", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { sidebarOpen: false, bookOpen: false },
        version: 2,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().theme).toBe("vex");
    // v2 fields are preserved (bookOpen is only forced open on the v1→v2 hop).
    expect(useUiStore.getState().sidebarOpen).toBe(false);
    expect(useUiStore.getState().bookOpen).toBe(false);
  });

  it("coerces an off-union persisted theme to 'vex' on rehydrate (tampered localStorage must not crash the shell)", async () => {
    // Current version + invalid theme: `migrate` is skipped (no version hop),
    // so only the rehydrate-time `merge` coercion stands between a hand-edited
    // payload and SignalSky's `SKY_ACCENTS[theme]` lookup.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { theme: "neon-hack", sidebarOpen: false, bookOpen: true },
        version: 3,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().theme).toBe("vex");
    // Other persisted prefs still hydrate normally.
    expect(useUiStore.getState().sidebarOpen).toBe(false);
    expect(useUiStore.getState().bookOpen).toBe(true);
  });

  it("openCreateSession seeds + trims the first message; the sidebar path clears it", () => {
    useUiStore.getState().openCreateSession("  research TAO  ");
    expect(useUiStore.getState().createSessionOpen).toBe(true);
    expect(useUiStore.getState().createSessionInitialMessage).toBe("research TAO");
    // Sidebar "New session" passes no message → clears any prior seed.
    useUiStore.getState().openCreateSession();
    expect(useUiStore.getState().createSessionOpen).toBe(true);
    expect(useUiStore.getState().createSessionInitialMessage).toBeNull();
  });

  it("openCreateSession with whitespace-only text stores null", () => {
    useUiStore.getState().openCreateSession("   ");
    expect(useUiStore.getState().createSessionInitialMessage).toBeNull();
  });

  it("closeCreateSession clears modal state but NOT the pending hand-off", () => {
    useUiStore.getState().openCreateSession("seed");
    useUiStore
      .getState()
      .setPendingFirstMessage({ sessionId: "s1", message: "seed" });
    useUiStore.getState().closeCreateSession();
    expect(useUiStore.getState().createSessionOpen).toBe(false);
    expect(useUiStore.getState().createSessionInitialMessage).toBeNull();
    // Create success closes the modal AFTER setting the hand-off — it must survive.
    expect(useUiStore.getState().pendingFirstMessage).toEqual({
      sessionId: "s1",
      message: "seed",
    });
  });

  it("clearPendingFirstMessage drops the hand-off", () => {
    useUiStore
      .getState()
      .setPendingFirstMessage({ sessionId: "s1", message: "x" });
    useUiStore.getState().clearPendingFirstMessage();
    expect(useUiStore.getState().pendingFirstMessage).toBeNull();
  });

  it("never persists create-modal state or the first message text", () => {
    useUiStore.getState().openCreateSession("super secret first message");
    useUiStore.getState().setPendingFirstMessage({
      sessionId: "s1",
      message: "super secret first message",
    });
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.state).toEqual({
      theme: "vex",
      sidebarOpen: true,
      bookOpen: true,
      hlFavorites: [],
    });
    expect(parsed.state.createSessionOpen).toBeUndefined();
    expect(parsed.state.createSessionInitialMessage).toBeUndefined();
    expect(parsed.state.pendingFirstMessage).toBeUndefined();
    expect(raw).not.toContain("super secret first message");
  });

  it("setAppShellView mutates and reflects new value", () => {
    useUiStore.getState().setAppShellView("sessionsLibrary");
    expect(useUiStore.getState().appShellView).toBe("sessionsLibrary");
  });

  it("setSidebarOpen mutates and reflects new value", () => {
    useUiStore.getState().setSidebarOpen(false);
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it("setSessionModeFilter mutates and reflects new value", () => {
    useUiStore.getState().setSessionModeFilter("mission");
    expect(useUiStore.getState().sessionModeFilter).toBe("mission");
  });

  it("openWizard sets the wizard view and entry mode together", () => {
    useUiStore.getState().openWizard("reconfigure");
    expect(useUiStore.getState().currentView).toBe("wizard");
    expect(useUiStore.getState().wizardEntryMode).toBe("reconfigure");
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
    useUiStore.getState().setAppShellView("sessionsLibrary");
    useUiStore.getState().openWizard("reconfigure");
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
      theme: "vex",
      sidebarOpen: false,
      bookOpen: true,
      hlFavorites: [],
    });
    expect(parsed.state.logBuffer).toBeUndefined();
    expect(parsed.state.currentView).toBeUndefined();
    expect(parsed.state.wizardEntryMode).toBeUndefined();
    expect(parsed.state.unlockReturnView).toBeUndefined();
    expect(parsed.state.sessionModeFilter).toBeUndefined();
    expect(parsed.state.activeSessionId).toBeUndefined();
    expect(parsed.state.appShellView).toBeUndefined();
    // Belt-and-braces: the message text must not appear anywhere serialized.
    expect(raw).not.toContain("private payload");
    expect(raw).not.toContain("secret-log");
  });
});
