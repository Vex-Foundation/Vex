/**
 * The Vex sidebar (docs/design/R3-MINIMAL.md section 5): information first,
 * then her face. What is pinned:
 *
 *  - HIDDEN is zero content: a closed column renders no head, no key, no
 *    state and no hologram, so nothing in a 0px track takes focus or paints;
 *  - the R3b ORDER: the state (scope, word, timer), the narration, the
 *    background missions, Needs you, then the portrait plate, then the
 *    avatar switch;
 *  - AVATAR OFF: no plate and no hologram anywhere, the 44px flat token
 *    beside the state, and everything else stays; the switch writes the
 *    persisted preference;
 *  - Needs you never decides: its key for an approval in the open chat says
 *    "Review ↓" and only closes a page over the chat;
 *  - STUDIO: the "This project" block opens the project's own Project assets
 *    and Agent Scan, never a session's or the global register;
 *  - LIGHTER: the desk chat sits under the plate in the Lighter role scope,
 *    and there is no foot.
 *
 * The presence is mocked (`useVexPresence.test.tsx` owns how it is derived);
 * this suite owns the column.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { NeedsYouItem } from "../needs-you.js";
import { approvalNeedsYouItem } from "../needs-you.js";
import type { VexPresence } from "../useVexPresence.js";
import { approval } from "./fixtures.js";

const presenceRef: { current: VexPresence | null } = { current: null };

vi.mock("../useVexPresence.js", () => ({
  useVexPresence: () => {
    if (presenceRef.current === null) throw new Error("presence fixture missing");
    return presenceRef.current;
  },
}));
vi.mock("../../../lib/api/shell-backdrop.js", () => ({
  useShellBackdrop: () => ({ data: undefined }),
  currentShellBackdrop: () => null,
}));
vi.mock("../../../lib/api/projects.js", () => ({
  useProject: (projectId: string | null) => ({
    isLoading: false,
    data: {
      ok: true,
      data: {
        id: projectId,
        name: "Core tools",
        permission: "full",
        createdAt: "2026-08-31T10:00:00.000Z",
        displayPath: "~/Vex/projects/core-tools",
      },
    },
  }),
}));
vi.mock("../../appShell/lighterTrading/LighterChatRail.js", () => ({
  LighterChatRail: () => <div data-testid="desk-chat" />,
}));

const { VexSidebar } = await import("../VexSidebar.js");
const { useVexSidebarSlot } = await import("../vex-sidebar-slot.js");
const { createPortal } = await import("react-dom");

/** A page's block, portalled into the sidebar's slot while there is one. */
function PageBlock(): JSX.Element | null {
  const slot = useVexSidebarSlot();
  return slot === null ? null : createPortal(<p data-testid="page-block">Ask Vex</p>, slot);
}
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION = "00000000-0000-4000-8000-0000000000a1";
const PROJECT = "00000000-0000-4000-8000-0000000000b2";
const NOW = Date.parse("2026-10-17T12:30:00.000Z");

function presence(overrides: Partial<VexPresence> = {}): VexPresence {
  return {
    state: "working",
    word: "Working",
    fill: "done",
    scope: "This chat:",
    timerStartedAt: null,
    narration: "Calling Wallet balances to answer “And ETH?”",
    background: {
      count: 1,
      items: [],
      label: "1 mission running",
      summary: "1 mission running · Weekly rebalance",
    },
    needsYou: { status: "ready", count: 0, items: [], retry: vi.fn(), retrying: false },
    ...overrides,
  };
}

function needs(items: NeedsYouItem[]): VexPresence["needsYou"] {
  return { status: "ready", count: items.length, items, retry: vi.fn(), retrying: false };
}

function sidebar(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='vex-sidebar']");
  if (el === null) throw new Error("sidebar missing");
  return el;
}

function area(name: string): HTMLElement | null {
  return sidebar().querySelector<HTMLElement>(`[data-vex-area='${name}']`);
}

