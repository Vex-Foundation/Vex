/**
 * The Vex sidebar (docs/design/H3-DESKTOP.md sections 1.5 and 1.9): her
 * console, her plate over its rest, and the page strip. What is pinned:
 *
 *  - HIDDEN is zero content: a closed column renders nothing, so nothing in a
 *    0px track takes focus or paints; on a table page it is the page strip;
 *  - the ORDER: the console's top block (Needs you, the missions row), then
 *    the portrait plate (in H3's frame Kimm's section, plan rows S4-04 on),
 *    then the console's rest (This project, a page's block, AI permission,
 *    recent activity), inert while her section covers it (S4-11);
 *  - no head row, no state block, no avatar switch of its own (S3-11): the
 *    header's Vex key says her state and hides her, and her one remembered
 *    choice (`vexOpenChat`) replaced "Show avatar" (S4-14); her corner key in
 *    her section writes that choice, hiding through the frame's `onHide`;
 *  - Kimm's section is her plate everywhere, the welcome's column and the
 *    Lighter desk included, open or folded by the stored choice;
 *  - A HIDE LANDS AT THE PRESS: her section's own wipe is the close, so a
 *    hide (the Vex key, the chip, the shortcut) commits at once, the column
 *    never inert, with focus handed to the toggle where the column goes and
 *    kept where it stays;
 *  - Needs you never decides: its key opens the card, and only closes a
 *    page over the chat;
 *  - STUDIO: the "This project" block opens the project's own Project assets
 *    and Agent Scan, never a session's or the global register;
 *  - LIGHTER: R3's Needs you list, then the desk chat under the plate in the
 *    Lighter role scope.
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
// `VexConsole.test.tsx`'s. Here the chat's read has not answered.
vi.mock("../../../lib/api/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSession: () => ({ data: undefined }),
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
const { DURATION_VEX_CLOSE_MS } = await import("../../../lib/motion/index.js");

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

describe("VexSidebar, open", () => {
  it("is her console: the top block, then her plate, then the console's rest", () => {
    render(<VexSidebar open onHide={() => {}} />);
    expect(sidebar().getAttribute("data-vex-vex-open")).toBe("true");

    const top = area("vex-console-top");
    expect(top?.querySelector("[data-vex-area='vex-needs-you']")?.textContent).toContain(
      "Nothing needs you.",
    );
    expect(top?.querySelector("[data-vex-area='vex-missions']")?.textContent).toBe(
      "1 mission running on Mainnet",
    );

    // H3's frame: her section is the plate, and no other figure stands.
    const plate = area("kimm-section");
    expect(plate).not.toBeNull();
    expect(area("vex-portrait-plate")).toBeNull();
    expect(document.querySelector("[data-vex-k2]")).toBeNull();

    const rest = area("vex-console-rest");
    expect(rest?.querySelector("[data-vex-area='vex-recent-activity']")).not.toBeNull();

    expect(before(top, plate)).toBe(true);
    expect(before(plate, rest)).toBe(true);
  });

  it("draws no head row, no state block and no avatar switch of its own (S3-11)", () => {
    render(<VexSidebar open onHide={() => {}} />);
    // The header's Vex key says her state and hides her; Settings keeps the
    // avatar preference.
    expect(sidebar().querySelector("header")).toBeNull();
    expect(within(sidebar()).queryByText("Vex")).toBeNull();
    expect(area("vex-state")).toBeNull();
    expect(area("vex-background")).toBeNull();
    // The one Hide Vex in the column is her section's own corner key (S4-04).
    expect(
      within(sidebar())
        .queryAllByRole("button", { name: "Hide Vex" })
        .map((key) => key.getAttribute("data-vex-area")),
    ).toEqual(["kimm-key"]);
    expect(within(sidebar()).queryByRole("switch")).toBeNull();
    expect(sidebar().textContent).not.toContain("Show avatar");
    // Nor the narration the state block carried.
    expect(sidebar().textContent).not.toContain("Calling Wallet balances");
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

  it("commits a hide at once in H3's frame: her section's own wipe is the close", () => {
    const onHide = vi.fn();
    render(<VexSidebar open onHide={onHide} />);
    act(() => {
      requestVexHide(onHide);
    });
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(sidebar().hasAttribute("inert")).toBe(false);
  });

  it("hides through the frame's onHide from her corner key, and shows her through her choice", () => {
    const onHide = vi.fn();
    useUiStore.setState({ vexOpenChat: false });
    const view = render(<VexSidebar open plate={false} stays onHide={onHide} />);
    const key = (): HTMLElement => {
      const el = area("kimm-key");
      if (el === null) throw new Error("her corner key is missing");
      return el;
    };
    fireEvent.click(key());
    expect(useUiStore.getState().vexOpenChat).toBe(true);
    view.rerender(<VexSidebar open stays onHide={onHide} />);
    fireEvent.click(key());
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("makes the console's rest inert while her section covers it, and live in her strip", () => {
    vi.useFakeTimers();
    const view = render(<VexSidebar open stays onHide={() => {}} />);
    expect(area("vex-console-rest")?.hasAttribute("inert")).toBe(true);
    expect(area("vex-console-top")?.hasAttribute("inert")).toBe(false);
    view.rerender(<VexSidebar open plate={false} stays onHide={() => {}} />);
    // Until the close has ended she still covers it.
    expect(area("vex-console-rest")?.hasAttribute("inert")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DURATION_VEX_CLOSE_MS);
    });
    expect(area("vex-console-rest")?.hasAttribute("inert")).toBe(false);
  });
});

describe("VexSidebar, the page slot", () => {
  it("takes a page's block in the console's rest while open, and drops it when hidden", () => {
    const view = render(
      <>
        <VexSidebar open onHide={() => {}} />
        <PageBlock />
      </>,
    );
    const block = screen.getByTestId("page-block");
    expect(area("vex-sidebar-slot")?.contains(block)).toBe(true);
    expect(area("vex-console-rest")?.contains(block)).toBe(true);
    expect(before(area("vex-needs-you"), block)).toBe(true);

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
  it("folds her section to its strip; the console stands, and no avatar slot is read", () => {
    useUiStore.setState({ showAvatar: false });
    render(<VexSidebar open plate={false} stays onHide={() => {}} />);
    expect(area("kimm-section")?.getAttribute("data-kimm-open")).toBe("false");
    expect(document.querySelector("[data-vex-k2]")).toBeNull();
    expect(area("vex-console-top")).not.toBeNull();
    expect(area("vex-console-rest")).not.toBeNull();
  });

  it("folds her section on the desk when her choice is closed", () => {
    useUiStore.setState({ runtimeMode: "lighter", vexOpenChat: false });
    render(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-portrait-plate")).toBeNull();
    expect(document.querySelector("[data-vex-k2]")).toBeNull();
  });
});

describe("VexSidebar, a column that stays (H3, a chat)", () => {
  it("hides only her plate: the console stands, its rest under the top block", () => {
    const { container } = render(<VexSidebar open plate={false} stays onHide={() => {}} />);
    expect(container.querySelector("[data-vex-area='vex-portrait-plate']")).toBeNull();
    expect(container.querySelector("[data-vex-k2]")).toBeNull();
    const top = container.querySelector("[data-vex-area='vex-console-top']");
    const rest = container.querySelector("[data-vex-area='vex-console-rest']");
    const section = container.querySelector("[data-vex-area='kimm-section']");
    expect(top).not.toBeNull();
    // Her section stands between them, laid over the rest (her strip, closed).
    expect(top?.nextElementSibling).toBe(section);
    expect(section?.nextElementSibling).toBe(rest);
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

describe("VexSidebar, her section everywhere (no other figure in her column)", () => {
  const holo = () => document.querySelector("[data-vex-k2]");

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
    expect(section?.querySelector("h3")?.textContent).toBe("Needs you: 1");
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

  it("says a read it could not make is unknown, never zero", () => {
    presenceRef.current = presence({
      needsYou: { status: "unknown", unknownCopy: "Couldn't check for pending approvals. Some may be waiting for your signature.", count: null, items: [], retry: vi.fn(), retrying: false },
    });
    render(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-needs-you")?.querySelector("h3")?.textContent).toBe("Needs you: ?");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
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
    expect(section?.querySelector("h3")?.textContent).toBe("Needs you: 1");
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
    // Where a chat's AI permission stands: after Needs you, before recent activity.
    expect(before(area("vex-needs-you"), block)).toBe(true);
    expect(before(block, area("vex-recent-activity"))).toBe(true);
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

  it("scopes recent activity to the project, and Open activity opens that scope", () => {
    render(<VexSidebar open onHide={() => {}} />);
    expect(area("vex-recent-activity")?.getAttribute("data-vex-activity-scope")).toBe("project");
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
