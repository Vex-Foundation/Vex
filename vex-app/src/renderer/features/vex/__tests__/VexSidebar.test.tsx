/**
 * The Vex sidebar (docs/design/R3-MINIMAL.md section 5): information first,
 * then her face. What is pinned:
 *
 *  - HIDDEN is zero content: a closed column renders no head, no key, no
 *    state and no hologram, so nothing in a 0px track takes focus or paints;
 *  - the R3b ORDER: the state (scope, word, timer), the narration, the
 *    background missions, Needs you, then the portrait plate, then the
 *    avatar switch. In H3's frame (the agent shell and Studio) the plate is
 *    Kimm's section (`VexPortraitPlate` with `kimm`, plan row S4-04); K2's
 *    print window, her dock and her close stay on the Lighter desk until its
 *    restyle, so those blocks run there;
 *  - HER CHOICE (plan row S4-14, which retired R3's "Show avatar" foot and
 *    switch): closed, her section folds and the 44px flat token (no ring
 *    round it) stands beside the state, everything else stays; her corner
 *    key writes the one persisted choice; on the desk the same choice hides
 *    the K2 plate;
 *  - SHE DOCKS: a column that shows after the shell came up (off the
 *    welcome, or open again after a hide) plays her open episode; one open
 *    from the start shows her as she is;
 *  - HIDING PLAYS HER CLOSE FIRST: the hide key collapses her into the token
 *    and the column goes when that ends (the unmount waits), inert meanwhile,
 *    with focus handed to the token chip; a second press keeps her; the
 *    still frame, her figure hidden or a column the shell closes go at once;
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
/** Reduced motion or Save-Data, as the still-frame read answers it. */
const still = vi.hoisted(() => ({ current: false }));

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
vi.mock("../../../lib/motion/use-still-frame.js", () => ({
  prefersSaveData: () => false,
  prefersStillFrame: () => still.current,
  useStillFrame: () => still.current,
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
const { VEX_HIDE_EPISODE_MS, keepVex, vexClosing } = await import("../vex-hide.js");

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
    live: false,
    narration: "Calling Wallet balances to answer “And ETH?”",
    background: {
      count: 1,
      items: [],
      label: "1 mission running",
      summary: "1 mission running · Weekly rebalance",
    },
    needsYou: { status: "ready", unknownCopy: null, count: 0, items: [], retry: vi.fn(), retrying: false },
    ...overrides,
  };
}

function needs(items: NeedsYouItem[]): VexPresence["needsYou"] {
  return { status: "ready", unknownCopy: null, count: items.length, items, retry: vi.fn(), retrying: false };
}

function sidebar(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='vex-sidebar']");
  if (el === null) throw new Error("sidebar missing");
  return el;
}

function area(name: string): HTMLElement | null {
  return sidebar().querySelector<HTMLElement>(`[data-vex-area='${name}']`);
}

/** The column head's hide key (her corner key in H3's frame is also named Hide Vex). */
function headHideKey(): HTMLElement {
  const head = sidebar().querySelector<HTMLElement>(".vex-vs__head");
  if (head === null) throw new Error("head missing");
  return within(head).getByRole("button", { name: "Hide Vex" });
}

