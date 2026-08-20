/**
 * The session rail row — what a row shows, and what it deliberately does not.
 *
 * Rebuilt on the generic RailRow (design catalog §5): one 32px line (title +
 * quiet trailing time), no subtitle, no mode glyph beside a name. Selection
 * and hover share the SAME interactive fill (no beam). A running mission
 * carries the pixel-chase state dot in the leading slot; a paused one the
 * solid warn dot. The Remove + Pin cluster is a SIBLING of the select button
 * (never nested), revealed in the time's slot. The whole expanded row anchors
 * a HoverCard preview; the collapsed rail keeps the mode glyph as the row's
 * entire content plus the activity dot.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { SessionRow } from "../SessionRows/SessionRow.js";

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
  sidebarOpen: boolean,
  selected = false,
) {
  return render(
    <SessionRow
      row={row}
      selected={selected}
      sidebarOpen={sidebarOpen}
      onSelect={vi.fn()}
      onTogglePin={vi.fn()}
      onRequestRemove={vi.fn()}
      pinPending={false}
    />,
  );
}

/** The row-select control — the trash/pin cluster is its SIBLING, not inside. */
function selectControl(): HTMLElement {
  const el = document.querySelector("[aria-current], button[aria-label], button");
  if (el === null) throw new Error("row select control not found");
  return el as HTMLElement;
}

describe("an EXPANDED row is one quiet line", () => {
  it("shows the title and no subtitle words", () => {
    renderRow(session({ mode: "agent" }), true);
    expect(screen.getByText("Research TAO")).not.toBeNull();
    expect(screen.queryByText(/agent conversation/i)).toBeNull();
  });

  it("carries no leading state slot for an idle agent session", () => {
    renderRow(session({ mode: "agent" }), true);
    expect(document.querySelector(".vex-state-matrix")).toBeNull();
    expect(document.querySelector(".vex-state-dot")).toBeNull();
  });

  it("runs the pixel-chase dot while a mission is live", () => {
    renderRow(session({ mode: "mission", missionStatus: "running" }), true);
    expect(document.querySelector(".vex-state-matrix")).not.toBeNull();
  });

  it("shows the solid warn dot while a mission is paused", () => {
    renderRow(session({ mode: "mission", missionStatus: "paused_wake" }), true);
    const dot = document.querySelector(".vex-state-dot");
    expect(dot?.getAttribute("data-state")).toBe("warning");
  });

  it("selection is the shared interactive fill, not a beam, and marks aria-current", () => {
    renderRow(session(), true, true);
    expect(document.querySelector(".vex-select-beam")).toBeNull();
    expect(document.querySelector(".bg-interactive-hover")).not.toBeNull();
    const control = document.querySelector('[aria-current="true"]');
    expect(control).not.toBeNull();
  });

  it("keeps Remove and Pin as SIBLINGS of the select button, never nested", () => {
    renderRow(session(), true);
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

  it("anchors a hover-card wrapper around the whole row", () => {
    renderRow(session(), true);
    expect(document.querySelector(".vex-hover-card-root")).not.toBeNull();
  });
});

describe("inline rename (double-click)", () => {
  function renderRenamable(sidebarOpen = true) {
    const onRename = vi.fn();
    render(
      <SessionRow
        row={session()}
        selected={false}
        sidebarOpen={sidebarOpen}
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

  it("the collapsed rail offers no rename affordance", () => {
    renderRenamable(false);
    fireEvent.doubleClick(selectControl());
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("the COLLAPSED rail keeps the glyph - it is the whole row there", () => {
  it("renders the mode glyph when there is no name to sit beside", () => {
    renderRow(session(), false);
    expect(selectControl().querySelector("svg")).not.toBeNull();
  });

  it("names the row for assistive tech regardless, since the glyph is decorative", () => {
    renderRow(session(), false);
    expect(selectControl().getAttribute("aria-label")).toBe("Research TAO");
  });

  it("still anchors the live-activity dot to the glyph", () => {
    renderRow(session({ mode: "mission", missionStatus: "running" }), false);
    const glyphSlot = selectControl().querySelector("span.relative");
    expect(glyphSlot).not.toBeNull();
    expect(glyphSlot?.querySelector("span.rounded-full")).not.toBeNull();
  });

  it("skips the hover card on the rail (native title tooltip instead)", () => {
    renderRow(session(), false);
    expect(document.querySelector(".vex-hover-card-root")).toBeNull();
    expect(selectControl().getAttribute("title")).toBe("Research TAO");
  });
});