/** True when `a` comes before `b` in document order. */
function before(a: Element | null, b: Element | null): boolean {
  if (a === null || b === null) return false;
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

beforeEach(() => {
  window.localStorage.clear();
  presenceRef.current = presence();
  useUiStore.setState({
    runtimeMode: "agent",
    activeSessionId: SESSION,
    activeProjectId: null,
    shellRoute: { kind: "none" },
    showAvatar: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("VexSidebar, hidden", () => {
  it("renders nothing into a closed column: no head, no key, no state, no hologram", () => {
    render(<VexSidebar open={false} onHide={() => {}} />);
    expect(sidebar().getAttribute("data-vex-vex-open")).toBe("false");
    expect(sidebar().childElementCount).toBe(0);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector("[data-vex-k2]")).toBeNull();
  });
});

describe("VexSidebar, open", () => {
  it("puts information first: state, narration, background work, Needs you, then the plate and the switch", () => {
    render(<VexSidebar open onHide={() => {}} />);
    expect(sidebar().getAttribute("data-vex-vex-open")).toBe("true");
    expect(within(sidebar()).getByText("Vex")).toBeTruthy();

    const state = area("vex-state");
    expect(state?.getAttribute("data-vex-state")).toBe("working");
    expect(state?.textContent).toContain("This chat: Working");
    expect(state?.textContent).toContain("Calling Wallet balances to answer “And ETH?”");
    expect(area("vex-background")?.textContent).toBe("1 mission running · Weekly rebalance");

    const needsYou = area("vex-needs-you");
    expect(needsYou?.textContent).toContain("Needs you");
    expect(needsYou?.textContent).toContain("Nothing needs you.");

    const plate = area("vex-portrait-plate");
    const k2 = plate?.querySelector("[data-vex-k2]");
    expect(k2?.getAttribute("data-vex-k2")).toBe("sidebar");
    expect(k2?.getAttribute("data-vex-k2-ground")).toBe("print");
    const avatarSwitch = screen.getByRole("switch", { name: "Show avatar" });
    expect(avatarSwitch.getAttribute("aria-checked")).toBe("true");

    expect(before(state, needsYou)).toBe(true);
    expect(before(needsYou, plate)).toBe(true);
    expect(before(plate ?? null, avatarSwitch)).toBe(true);
  });

  it("hides through its key, named for what it does", () => {
    const onHide = vi.fn();
    render(<VexSidebar open onHide={onHide} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide Vex" }));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("shows the live timer beside the word, in m:ss from the turn's start", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      presenceRef.current = presence({ timerStartedAt: NOW - 62_000 });
      render(<VexSidebar open onHide={() => {}} />);
      expect(area("vex-state")?.textContent).toContain("1:02");
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(area("vex-state")?.textContent).toContain("1:03");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says no narration and no background line when there is nothing true to say", () => {
    presenceRef.current = presence({
      state: "ready",
      word: "Ready",
      fill: "idle",
      narration: null,
      background: { count: 0, items: [], label: null, summary: null },
    });
    render(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-state")?.textContent).toBe("This chat: Ready");
    expect(area("vex-background")).toBeNull();
  });
});

describe("VexSidebar, the page slot", () => {
  it("takes a page's block under Needs you while open, and drops it when hidden", () => {
    const view = render(
      <>
        <VexSidebar open onHide={() => {}} />
        <PageBlock />
      </>,
    );
    const block = screen.getByTestId("page-block");
    expect(area("vex-sidebar-slot")?.contains(block)).toBe(true);
    expect(before(area("vex-needs-you"), block)).toBe(true);
    expect(before(block, area("vex-portrait-plate"))).toBe(true);

    view.rerender(
      <>
        <VexSidebar open={false} onHide={() => {}} />
        <PageBlock />
      </>,
    );
    expect(screen.queryByTestId("page-block")).toBeNull();
  });
});

describe("VexSidebar, avatar off", () => {
  it("drops the plate and the hologram, keeps the token, the word, the narration and Needs you", () => {
    useUiStore.setState({ showAvatar: false });
    render(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-portrait-plate")).toBeNull();
    expect(document.querySelector("[data-vex-k2]")).toBeNull();
    const state = area("vex-state");
    expect(state?.querySelector("[data-vex-vx-token] svg")?.getAttribute("width")).toBe("44");
    expect(state?.textContent).toContain("This chat: Working");
    expect(state?.textContent).toContain("Calling Wallet balances");
    expect(area("vex-needs-you")).not.toBeNull();
  });

  it("writes the preference from the switch, both ways", () => {
    render(<VexSidebar open onHide={() => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: "Show avatar" }));
    expect(useUiStore.getState().showAvatar).toBe(false);
    expect(area("vex-portrait-plate")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Show avatar" }));
    expect(useUiStore.getState().showAvatar).toBe(true);
    expect(area("vex-portrait-plate")).not.toBeNull();
  });
});

describe("VexSidebar, Needs you", () => {
  it("counts the items and points at the card in the open chat, never deciding it", () => {
    const item = approvalNeedsYouItem(
      approval({ id: "a1", sessionId: SESSION, toolName: "BridgeExecute", sessionTitle: "Treasury chat" }),
      NOW,
    );
    presenceRef.current = presence({ needsYou: needs([item]) });
    useUiStore.setState({ shellRoute: { kind: "memory", origin: null } });
    render(<VexSidebar open onHide={() => {}} />);

    const section = area("vex-needs-you");
    expect(section?.querySelector("h3")?.textContent).toBe("Needs you · 1");
    const review = within(section ?? sidebar()).getByRole("button", {
      name: "Review ↓: Approve bridge",
    });
    fireEvent.click(review);
    // The chat stays the open one; the page over it closes so the card shows.
    expect(useUiStore.getState().activeSessionId).toBe(SESSION);
    expect(useUiStore.getState().runtimeMode).toBe("agent");
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("opens the session an approval was raised in, from anywhere", () => {
    const other = "00000000-0000-4000-8000-0000000000c3";
    const item = approvalNeedsYouItem(
      approval({ id: "a2", sessionId: other, toolName: "BridgeExecute", sessionTitle: "Treasury chat" }),
      NOW,
    );
    presenceRef.current = presence({ needsYou: needs([item]) });
    render(<VexSidebar open onHide={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Review: Approve bridge" }));
    expect(useUiStore.getState().activeSessionId).toBe(other);
  });

  it("says a read it could not make is unknown, never zero", () => {
    presenceRef.current = presence({
      needsYou: { status: "unknown", count: null, items: [], retry: vi.fn(), retrying: false },
    });
    render(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-needs-you")?.querySelector("h3")?.textContent).toBe("Needs you · ?");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("VexSidebar in Studio: This project", () => {
  beforeEach(() => {
    useUiStore.setState({ runtimeMode: "studio", activeProjectId: PROJECT });
    presenceRef.current = presence({ scope: "This project:", state: "ready", word: "Ready", fill: "idle" });
  });

  it("shows the project's facts and the two project pages", () => {
    render(<VexSidebar open onHide={() => {}} />);
    const block = area("vex-this-project");
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("Studio");
    expect(block?.textContent).toContain("Full");
    expect(block?.textContent).toContain("~/Vex/projects/core-tools");
    expect(area("vex-state")?.textContent).toContain("This project: Ready");
    expect(before(area("vex-needs-you"), block)).toBe(true);
  });

  it("opens Project assets in the PROJECT scope, never a session's or the global one", () => {
    render(<VexSidebar open onHide={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Project assets" }));
    const route = useUiStore.getState().shellRoute;
    expect(route.kind).toBe("assets");
    if (route.kind !== "assets") throw new Error("unreachable");
    expect(route.projectId).toBe(PROJECT);
    expect(route.sessionId ?? null).toBeNull();
  });

  it("opens Agent Scan in the PROJECT scope, never a session's or the global one", () => {
    render(<VexSidebar open onHide={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Agent Scan" }));
    const route = useUiStore.getState().shellRoute;
    expect(route.kind).toBe("agentScan");
    if (route.kind !== "agentScan") throw new Error("unreachable");
    expect(route.projectId).toBe(PROJECT);
    expect(route.sessionId ?? null).toBeNull();
  });

  it("has no project block outside Studio", () => {
    useUiStore.setState({ runtimeMode: "agent" });
    render(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-this-project")).toBeNull();
  });
});

describe("VexSidebar on the Lighter desk", () => {
  it("mounts the desk chat under the plate, in the Lighter role scope, with no foot", () => {
    useUiStore.setState({ runtimeMode: "lighter" });
    render(<VexSidebar open onHide={() => {}} />);
    expect(sidebar().className).toContain("lit-chat-frame");
    expect(sidebar().getAttribute("data-lighter-theme")).toBe(useUiStore.getState().theme);
    const chat = area("vex-desk-chat");
    expect(chat?.querySelector("[data-testid='desk-chat']")).not.toBeNull();
    expect(before(area("vex-portrait-plate"), chat)).toBe(true);
    expect(screen.queryByRole("switch", { name: "Show avatar" })).toBeNull();
  });
});
