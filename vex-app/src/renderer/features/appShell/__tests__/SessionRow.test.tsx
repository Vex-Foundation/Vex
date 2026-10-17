/**
 * The session row - what a row shows, and what it deliberately does not.
 *
 * Two settings share every behaviour. The REGISTER row (the Sessions library)
 * is the generic RailRow: one 32px line (title + quiet trailing time), no
 * subtitle, no mode glyph beside a name, selection and hover sharing the SAME
 * interactive fill (no beam). The SIDEBAR row (the left sidebar,
 * docs/design/R3-MINIMAL.md section 4) is the name, then at the right either
 * the start time or, while a mission has a state, a fill and its word; the
 * open session reads in blue on the selection wash. In both, the Pin and
 * Remove keys are SIBLINGS of the select button (never nested), the whole row
 * anchors a HoverCard preview, and a double-click renames inline.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { MarkedTitle, SessionRow } from "../SessionRows/SessionRow.js";
import { sessionRowState } from "../SessionRows/session-row-state.js";
import { SESSION_ROW_HINT, SessionHoverContent } from "../SessionRows/SessionHoverContent.js";

function session(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    mode: "agent",
    permission: "full",
    title: "Research TAO",
    initialGoal: null,
    startedAt: "2026-08-05T10:00:00.000Z",
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
    ...over,
  };
}

function renderRow(
  row: SessionListItem,
  selected = false,
  variant: "sidebar" | "register" = "register",
) {
  return render(
    <SessionRow
      row={row}
      selected={selected}
      variant={variant}
      onSelect={vi.fn()}
      onTogglePin={vi.fn()}
      onRequestRemove={vi.fn()}
      pinPending={false}
    />,
  );
}

describe("a REGISTER row is one quiet line", () => {
  it("shows the title and no subtitle words", () => {
    renderRow(session({ mode: "agent" }));
    expect(screen.getByText("Research TAO")).not.toBeNull();
    expect(screen.queryByText(/agent conversation/i)).toBeNull();
  });

  it("carries no leading state slot for an idle agent session", () => {
    renderRow(session({ mode: "agent" }));
    expect(document.querySelector(".vex-swatch")).toBeNull();
  });

  it("wears the solid fill while a mission runs, and says so to assistive tech", () => {
    renderRow(session({ mode: "mission", missionStatus: "running" }));
    expect(document.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("done");
    expect(screen.getByText("Running")).not.toBeNull();
  });

  it("wears the dotted outline while a mission sleeps (status by fill, section 1.6)", () => {
    renderRow(session({ mode: "mission", missionStatus: "paused_wake" }));
    expect(document.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("sleeping");
  });

  it("selection is the shared interactive fill, not a beam, and marks aria-current", () => {
    renderRow(session(), true);
    expect(document.querySelector(".vex-select-beam")).toBeNull();
    expect(document.querySelector(".bg-interactive-hover")).not.toBeNull();
    const control = document.querySelector('[aria-current="true"]');
    expect(control).not.toBeNull();
  });

  it("keeps Remove and Pin as SIBLINGS of the select button, never nested", () => {
    renderRow(session());
    const remove = screen.getByRole("button", { name: /remove session/i });
    const pin = screen.getByRole("button", { name: /pin session/i });
    expect(remove.closest("button")).toBe(remove);
    expect(pin.closest("button")).toBe(pin);
    // Neither action sits inside the row-select button's subtree.
    const rowButton = document.querySelector("button.flex.h-full");
    expect(rowButton).not.toBeNull();
    expect(rowButton?.contains(remove)).toBe(false);
    expect(rowButton?.contains(pin)).toBe(false);
  });

  // The pin glyph once shipped as a bare `pinned ? <A/> : <B/>` with no JSX
  // braces, so React rendered the literal source text and BOTH glyphs.
  // aria-label and aria-pressed were correct throughout, which is exactly
  // why the aria-based cases never saw it. These two assert what a person
  // looks at.
  it("renders no stray source text - the pin control is a glyph, not words", () => {
    renderRow(session());
    expect(document.body.textContent).not.toContain("pinned");
    expect(document.body.textContent).not.toContain("?");
    // The button's own text: a glyph-only control has none at all.
    expect(
      screen.getByRole("button", { name: /^pin session$/i }).textContent,
    ).toBe("");
  });

  it("shows exactly ONE line pin on the key, blue only while the row is pinned", () => {
    const { unmount } = renderRow(session({ pinnedAt: null }));
    const unpinned = screen.getByRole("button", { name: /^pin session$/i });
    expect(unpinned.querySelectorAll("svg")).toHaveLength(1);
    expect(unpinned.querySelector("use")).toBeNull();
    expect(unpinned.getAttribute("aria-pressed")).toBe("false");
    expect(unpinned.classList.contains("text-accent-primary")).toBe(false);
    unmount();

    renderRow(session({ pinnedAt: "2026-08-06T10:00:00.000Z" }));
    const pinned = screen.getByRole("button", { name: /unpin session/i });
    expect(pinned.querySelectorAll("svg")).toHaveLength(1);
    expect(pinned.getAttribute("aria-pressed")).toBe("true");
    expect(pinned.classList.contains("text-accent-primary")).toBe(true);
  });

  it("anchors a hover-card wrapper around the whole row", () => {
    renderRow(session());
    expect(document.querySelector(".vex-hover-card-root")).not.toBeNull();
  });
});

describe("inline rename (double-click)", () => {
  function renderRenamable(variant: "sidebar" | "register" = "register") {
    const onRename = vi.fn();
    render(
      <SessionRow
        row={session()}
        selected={false}
        variant={variant}
        onSelect={vi.fn()}
        onTogglePin={vi.fn()}
        onRequestRemove={vi.fn()}
        onRename={onRename}
        pinPending={false}
      />,
    );
    return onRename;
  }

  it("double-click swaps the row for a rename input seeded with the title", () => {
    renderRenamable();
    fireEvent.doubleClick(screen.getByText("Research TAO"));
    const input = screen.getByRole("textbox", { name: /rename session/i });
    expect((input as HTMLInputElement).value).toBe("Research TAO");
  });

  it("Enter commits the trimmed name through onRename and closes the editor", () => {
    const onRename = renderRenamable();
    fireEvent.doubleClick(screen.getByText("Research TAO"));
    const input = screen.getByRole("textbox", { name: /rename session/i });
    fireEvent.change(input, { target: { value: "  Renamed session  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Renamed session",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Escape cancels without persisting", () => {
    const onRename = renderRenamable();
    fireEvent.doubleClick(screen.getByText("Research TAO"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("an empty or unchanged draft is a cancel, not a write", () => {
    const onRename = renderRenamable();
    fireEvent.doubleClick(screen.getByText("Research TAO"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.doubleClick(screen.getByText("Research TAO"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
  });

  it("renames a sidebar row in place, the field filling the row", () => {
    const onRename = renderRenamable("sidebar");
    fireEvent.doubleClick(screen.getByText("Research TAO"));
    const input = screen.getByRole("textbox", { name: /rename session/i });
    expect(input.closest("[data-vex-ls-item]")?.hasAttribute("data-editing")).toBe(true);
    expect(input.classList.contains("vex-ls-row__input")).toBe(true);
    fireEvent.change(input, { target: { value: "Research TAO again" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "Research TAO again");
  });
});

describe("a SIDEBAR row (section 4)", () => {
  it("is the name, then the start time in mono at the right", () => {
    renderRow(session(), false, "sidebar");
    const row = document.querySelector("[data-vex-ls-item='row']");
    expect(row?.querySelector(".vex-ls-row__t")?.textContent).toBe("Research TAO");
    const time = row?.querySelector(".vex-ls-row__time");
    expect(time?.textContent).not.toBe("");
    expect(time?.classList.contains("vex-num")).toBe(true);
    expect(row?.querySelector(".vex-ls-row__state")).toBeNull();
    // No ordinal, no counter: sessions go by name.
    expect(row?.textContent).not.toMatch(/\(\d{2}\)/);
  });

  it("trades the time for a fill and its word while a mission has a state", () => {
    renderRow(session({ mode: "mission", missionStatus: "running" }), false, "sidebar");
    const state = document.querySelector(".vex-ls-row__state");
    expect(state?.textContent).toBe("Running");
    expect(state?.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("done");
    expect(document.querySelector(".vex-ls-row__time")).toBeNull();
  });

  it("marks the open session with the selection and aria-current, without a swatch", () => {
    renderRow(session(), true, "sidebar");
    expect(document.querySelector("[data-vex-ls-item][data-selected]")).not.toBeNull();
    expect(document.querySelector('[aria-current="true"]')).not.toBeNull();
    expect(document.querySelector(".vex-swatch")).toBeNull();
  });

  it("keeps Pin and Remove beside the select button, and the hover preview around it", () => {
    renderRow(session(), false, "sidebar");
    const select = document.querySelector(".vex-ls-row__select");
    const remove = screen.getByRole("button", { name: /remove session/i });
    const pin = screen.getByRole("button", { name: /^pin session$/i });
    expect(select?.contains(remove)).toBe(false);
    expect(select?.contains(pin)).toBe(false);
    // Pin first, then Remove, as the row reads.
    expect(pin.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".vex-hover-card-root")).not.toBeNull();
  });

  it("marks the search's match in the title", () => {
    render(
      <SessionRow
        row={session()}
        selected={false}
        variant="sidebar"
        highlight="tao"
        onSelect={vi.fn()}
        onTogglePin={vi.fn()}
        onRequestRemove={vi.fn()}
        pinPending={false}
      />,
    );
    expect(document.querySelector(".vex-ls-row__t mark")?.textContent).toBe("TAO");
    expect(document.querySelector(".vex-ls-row__t")?.textContent).toBe("Research TAO");
  });
});

describe("the row's state words", () => {
  it("speaks Running, Waiting, Sleeping, Paused and Error, each with its fill", () => {
    const of = (missionStatus: SessionListItem["missionStatus"]) =>
      sessionRowState(session({ mode: "mission", missionStatus }));
    expect(of("running")).toEqual({ word: "Running", fill: "done" });
    expect(of("paused_approval")).toEqual({ word: "Waiting", fill: "awaiting" });
    expect(of("paused_plan_acceptance")).toEqual({ word: "Waiting", fill: "awaiting" });
    expect(of("paused_user_form")).toEqual({ word: "Waiting", fill: "awaiting" });
    expect(of("paused_wake")).toEqual({ word: "Sleeping", fill: "sleeping" });
    expect(of("paused_user")).toEqual({ word: "Paused", fill: "sleeping" });
    expect(of("paused_error")).toEqual({ word: "Error", fill: "error" });
  });

  it("says nothing for agent sessions and finished missions (the time shows)", () => {
    expect(sessionRowState(session())).toBeNull();
    for (const missionStatus of ["completed", "failed", "stopped", "cancelled"] as const) {
      expect(sessionRowState(session({ mode: "mission", missionStatus }))).toBeNull();
    }
  });
});

describe("the hover card", () => {
  it("names the session, its start, its mode and deviations, and the keys line where renamable", () => {
    const { rerender } = render(
      <SessionHoverContent row={session({ permission: "restricted" })} hint />,
    );
    expect(screen.getByText("Research TAO")).not.toBeNull();
    expect(screen.getByText(/^Started /)).not.toBeNull();
    expect(screen.getByText("Agent · Restricted")).not.toBeNull();
    expect(screen.getByText(SESSION_ROW_HINT)).not.toBeNull();

    rerender(<SessionHoverContent row={session({ mode: "mission", missionStatus: "running" })} />);
    expect(screen.getByText("Mission · Running")).not.toBeNull();
    expect(screen.queryByText(SESSION_ROW_HINT)).toBeNull();
  });

  it("marks every case-insensitive match, and nothing for an empty needle", () => {
    const { container, rerender } = render(<MarkedTitle title="Tao and TAO" needle="tao" />);
    expect(Array.from(container.querySelectorAll("mark")).map((m) => m.textContent)).toEqual([
      "Tao",
      "TAO",
    ]);
    rerender(<MarkedTitle title="Tao and TAO" needle="  " />);
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe("Tao and TAO");
  });
});
