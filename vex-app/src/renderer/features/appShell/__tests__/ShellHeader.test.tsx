/**
 * THE HEADER (docs/design/H3-DESKTOP.md sections 1.3 and 6.2): one row of
 * named cells across the window, in D2's order (the VEX cell over Vex's
 * column at the right edge, NEEDS YOU after the chat's title), and the one
 * place the running head, with the approvals live sync in it, is mounted.
 *
 * The invariant is the reason the header exists in this shape. Preload allows
 * one subscriber per event kind per window (`RunningHead.tsx`), so the sync
 * must be mounted exactly once and never remounted while the window lives:
 * not by a mode switch, not by the welcome edge, not by the chats column
 * folding to its rail, not by a new column template. The sync is counted
 * through its own mount and unmount here, which is stronger than counting
 * nodes: a remount leaves one node in the DOM and still drops and retakes the
 * subscription.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { useEffect, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMode } from "../../../stores/uiStore.js";

const sync = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock("../GlobalApprovals.js", () => ({
  GlobalApprovalsSync: function CountedSync(): JSX.Element {
    useEffect(() => {
      sync.mounts += 1;
      return () => {
        sync.unmounts += 1;
      };
    }, []);
    return <span data-testid="approvals-sync" hidden />;
  },
}));
vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionModel: () => ({ data: undefined }),
  useSession: () => ({ data: undefined }),
}));
vi.mock("../../../lib/api/projects.js", () => ({
  useProject: () => ({ data: undefined }),
}));
vi.mock("../../../lib/api/studio.js", () => ({
  useStudioHostStatus: () => ({ data: undefined }),
}));
vi.mock("../MissionRail.js", () => ({ MissionRail: () => null }));
vi.mock("../SessionExportControl.js", () => ({ SessionExportControl: () => null }));
vi.mock("../NotificationCenter.js", () => ({ NotificationCenter: () => null }));
vi.mock("../../vex/NeedsYouAnnouncer.js", () => ({
  NeedsYouAnnouncer: () => <span data-testid="needs-you-announcer" />,
}));
vi.mock("../../vex/VexKey.js", () => ({
  VexKey: ({ open, onToggle }: { open: boolean; onToggle: () => void }) => (
    <button type="button" data-testid="vex-key" aria-expanded={open} onClick={onToggle} />
  ),
}));
vi.mock("../../vex/VexHeadCell.js", () => ({
  VexHeadCell: ({ open, onToggle, held }: { open: boolean; onToggle: () => void; held: string | null }) => (
    <button
      type="button"
      data-testid="vex-head-cell"
      data-held={held ?? undefined}
      aria-expanded={open}
      onClick={onToggle}
    />
  ),
}));
vi.mock("../../vex/NeedsYouHeadCell.js", () => ({
  NeedsYouHeadCell: () => <div data-vex-head-cell="needs" data-testid="needs-you-head" />,
}));

const { ShellHeader } = await import("../ShellHeader.js");
const { shellHeadTemplateColumns } = await import("../../../lib/shell-columns.js");

interface Shape {
  readonly mode: RuntimeMode;
  readonly empty?: boolean;
  readonly rail?: boolean;
  readonly chats?: number;
}

function header({ mode, empty = false, rail = false, chats = 264 }: Shape): JSX.Element {
  return (
    <QueryClientProvider client={client}>
      <ShellHeader
        runtimeMode={mode}
        activeSessionId={empty ? null : "s-1"}
        empty={empty}
        vex={empty ? null : { open: true, onToggle: () => undefined }}
        columns={shellHeadTemplateColumns({ chats: rail ? 56 : chats, vex: null })}
        chatsRail={rail}
        onToggleSidebar={() => undefined}
      />
    </QueryClientProvider>
  );
}

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  sync.mounts = 0;
  sync.unmounts = 0;
});

afterEach(() => {
  cleanup();
});

describe("the header", () => {
  it("is one header element over the columns, a drag region", () => {
    render(header({ mode: "agent" }));
    const heads = document.querySelectorAll("[data-vex-area='shell-head']");
    expect(heads).toHaveLength(1);
    expect(heads[0]?.tagName).toBe("HEADER");
    expect(heads[0]?.classList.contains("vex-drag")).toBe(true);
  });

  it("names its cells in D2's order: chats, title, needs, funds, caption reserve, VEX", () => {
    render(header({ mode: "agent" }));
    const head = document.querySelector("[data-vex-area='shell-head']");
    const cells = Array.from(head?.children ?? [])
      .map((el) => el.getAttribute("data-vex-head-cell"))
      .filter((cell) => cell !== null);
    expect(cells).toEqual(["chats", "title", "needs", "funds", "caption-reserve", "vex-key"]);
    const chats = head?.querySelector("[data-vex-head-cell='chats']");
    expect(
      Array.from(chats?.children ?? []).map((el) => el.getAttribute("data-vex-head-cell")),
    ).toEqual(["logo", "sidebar-key"]);
  });

  it("puts D2's VEX cell over Vex, not H3's Vex key, and the running head's title over the chat", () => {
    render(header({ mode: "agent" }));
    const head = document.querySelector("[data-vex-area='shell-head']");
    const cell = head?.querySelector("[data-vex-head-cell='vex-key']");
    expect(cell?.classList.contains("vex-drag")).toBe(true);
    expect(cell?.querySelector("[data-testid='vex-head-cell']")).not.toBeNull();
    // H3's Vex key (portrait, state, keycaps, chevron) left the shell's header.
    expect(head?.querySelector("[data-testid='vex-key']")).toBeNull();
    const title = head?.querySelector("[data-vex-head-cell='title']");
    expect(title?.getAttribute("data-vex-area")).toBe("shell-status-strip");
    // Needs you is its own cell after the title (section 6.2): the title
    // cell has no control of it, only the announcer of a rise.
    expect(title?.querySelector("[data-testid='needs-you-head']")).toBeNull();
    expect(title?.querySelector("[data-testid='needs-you-announcer']")).not.toBeNull();
    expect(head?.querySelector("[data-testid='needs-you-head']")).not.toBeNull();
  });

  it("puts the same cells in Studio, Needs you included", () => {
    render(header({ mode: "studio" }));
    const head = document.querySelector("[data-vex-area='shell-head']");
    expect(head?.querySelector("[data-testid='needs-you-head']")).not.toBeNull();
    expect(head?.querySelector("[data-vex-head-cell='vex-key'] [data-testid='vex-head-cell']")).not.toBeNull();
  });

  it("hands the VEX cell the toggle the frame solved, and keeps the cell where there is none", () => {
    const onToggle = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <ShellHeader
          runtimeMode="agent"
          activeSessionId="s-1"
          empty={false}
          vex={{ open: false, onToggle }}
          columns={shellHeadTemplateColumns({ chats: 248, vex: 280 })}
          chatsRail={false}
          onToggleSidebar={() => undefined}
        />
      </QueryClientProvider>,
    );
    const key = document.querySelector<HTMLElement>("[data-testid='vex-head-cell']");
    expect(key?.getAttribute("aria-expanded")).toBe("false");
    key?.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    view.unmount();
    render(header({ mode: "agent", empty: true }));
    expect(document.querySelector("[data-vex-head-cell='vex-key']")?.childElementCount).toBe(0);
  });

  it("on the Lighter desk keeps H3's Vex key in its cell, no token chip and no Needs you cell", () => {
    render(header({ mode: "lighter" }));
    const head = document.querySelector("[data-vex-area='shell-head']");
    expect(head?.querySelector("[data-vex-head-cell='vex-key'] [data-testid='vex-key']")).not.toBeNull();
    expect(head?.querySelector("[data-testid='vex-head-cell']")).toBeNull();
    expect(head?.querySelector("[data-testid='needs-you-head']")).toBeNull();
  });

  it("states the network and never offers a menu: Mainnet, Real funds", () => {
    render(header({ mode: "agent" }));
    const funds = document.querySelector("[data-vex-head-cell='funds']");
    // What assistive tech reads: "Main", the narrow window's picture of
    // Mainnet, is hidden from it.
    const read = Array.from(funds?.querySelectorAll(":scope > :not([aria-hidden='true'])") ?? [])
      .map((el) => el.textContent)
      .join("");
    expect(read).toBe("MainnetReal funds");
    expect(funds?.querySelector("button")).toBeNull();
    // The chat's own cells (ChatHeaderCells) after its title.
    expect(funds?.querySelector("[data-vex-real-funds-mark]")?.textContent).toBe("Real funds");
  });

  it("reserves the caption buttons in an empty cell with nothing to read", () => {
    render(header({ mode: "agent" }));
    const reserve = document.querySelector("[data-vex-head-cell='caption-reserve']");
    expect(reserve?.getAttribute("aria-hidden")).toBe("true");
    expect(reserve?.childElementCount).toBe(0);
  });

  it("names Studio's sidebar on the sidebar key in Studio", () => {
    render(header({ mode: "studio" }));
    expect(document.querySelector("[aria-label='Collapse Studio sidebar']")).not.toBeNull();
  });

  it("over the rail the logo cell stands alone", () => {
    render(header({ mode: "agent", rail: true }));
    expect(document.querySelector("[data-vex-head-cell='chats']")?.hasAttribute("data-rail")).toBe(true);
    expect(document.querySelector("[data-vex-head-cell='sidebar-key']")).toBeNull();
  });

  it("is the same row of cells on the Lighter desk, the desk's head in its title cell", () => {
    render(
      <QueryClientProvider client={client}>
        <ShellHeader
          runtimeMode="lighter"
          activeSessionId="s-1"
          empty={false}
          vex={{ open: true, onToggle: () => undefined }}
          columns={shellHeadTemplateColumns({ chats: 76, vex: 432 })}
          chatsRail
          onToggleSidebar={() => undefined}
          deskHead={<span data-testid="desk-head">Lighter</span>}
        />
      </QueryClientProvider>,
    );
    const head = document.querySelector<HTMLElement>("[data-vex-area='shell-head']");
    expect(head?.className).toBe("vex-shell-head vex-drag");
    expect(head?.style.gridTemplateColumns).toContain("calc(432px - var(--overlay-w))");
    const cells = Array.from(head?.children ?? [])
      .map((el) => el.getAttribute("data-vex-head-cell"))
      .filter((cell) => cell !== null);
    expect(cells).toEqual(["chats", "title", "funds", "caption-reserve", "vex-key"]);
    const title = head?.querySelector("[data-vex-head-cell='title']");
    expect(title?.hasAttribute("data-vex-desk-head")).toBe(true);
    expect(title?.querySelector("[data-testid='desk-head']")).not.toBeNull();
    // Over the rail the logo cell stands alone.
    expect(head?.querySelector("[data-vex-head-cell='chats']")?.hasAttribute("data-rail")).toBe(true);
  });
});

describe("the running head, and the approvals sync in it, mounted once", () => {
  it("mounts the sync once and never remounts it, whatever the header draws", () => {
    const view = render(header({ mode: "agent" }));
    const shapes: readonly Shape[] = [
      // the welcome edge, both ways
      { mode: "agent", empty: true },
      { mode: "agent" },
      // the chats column folds to its rail and opens again
      { mode: "agent", rail: true },
      { mode: "agent", chats: 224 },
      // every mode, and back
      { mode: "studio" },
      { mode: "lighter" },
      { mode: "studio", rail: true },
      { mode: "agent" },
    ];
    for (const shape of shapes) {
      view.rerender(header(shape));
      expect(document.querySelectorAll("[data-testid='approvals-sync']"), shape.mode).toHaveLength(1);
      expect(document.querySelectorAll("[data-vex-area='shell-status-strip']"), shape.mode).toHaveLength(1);
    }
    expect(sync).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("keeps the sync outside every cell, so no cell's change can take it down", () => {
    render(header({ mode: "agent" }));
    const node = document.querySelector("[data-testid='approvals-sync']");
    expect(node?.closest("[data-vex-head-cell]")).toBeNull();
    expect(node?.parentElement?.getAttribute("data-vex-area")).toBe("shell-head");
  });
});
