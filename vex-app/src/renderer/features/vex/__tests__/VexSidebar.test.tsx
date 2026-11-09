/**
 * The Vex sidebar (docs/design/H3-DESKTOP.md sections 1.9 and 6): D2's
 * column at the right edge, the page strip, the desk's column. Pinned:
 *
 *  - A CLOSED COLUMN is zero content: nothing in a 0px track takes focus or
 *    paints; on a table page it is the page strip;
 *  - D2's ORDER, top to bottom: Kimm's portrait card, the state row with its
 *    timer, THIS CHAT and Vex's line, the console's top block (Needs you, the
 *    missions row), a page's block, Open activity; no AI permission and no
 *    recent activity in the column any more;
 *  - HIDING HIDES THE WHOLE BODY in a chat (D2, section 6.4): the column is
 *    `#vex-section` and keeps its ground and rule only; focus inside it goes
 *    to the header's key; no wipe, no strip, no corner key, no hint;
 *  - Needs you never decides: its key opens the card, and only closes a
 *    page over the chat;
 *  - STUDIO: the "This project" block takes THIS CHAT's place and opens the
 *    project's own Project assets and Agent Scan;
 *  - LIGHTER (unchanged by D2): the console's top block, Kimm's section over
 *    it and the desk chat, in the Lighter role scope.
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
  // Every session's missions, the open one's included: the console's row.
  useAllMissions: () => presenceRef.current?.background ?? null,
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
        agents: ["claude-code", "codex"],
        wallets: {
          evm: { id: "evm-1", address: "0x7e57a11e7000000000000000000000000000b45e" },
          solana: null,
        },
      },
    },
  }),
}));
// This project names the project's wallet by the inventory's own label.
vi.mock("../../../lib/api/wallet-inventory.js", () => ({
  useAvailableWallets: () => ({
    data: {
      ok: true,
      data: {
        evm: [{ id: "evm-1", address: "0x7e57a11e7000000000000000000000000000b45e", label: "Main wallet" }],
        solana: [],
      },
    },
  }),
}));
vi.mock("../../../lib/motion/use-still-frame.js", () => ({
  prefersSaveData: () => false,
  prefersStillFrame: () => still.current,
  useStillFrame: () => still.current,
}));
// The console's recent activity reads the activity feed; its rows are
// `VexConsole.test.tsx`'s. Here the read has not answered.
vi.mock("../../../lib/api/portfolio.js", () => ({
  useAgentScanInfinite: () => ({ isLoading: true, isError: false, data: undefined }),
}));
// The console's AI permission reads the open chat; its words are
// `VexConsole.test.tsx`'s. Here the chat's read has not answered, and the
// sessions list (the missions row reads its failure) has not failed.
vi.mock("../../../lib/api/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSession: () => ({ data: undefined }),
  useSessionsList: () => ({ data: undefined, isError: false }),
}));
vi.mock("../../appShell/lighterTrading/LighterChatRail.js", () => ({
  LighterChatRail: () => <div data-testid="desk-chat" />,
}));

const { VexSidebar } = await import("../VexSidebar.js");
const { useVexSidebarSlot } = await import("../vex-sidebar-slot.js");
const { createPortal } = await import("react-dom");

/** A focusable block in the column's slot (the desk has no missions row). */
function FocusBlock(): JSX.Element | null {
  const slot = useVexSidebarSlot();
  return slot === null
    ? null
    : createPortal(
        <button type="button" data-testid="slot-key">
          Ask Vex
        </button>,
        slot,
      );
}

/** A page's block, portalled into the sidebar's slot while there is one. */
function PageBlock(): JSX.Element | null {
  const slot = useVexSidebarSlot();
  return slot === null ? null : createPortal(<p data-testid="page-block">Ask Vex</p>, slot);
}
const { useUiStore } = await import("../../../stores/uiStore.js");
const { requestVexHide, vexClosing } = await import("../vex-hide.js");

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

