/**
 * The left sidebar's nav as one store action (docs/design/R3-MINIMAL.md
 * section 4): each destination maps onto the existing mode, route and sessions
 * filter, and the selected row follows the route first, then the mode.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { navigationTarget } from "../uiStore/shell-route.js";
import { selectNavDestination, useUiStore } from "../uiStore.js";

const ORIGIN = { x: 10, y: 20, width: 200, height: 34 };

beforeEach(() => {
  useUiStore.setState({
    runtimeMode: "agent",
    shellRoute: { kind: "none" },
    sessionModeFilter: "all",
    activeSessionId: null,
    lighterReturn: null,
    lighterSessionId: null,
    lighterSetupRequested: false,
  });
});

describe("navigate", () => {
  it("opens the R3 pages as routes in the current mode, from the pressed row", () => {
    useUiStore.getState().navigate("portfolio", ORIGIN);
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "portfolio", origin: ORIGIN });
    useUiStore.getState().navigate("board");
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "board", origin: null });
    useUiStore.getState().navigate("settings");
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "settings",
      origin: null,
      section: null,
    });
    expect(useUiStore.getState().runtimeMode).toBe("agent");
  });

  it("Watchlist opens its page and Agent Scan its full feed, in the current mode", () => {
    // docs/design/H3-DESKTOP.md section 4.6: H3's Markets and Activity rows,
    // under desktop's page names (the owner's decision).
    useUiStore.getState().navigate("watchlist", ORIGIN);
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "watchlist", origin: ORIGIN });
    useUiStore.setState({ runtimeMode: "lighter" });
    useUiStore.getState().navigate("agentScan", ORIGIN);
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "agentScan",
      origin: ORIGIN,
      sessionId: null,
    });
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
  });

  it("Missions opens the agent sessions on the Mission tab, and Chat leaves it", () => {
    useUiStore.setState({ shellRoute: { kind: "portfolio", origin: null } });
    useUiStore.getState().navigate("missions");
    expect(useUiStore.getState().sessionModeFilter).toBe("mission");
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
    useUiStore.getState().navigate("chat");
    expect(useUiStore.getState().sessionModeFilter).toBe("all");
  });

  it("Chat keeps an Agent tab the user picked", () => {
    expect(navigationTarget("chat", "agent").sessionModeFilter).toBe("agent");
  });

  it("Lighter and Studio switch the runtime mode through the same transition", () => {
    useUiStore.setState({ activeSessionId: "s-1", shellRoute: { kind: "board", origin: null } });
    useUiStore.getState().navigate("lighter");
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
    expect(useUiStore.getState().lighterReturn).toEqual({ mode: "agent", sessionId: "s-1" });

    useUiStore.setState({ lighterSetupRequested: true });
    useUiStore.getState().navigate("studio");
    expect(useUiStore.getState().runtimeMode).toBe("studio");
    // Leaving the desk drops an unconsumed setup request, as setRuntimeMode does.
    expect(useUiStore.getState().lighterSetupRequested).toBe(false);

    useUiStore.getState().navigate("chat");
    expect(useUiStore.getState().runtimeMode).toBe("agent");
  });
});

describe("the selected nav row", () => {
  const select = (patch: Partial<Parameters<typeof selectNavDestination>[0]>) =>
    selectNavDestination({
      runtimeMode: "agent",
      shellRoute: { kind: "none" },
      sessionModeFilter: "all",
      ...patch,
    });

  it("follows the open page first", () => {
    expect(select({ shellRoute: { kind: "portfolio", origin: null } })).toBe("portfolio");
    expect(select({ shellRoute: { kind: "assets", origin: null, sessionId: null } })).toBe(
      "portfolio",
    );
    expect(select({ shellRoute: { kind: "watchlist", origin: null } })).toBe("watchlist");
    // Agent Scan selects its own row in every scope it opens with.
    expect(select({ shellRoute: { kind: "agentScan", origin: null, sessionId: null } })).toBe(
      "agentScan",
    );
    expect(
      select({
        shellRoute: {
          kind: "agentScan",
          origin: null,
          sessionId: "00000000-0000-4000-8000-000000000001",
        },
      }),
    ).toBe("agentScan");
    expect(
      select({
        shellRoute: {
          kind: "agentScan",
          origin: null,
          projectId: "00000000-0000-4000-8000-000000000002",
        },
      }),
    ).toBe("agentScan");
    expect(select({ shellRoute: { kind: "board", origin: null }, runtimeMode: "lighter" })).toBe(
      "board",
    );
    expect(select({ shellRoute: { kind: "settings", origin: null, section: null } })).toBe(
      "settings",
    );
  });

  it("then the mode, and the Mission tab inside agent mode", () => {
    expect(select({})).toBe("chat");
    expect(select({ sessionModeFilter: "mission" })).toBe("missions");
    expect(select({ runtimeMode: "lighter" })).toBe("lighter");
    expect(select({ runtimeMode: "studio" })).toBe("studio");
  });

  it("selects Missions for a mission chat, Chat for an agent chat, and lets the tab decide when unknown", () => {
    const none = { runtimeMode: "agent", sessionModeFilter: "all" } as const;
    expect(selectNavDestination({ ...none, shellRoute: { kind: "none" } }, "mission")).toBe(
      "missions",
    );
    expect(selectNavDestination({ ...none, shellRoute: { kind: "none" } }, "agent")).toBe("chat");
    expect(selectNavDestination({ ...none, shellRoute: { kind: "none" } }, null)).toBe("chat");
    // The Mission tab still selects Missions with a chat of another mode open
    // (Missions was just pressed), and an unknown session leaves it to the tab.
    expect(
      selectNavDestination(
        { ...none, sessionModeFilter: "mission", shellRoute: { kind: "none" } },
        "agent",
      ),
    ).toBe("missions");
    // A desk or Studio is never a mission chat, whatever session is remembered.
    expect(
      selectNavDestination({ ...none, runtimeMode: "studio", shellRoute: { kind: "none" } }, "mission"),
    ).toBe("studio");
    expect(
      selectNavDestination({ ...none, runtimeMode: "lighter", shellRoute: { kind: "none" } }, "mission"),
    ).toBe("lighter");
    // A page with its own row wins over the chat behind it.
    expect(
      selectNavDestination(
        { ...none, shellRoute: { kind: "portfolio", origin: null } },
        "mission",
      ),
    ).toBe("portfolio");
  });

  it("selects nothing on a page with no row of its own, in every mode and for a mission chat", () => {
    const pages = [
      { kind: "memory", origin: null },
      { kind: "sessions", origin: null },
      { kind: "howItWorks", origin: null },
      { kind: "needsYou", origin: null },
    ] as const;
    for (const shellRoute of pages) {
      for (const runtimeMode of ["agent", "lighter", "studio"] as const) {
        expect(select({ shellRoute, runtimeMode })).toBeNull();
        expect(select({ shellRoute, runtimeMode, sessionModeFilter: "mission" })).toBeNull();
      }
      expect(
        selectNavDestination(
          { runtimeMode: "agent", sessionModeFilter: "all", shellRoute },
          "mission",
        ),
      ).toBeNull();
    }
  });

  it("is what navigate leaves behind for every destination", () => {
    for (const destination of [
      "chat",
      "missions",
      "watchlist",
      "portfolio",
      "agentScan",
      "lighter",
      "studio",
      "board",
      "settings",
    ] as const) {
      useUiStore.getState().navigate(destination);
      expect(selectNavDestination(useUiStore.getState())).toBe(destination);
    }
  });
});