/** True when `a` comes before `b` in document order. */
function before(a: Element | null, b: Element | null): boolean {
  if (a === null || b === null) return false;
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

beforeEach(() => {
  window.localStorage.clear();
  still.current = false;
  presenceRef.current = presence();
  useUiStore.setState({
    runtimeMode: "agent",
    activeSessionId: SESSION,
    activeProjectId: null,
    shellRoute: { kind: "none" },
    showAvatar: true,
    vexOpenChat: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

    // H3's frame: her section where K2's print window stood, and no hologram.
    const plate = area("kimm-section");
    expect(plate).not.toBeNull();
    expect(document.querySelector("[data-vex-k2]")).toBeNull();
    // R3's "Show avatar" foot is gone: her choice is her section's (S4-14).
    expect(screen.queryByRole("switch", { name: "Show avatar" })).toBeNull();

    expect(before(state, needsYou)).toBe(true);
    expect(before(needsYou, plate)).toBe(true);
  });

  it("hides through its key, named for what it does", () => {
    still.current = true;
    const onHide = vi.fn();
    render(<VexSidebar open onHide={onHide} />);
    fireEvent.click(headHideKey());
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("commits a hide at once in H3's frame: her section's own wipe is the close", () => {
    const onHide = vi.fn();
    render(<VexSidebar open onHide={onHide} />);
    fireEvent.click(headHideKey());
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(sidebar().hasAttribute("inert")).toBe(false);
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
    expect(before(block, area("kimm-section"))).toBe(true);

    view.rerender(
      <>
        <VexSidebar open={false} onHide={() => {}} />
        <PageBlock />
      </>,
    );
    expect(screen.queryByTestId("page-block")).toBeNull();
  });
});

describe("VexSidebar, her section closed (her choice, S4-14)", () => {
  it("folds her section, keeps the token, the word, the narration and Needs you", () => {
    render(<VexSidebar open plate={false} stays onHide={() => {}} />);
    expect(area("kimm-section")?.getAttribute("data-kimm-open")).toBe("false");
    expect(area("vex-portrait-plate")).toBeNull();
    expect(document.querySelector("[data-vex-k2]")).toBeNull();
    const state = area("vex-state");
    expect(state?.querySelector("[data-vex-vx-token] svg")?.getAttribute("width")).toBe("44");
    // The kit's avatar off is the bare disc: no ring, the word carries the state.
    expect(state?.querySelector("[data-vex-status-ring]")).toBeNull();
    expect(state?.querySelector("[data-vex-status]")?.getAttribute("data-vex-status")).toBe(
      "working",
    );
    expect(state?.textContent).toContain("This chat: Working");
    expect(state?.textContent).toContain("Calling Wallet balances");
    expect(area("vex-needs-you")).not.toBeNull();
  });

  it("writes her one choice from her corner key, both ways, and never the retired avatar slot", () => {
    still.current = true;
    useUiStore.setState({ vexOpenChat: true, showAvatar: true });
    const view = render(<VexSidebar open stays onHide={() => {}} />);
    const key = (): HTMLElement => {
      const el = area("kimm-key");
      if (el === null) throw new Error("her corner key is missing");
      return el;
    };
    fireEvent.click(key());
    expect(useUiStore.getState().vexOpenChat).toBe(false);
    view.rerender(<VexSidebar open plate={false} stays onHide={() => {}} />);
    expect(key().textContent).toBe("Show Vex");
    fireEvent.click(key());
    expect(useUiStore.getState().vexOpenChat).toBe(true);
    expect(useUiStore.getState().showAvatar).toBe(true);
  });
});

describe("VexSidebar, a column that stays (H3, a chat)", () => {
  it("hides only her plate: the state, Needs you and the hide key stand, the flat token in her place", () => {
    const { container } = render(<VexSidebar open plate={false} stays onHide={() => {}} />);
    expect(container.querySelector("[data-vex-area='vex-portrait-plate']")).toBeNull();
    expect(container.querySelector("[data-vex-k2]")).toBeNull();
    expect(container.querySelector("[data-vex-area='vex-state']")).not.toBeNull();
    expect(container.querySelector("[data-vex-area='vex-needs-you']")).not.toBeNull();
    expect(headHideKey()).not.toBeNull();
    expect(container.querySelector("[data-vex-status]")).not.toBeNull();
  });

  it("closes and opens her section with the plate, never unmounting it", () => {
    const section = () => document.querySelector("[data-vex-area='kimm-section']");
    const { rerender } = render(<VexSidebar open stays onHide={() => {}} />);
    const mounted = section();
    expect(mounted?.getAttribute("data-kimm-open")).toBe("true");
    rerender(<VexSidebar open plate={false} stays onHide={() => {}} />);
    expect(section()).toBe(mounted);
    expect(section()?.getAttribute("data-kimm-open")).toBe("false");
    rerender(<VexSidebar open stays onHide={() => {}} />);
    expect(section()).toBe(mounted);
    expect(section()?.getAttribute("data-kimm-open")).toBe("true");
    expect(document.querySelector("[data-vex-k2]")).toBeNull();
  });
});

describe("VexSidebar, the dock (K2, on the Lighter desk)", () => {
  const holo = () => document.querySelector("[data-vex-k2]");
  beforeEach(() => {
    useUiStore.setState({ runtimeMode: "lighter" });
  });

  it("shows her as she is in a column open from the start", () => {
    render(<VexSidebar open onHide={() => {}} />);
    expect(holo()?.hasAttribute("data-vex-k2-open")).toBe(false);
  });

  it("plays her open episode when the column shows again after a hide", () => {
    const { rerender } = render(<VexSidebar open onHide={() => {}} />);
    rerender(<VexSidebar open={false} onHide={() => {}} />);
    expect(holo()).toBeNull();
    rerender(<VexSidebar open onHide={() => {}} />);
    expect(holo()?.hasAttribute("data-vex-k2-open")).toBe(true);
  });

  it("shows her section, not the hologram, in the welcome's column: nothing docks", () => {
    // docs/design/H3-DESKTOP.md section 1.7: the welcome keeps her column, in
    // the agent shell, where her plate is Kimm's section.
    useUiStore.setState({ runtimeMode: "agent", activeSessionId: null });
    const { rerender } = render(<VexSidebar open onHide={() => {}} />);
    expect(holo()).toBeNull();
    expect(area("kimm-section")).not.toBeNull();
    act(() => useUiStore.setState({ activeSessionId: "s-1" }));
    rerender(<VexSidebar open onHide={() => {}} />);
    expect(holo()).toBeNull();
    expect(area("kimm-section")).not.toBeNull();
  });

  it("plays it when her choice shows her again in an open column", () => {
    useUiStore.setState({ vexOpenChat: false });
    const { rerender } = render(<VexSidebar open={false} onHide={() => {}} />);
    rerender(<VexSidebar open onHide={() => {}} />);
    expect(holo()).toBeNull();
    act(() => useUiStore.setState({ vexOpenChat: true }));
    expect(holo()?.hasAttribute("data-vex-k2-open")).toBe(true);
  });
});

describe("VexSidebar, hiding plays her close first (K2, on the Lighter desk)", () => {
  const holo = () => document.querySelector("[data-vex-k2]");
  const hideKey = headHideKey;
  beforeEach(() => {
    useUiStore.setState({ runtimeMode: "lighter" });
  });

  it("collapses her into the token, and the column goes when that ends", () => {
    vi.useFakeTimers();
    const onHide = vi.fn();
    render(<VexSidebar open onHide={onHide} />);
    fireEvent.click(hideKey());
    expect(onHide).not.toHaveBeenCalled();
    expect(holo()?.hasAttribute("data-vex-k2-closed")).toBe(true);
    expect(sidebar().hasAttribute("data-vex-vs-closing")).toBe(true);
    expect(vexClosing()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(VEX_HIDE_EPISODE_MS - 1);
    });
    expect(onHide).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(vexClosing()).toBe(false);
  });

  it("is inert while she closes, and hands focus to the token chip", () => {
    vi.useFakeTimers();
    render(
      <>
        <button type="button" data-vex-area="vex-token-chip">
          Vex, Working
        </button>
        <VexSidebar open onHide={() => {}} />
      </>,
    );
    hideKey().focus();
    fireEvent.click(hideKey());
    expect(sidebar().hasAttribute("inert")).toBe(true);
    expect(document.activeElement?.getAttribute("data-vex-area")).toBe("vex-token-chip");
  });

  it("keeps her on a second press: she opens again and nothing is written", () => {
    vi.useFakeTimers();
    const onHide = vi.fn();
    render(<VexSidebar open onHide={onHide} />);
    fireEvent.click(hideKey());
    act(() => {
      keepVex();
    });
    expect(holo()?.hasAttribute("data-vex-k2-closed")).toBe(false);
    expect(sidebar().hasAttribute("inert")).toBe(false);
    expect(vexClosing()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(VEX_HIDE_EPISODE_MS * 2);
    });
    expect(onHide).not.toHaveBeenCalled();
  });

  it("goes at once under the still frame (reduced motion or Save-Data)", () => {
    still.current = true;
    const onHide = vi.fn();
    render(<VexSidebar open onHide={onHide} />);
    fireEvent.click(hideKey());
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(sidebar().hasAttribute("inert")).toBe(false);
  });

  it("goes at once with her figure hidden by her choice, where there is nothing of her to close", () => {
    useUiStore.setState({ vexOpenChat: false });
    const onHide = vi.fn();
    render(
      <>
        <button type="button" data-vex-area="vex-token-chip">
          Vex, Working
        </button>
        <VexSidebar open onHide={onHide} />
      </>,
    );
    hideKey().focus();
    fireEvent.click(hideKey());
    expect(onHide).toHaveBeenCalledTimes(1);
    // The column is about to go: focus moves out of it first.
    expect(document.activeElement?.getAttribute("data-vex-area")).toBe("vex-token-chip");
  });

  it("drops the close when the shell closes the column on its own", () => {
    vi.useFakeTimers();
    const onHide = vi.fn();
    const { rerender } = render(<VexSidebar open onHide={onHide} />);
    fireEvent.click(hideKey());
    rerender(<VexSidebar open={false} onHide={onHide} />);
    expect(vexClosing()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(VEX_HIDE_EPISODE_MS * 2);
    });
    expect(onHide).not.toHaveBeenCalled();
    expect(sidebar().hasAttribute("inert")).toBe(false);
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
      name: `Review ↓: ${item.title}`,
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
    fireEvent.click(screen.getByRole("button", { name: `Review: ${item.title}` }));
    expect(useUiStore.getState().activeSessionId).toBe(other);
  });

  it("says a read it could not make is unknown, never zero", () => {
    presenceRef.current = presence({
      needsYou: { status: "unknown", unknownCopy: "Couldn't check for pending approvals. Some may be waiting for your signature.", count: null, items: [], retry: vi.fn(), retrying: false },
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