describe("VexSidebar, the page strip (H3-DESKTOP.md section 1.9)", () => {
  const strip = (): HTMLElement | null =>
    document.querySelector<HTMLElement>("[data-vex-area='vex-console-strip']");

  it("folds the console to one line on a table page with her closed", () => {
    const item = approvalNeedsYouItem(
      approval({ id: "a9", sessionId: "00000000-0000-4000-8000-0000000000c3" }),
      NOW,
    );
    presenceRef.current = presence({ needsYou: needs([item]) });
    useUiStore.setState({ shellRoute: { kind: "portfolio", origin: null } });
    render(<VexSidebar open={false} onHide={() => {}} />);
    expect(sidebar().getAttribute("data-vex-seat")).toBe("strip");
    expect(sidebar().getAttribute("data-vex-vex-open")).toBe("false");
    // NEEDS YOU and its count, the one decision, the missions cell, Open activity.
    const line = strip();
    expect(line?.querySelector(".vex-console__label")?.textContent).toBe("Needs you");
    expect(line?.querySelector(".vex-console__count")?.textContent).toBe("1");
    const review = within(line ?? sidebar()).getByRole("button", { name: `Review: ${item.title}` });
    expect(line?.querySelector("[data-vex-area='vex-strip-missions']")?.textContent).toBe(
      "1 mission running on Mainnet",
    );
    expect(within(line ?? sidebar()).getByRole("button", { name: "Open activity" })).not.toBeNull();
    // Nothing of her column stands: no Needs you section, no plate.
    expect(area("vex-needs-you")).toBeNull();
    expect(document.querySelector("[data-vex-k2]")).toBeNull();
    fireEvent.click(review);
    expect(useUiStore.getState().activeSessionId).toBe("00000000-0000-4000-8000-0000000000c3");
  });

  it("says Nothing needs you. in the strip at zero, and draws no strategies cell", () => {
    useUiStore.setState({ shellRoute: { kind: "settings", origin: null, section: null } });
    render(<VexSidebar open={false} onHide={() => {}} />);
    expect(strip()?.textContent).toContain("Nothing needs you.");
    expect(strip()?.textContent).not.toMatch(/strateg/i);
  });

  it("is never drawn in a chat, on a page that is not a table page, or on the Lighter desk", () => {
    const { rerender } = render(<VexSidebar open={false} onHide={() => {}} />);
    expect(strip()).toBeNull();
    act(() => useUiStore.setState({ shellRoute: { kind: "memory", origin: null } }));
    rerender(<VexSidebar open={false} onHide={() => {}} />);
    expect(strip()).toBeNull();
    act(() => useUiStore.setState({ runtimeMode: "lighter", shellRoute: { kind: "portfolio", origin: null } }));
    rerender(<VexSidebar open={false} onHide={() => {}} />);
    expect(strip()).toBeNull();
  });

  it("gives way to her column when she opens on the page", () => {
    useUiStore.setState({ shellRoute: { kind: "portfolio", origin: null } });
    render(<VexSidebar open onHide={() => {}} />);
    expect(strip()).toBeNull();
    expect(sidebar().getAttribute("data-vex-seat")).toBe("column");
    expect(area("vex-needs-you")).not.toBeNull();
  });
});

