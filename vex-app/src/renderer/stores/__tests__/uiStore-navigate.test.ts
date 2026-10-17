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
    // A page with no row of its own leaves the mode's row selected.
    expect(select({ runtimeMode: "studio", shellRoute: { kind: "memory", origin: null } })).toBe(
      "studio",
    );
  });

  it("is what navigate leaves behind for every destination", () => {
    for (const destination of [
      "chat",
      "missions",
      "portfolio",
      "board",
      "lighter",
      "studio",
      "settings",
    ] as const) {
      useUiStore.getState().navigate(destination);
      expect(selectNavDestination(useUiStore.getState())).toBe(destination);
    }
  });
});