describe("VexSidebar, open (D2's column)", () => {
  it("is D2's column: the portrait card, the state row, THIS CHAT, Needs you, missions, Open activity", () => {
    render(<VexSidebar open onHide={() => {}} />);
    expect(sidebar().getAttribute("data-vex-vex-open")).toBe("true");
    expect(sidebar().getAttribute("data-vex-shown")).toBe("true");
    // The column is what every toggle names.
    expect(sidebar().id).toBe("vex-section");

    const card = area("vex-portrait-card");
    expect(card?.querySelector("[data-vex-area='kimm-panel']")?.getAttribute("data-kimm-seat")).toBe("card");
    const state = area("vex-state-row");
    expect(state?.getAttribute("data-vex-state")).toBe("working");
    expect(state?.textContent).toBe("Working");
    const thisChat = area("vex-this-chat");
    expect(thisChat?.querySelector(".vex-col__label")?.textContent).toBe("This chat");
    expect(thisChat?.textContent).toContain("Calling Wallet balances to answer");
    const top = area("vex-console-top");
    expect(top?.querySelector("[data-vex-area='vex-needs-you']")?.textContent).toContain("Nothing needs you.");
    expect(top?.querySelector("[data-vex-area='vex-missions']")?.textContent).toBe("1 mission running on Mainnet");
    const foot = area("vex-column-foot");
    expect(within(foot ?? sidebar()).getByRole("button", { name: "Open activity" })).not.toBeNull();

    expect(before(card, state)).toBe(true);
    expect(before(state, thisChat)).toBe(true);
    expect(before(thisChat, top)).toBe(true);
    expect(before(top, foot)).toBe(true);
    // No AI permission, no recent activity, and none of H3's section.
    expect(area("vex-permission")).toBeNull();
    expect(area("vex-recent-activity")).toBeNull();
    expect(area("vex-console-rest")).toBeNull();
    expect(area("kimm-section")).toBeNull();
    expect(area("kimm-key")).toBeNull();
    expect(document.querySelector("[data-vex-k2]")).toBeNull();
  });

  it("times a live turn at the state row's right end", () => {
    presenceRef.current = presence({ state: "thinking", word: "Thinking", timerStartedAt: Date.now() - 3_000, live: true });
    render(<VexSidebar open onHide={() => {}} />);
    const state = area("vex-state-row");
    expect(state?.querySelector(".vex-col__timer")?.textContent).toMatch(/^0:0\d$/);
  });

  it("says what Vex does in this chat from real parts, or nothing waiting at rest", () => {
    presenceRef.current = presence({ state: "ready", word: "Ready", narration: null });
    const view = render(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-this-chat")?.querySelector(".vex-col__line")?.textContent).toBe("Nothing waiting in your chats.");
    // Decisions waiting elsewhere are said, never "nothing waiting".
    const item = approvalNeedsYouItem(approval({ id: "a7", sessionId: "00000000-0000-4000-8000-0000000000c3" }), NOW);
    presenceRef.current = presence({ state: "ready", word: "Ready", narration: null, needsYou: needs([item]) });
    view.rerender(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-this-chat")?.querySelector(".vex-col__line")?.textContent).toBe("One decision waits for you.");
    // A read that never answered claims nothing.
    presenceRef.current = presence({
      state: "ready",
      word: "Ready",
      narration: null,
      needsYou: { status: "loading", unknownCopy: null, count: null, items: [], retry: vi.fn(), retrying: false },
    });
    view.rerender(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-this-chat")?.querySelector(".vex-col__line")).toBeNull();
    // A mission names its own scope.
    presenceRef.current = presence({ scope: "This mission:" });
    view.rerender(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-this-chat")?.querySelector(".vex-col__label")?.textContent).toBe("This mission");
  });

  it("draws no head row, no hide key and no avatar switch of its own", () => {
    render(<VexSidebar open onHide={() => {}} />);
    // The header's VEX cell holds the one hide key; Settings keeps the
    // avatar preference.
    expect(sidebar().querySelector("header")).toBeNull();
    expect(within(sidebar()).queryAllByRole("button", { name: /^(Hide|Show) Vex$/ })).toHaveLength(0);
    expect(within(sidebar()).queryByRole("switch")).toBeNull();
    expect(sidebar().textContent).not.toContain("Show avatar");
  });

  it("hides through the toggle's close, the Vex key's and the shortcut's", () => {
    still.current = true;
    const onHide = vi.fn();
    render(<VexSidebar open onHide={onHide} />);
    act(() => {
      requestVexHide(onHide);
    });
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("commits a hide at once: there is no wipe to wait for", () => {
    const onHide = vi.fn();
    render(<VexSidebar open onHide={onHide} />);
    act(() => {
      requestVexHide(onHide);
    });
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(sidebar().hasAttribute("inert")).toBe(false);
    expect(vexClosing()).toBe(false);
  });
});

describe("VexSidebar, hidden in a chat (D2, section 6.4)", () => {
  it("keeps the column and shows its ground and rule only", () => {
    const view = render(<VexSidebar open plate={false} onHide={() => {}} />);
    expect(sidebar().getAttribute("data-vex-vex-open")).toBe("true");
    expect(sidebar().getAttribute("data-vex-shown")).toBe("false");
    expect(sidebar().id).toBe("vex-section");
    expect(sidebar().childElementCount).toBe(0);
    expect(screen.queryByRole("button")).toBeNull();
    // Shown again, the whole body comes back.
    view.rerender(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-portrait-card")).not.toBeNull();
    expect(area("vex-console-top")).not.toBeNull();
  });

  it("hands focus inside the column to the header's key as it hides", () => {
    render(
      <>
        <button type="button" data-vex-area="vex-key">
          Hide Vex
        </button>
        <VexSidebar open onHide={() => {}} />
      </>,
    );
    const inside = within(sidebar()).getByRole("button", { name: "Open activity" });
    inside.focus();
    act(() => {
      requestVexHide(() => {});
    });
    expect(document.activeElement?.getAttribute("data-vex-area")).toBe("vex-key");
  });
});

describe("VexSidebar, the page slot", () => {
  it("takes a page's block under Needs you while shown, and drops it when hidden", () => {
    const view = render(
      <>
        <VexSidebar open onHide={() => {}} />
        <PageBlock />
      </>,
    );
    const block = screen.getByTestId("page-block");
    expect(area("vex-sidebar-slot")?.contains(block)).toBe(true);
    expect(before(area("vex-needs-you"), block)).toBe(true);
    expect(before(block, area("vex-column-foot"))).toBe(true);

    view.rerender(
      <>
        <VexSidebar open plate={false} onHide={() => {}} />
        <PageBlock />
      </>,
    );
    expect(screen.queryByTestId("page-block")).toBeNull();
  });
});

describe("VexSidebar, her figure (no other figure in her column)", () => {
  const holo = () => document.querySelector("[data-vex-k2]");

  it("shows her portrait card, not the hologram, in the welcome's column: nothing docks", () => {
    // The welcome keeps her column (section 1.7), its card included.
    useUiStore.setState({ runtimeMode: "agent", activeSessionId: null });
    const { rerender } = render(<VexSidebar open onHide={() => {}} />);
    expect(holo()).toBeNull();
    expect(area("vex-portrait-card")).not.toBeNull();
    // The welcome has no scope: it is a chat about to start.
    expect(area("vex-this-chat")?.querySelector(".vex-col__label")?.textContent).toBe("This chat");
    act(() => useUiStore.setState({ activeSessionId: "s-1" }));
    rerender(<VexSidebar open onHide={() => {}} />);
    expect(holo()).toBeNull();
    expect(area("vex-portrait-card")).not.toBeNull();
  });

  it("on the Lighter desk is Kimm's section too, open or folded by the desk's choice", () => {
    // The approved desk plate (section 4.9): her section over the desk chat.
    useUiStore.setState({ runtimeMode: "lighter" });
    const { rerender } = render(<VexSidebar open plate stays onHide={() => {}} />);
    expect(holo()).toBeNull();
    const section = area("kimm-section");
    expect(section?.getAttribute("data-kimm-open")).toBe("true");
    rerender(<VexSidebar open plate={false} stays onHide={() => {}} />);
    // Folded to the strip by its clip alone: the same box, the chat stays.
    expect(area("kimm-section")).toBe(section);
    expect(section?.getAttribute("data-kimm-open")).toBe("false");
    expect(area("vex-desk-chat")).not.toBeNull();
  });
});

describe("VexSidebar, hiding on the Lighter desk", () => {
  beforeEach(() => {
    useUiStore.setState({ runtimeMode: "lighter" });
  });
  /** A press of the header's Vex key or the shortcut. */
  const hide = (onHide: () => void): void => {
    act(() => {
      requestVexHide(onHide);
    });
  };
  /** A control inside the column that can hold focus: a block in its slot. */
  const insideKey = (): HTMLElement => screen.getByTestId("slot-key");

  it("folds her at the press: her section's own wipe is the close, nothing waits", () => {
    const onHide = vi.fn();
    render(<VexSidebar open stays onHide={onHide} />);
    hide(onHide);
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(sidebar().hasAttribute("inert")).toBe(false);
    expect(vexClosing()).toBe(false);
  });

  it("keeps focus where it is in a column that stays", () => {
    render(
      <>
        <button type="button" data-vex-area="vex-key">
          Show Vex
        </button>
        <VexSidebar open stays onHide={() => {}} />
        <FocusBlock />
      </>,
    );
    insideKey().focus();
    hide(() => {});
    expect(document.activeElement).toBe(insideKey());
  });

  it("goes at once under the still frame (reduced motion or Save-Data)", () => {
    still.current = true;
    const onHide = vi.fn();
    render(<VexSidebar open onHide={onHide} />);
    hide(onHide);
    expect(onHide).toHaveBeenCalledTimes(1);
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

    // The console's Needs you (H3-DESKTOP.md section 1.5): the head and its
    // count, then the one decision row.
    const section = area("vex-needs-you");
    expect(section?.querySelector("h2")?.textContent).toBe("Needs you: 1");
    expect(section?.querySelector("[data-vex-area='vex-needs-you-row']")).not.toBeNull();
    const review = within(section ?? sidebar()).getByRole("button", {
      name: `Review: ${item.title}`,
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

  it("says a read it could not make is Not available, never zero, with no count", () => {
    presenceRef.current = presence({
      needsYou: { status: "unknown", unknownCopy: "Couldn't check for pending approvals. Some may be waiting for your signature.", count: null, items: [], retry: vi.fn(), retrying: false },
    });
    render(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-needs-you")?.querySelector("h2")?.textContent).toBe("Needs you");
    expect(area("vex-needs-you-row")?.textContent).toBe("Not available");
    // VEX Cloud's console: a polled read offers no Retry.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("draws the console's Needs you on the Lighter desk too (the approved desk plate)", () => {
    const item = approvalNeedsYouItem(
      approval({ id: "a4", sessionId: SESSION, toolName: "BridgeExecute", sessionTitle: "Treasury chat" }),
      NOW,
    );
    presenceRef.current = presence({ needsYou: needs([item]) });
    useUiStore.setState({ runtimeMode: "lighter" });
    render(<VexSidebar open onHide={() => {}} />);
    const section = area("vex-needs-you");
    expect(section?.querySelector("h2")?.textContent).toBe("Needs you: 1");
    expect(section?.querySelector("[data-vex-area='vex-needs-you-row']")).not.toBeNull();
    expect(section?.querySelector("[data-vex-area='needs-you-list']")).toBeNull();
  });
});

describe("VexSidebar in Studio: This project", () => {
  beforeEach(() => {
    useUiStore.setState({ runtimeMode: "studio", activeProjectId: PROJECT });
    presenceRef.current = presence({ scope: "This project:", state: "ready", word: "Ready", fill: "idle" });
  });

  it("states the access in the project dialog's words, then the agents, the wallet and the folder", () => {
    render(<VexSidebar open onHide={() => {}} />);
    const block = area("vex-this-project");
    expect(block).not.toBeNull();
    expect(block?.getAttribute("data-permission")).toBe("full");
    expect(block?.querySelector(".vex-console__permission-sentence")?.textContent).toBe(
      "Full access: agents execute supported Vex wallet actions without per-call approval.",
    );
    const facts = [...(block?.querySelectorAll(".vex-console__fact") ?? [])].map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ]);
    expect(facts).toEqual([
      ["Agents", "Claude Code, Codex CLI"],
      ["Wallet", "Main wallet 0x7e57…b45e"],
      ["Folder", "~/Vex/projects/core-tools"],
    ]);
    // Where a chat's THIS CHAT stands: under the state row, before Needs you.
    expect(before(area("vex-state-row"), block)).toBe(true);
    expect(before(block, area("vex-needs-you"))).toBe(true);
    expect(area("vex-this-chat")).toBeNull();
    expect(area("vex-permission")).toBeNull();
  });

  it("opens the project's settings from Change in project settings", async () => {
    const { useProjectDialogStore } = await import(
      "../../appShell/studio/projects/project-dialog-intent.js"
    );
    render(<VexSidebar open onHide={() => {}} />);
    const link = screen.getByRole("button", { name: "Change in project settings" });
    expect(link.className).toBe("vex-console__link");
    fireEvent.click(link);
    expect(JSON.stringify(useProjectDialogStore.getState())).toContain(PROJECT);
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

  it("opens the project's activity from Open activity", () => {
    render(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-open-activity")?.getAttribute("data-vex-activity-scope")).toBe("project");
    fireEvent.click(screen.getByRole("button", { name: "Open activity" }));
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
  it("stands the console's top block, her section and the desk chat, in the Lighter role scope", () => {
    // The approved desk plate (H3-DESKTOP.md section 4.9): the console's top,
    // her section as a box over the column, the desk chat under it.
    useUiStore.setState({ runtimeMode: "lighter" });
    render(<VexSidebar open stays onHide={() => {}} />);
    expect(sidebar().className).toContain("lit-chat-frame");
    expect(sidebar().getAttribute("data-lighter-theme")).toBe(useUiStore.getState().theme);
    const chat = area("vex-desk-chat");
    expect(chat?.querySelector("[data-testid='desk-chat']")).not.toBeNull();
    expect(before(area("vex-console-top"), area("kimm-section"))).toBe(true);
    expect(before(area("kimm-section"), chat)).toBe(true);
    expect(area("vex-portrait-plate")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Show avatar" })).toBeNull();
  });
});
