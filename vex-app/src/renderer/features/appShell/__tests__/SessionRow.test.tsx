/**
 * The session row - what a row shows, and what it deliberately does not.
 *
 * Two settings share every behaviour. The REGISTER row (the Sessions library)
 * is the generic RailRow: one 32px line (title + quiet trailing time), no
 * subtitle, no mode glyph beside a name, selection and hover sharing the SAME
 * interactive fill (no beam). The INDEX row (the left page, docs/design/
 * V10-SPREAD.md section 3) prints the session's italic ordinal before the
 * title and marks the open session in blue behind a solid swatch. In both, a
 * running mission carries the dot screen and a paused one the hatch
 * (section 6), the Remove + Pin cluster is a SIBLING of the select button
 * (never nested), revealed in the time's slot, the whole row anchors a
 * HoverCard preview, and a double-click renames inline.
 *
 * The 56px spine no longer renders rows: it prints the ordinals alone
 * (`leftPage/SpineIndex.tsx`), so the collapsed row and its glyph are gone.
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
  selected = false,
  variant: "index" | "register" = "register",
) {
  return render(
    <SessionRow
      row={row}
      selected={selected}
      variant={variant}
      ordinal={variant === "index" ? 2 : null}
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

  it("wears the dot screen while a mission runs", () => {
    renderRow(session({ mode: "mission", missionStatus: "running" }));
    expect(document.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("ongoing");
  });

  it("wears the hatch while a mission is paused (status by fill, section 6)", () => {
    renderRow(session({ mode: "mission", missionStatus: "paused_wake" }));
    const dot = document.querySelector(".vex-swatch");
    expect(dot?.getAttribute("data-s")).toBe("draft");
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

  // The pin glyph shipped as a bare `pinned ? <A/> : <B/>` with no JSX
  // braces, so React rendered four children: the literal text "pinned ? ",
  // BOTH stars, and the literal " : ". aria-label and aria-pressed were
  // correct throughout, which is exactly why the aria-based cases above
  // never saw it. These two assert what a person looks at.
  it("renders no stray source text - the pin control is a glyph, not words", () => {
    renderRow(session());
    expect(document.body.textContent).not.toContain("pinned");
    expect(document.body.textContent).not.toContain("?");
    // The button's own text: a glyph-only control has none at all.
    expect(
      screen.getByRole("button", { name: /^pin session$/i }).textContent,
    ).toBe("");
  });

  it("shows exactly ONE star on the pin control, and it matches the pin state", () => {
    // The pixel sprite tells the two glyphs apart: the outline star is
    // px-watchlist-off, the filled one px-watchlist.
    const hrefOf = (el: HTMLElement): string | null =>
      el.querySelector("use")?.getAttribute("href") ?? null;
    const { unmount } = renderRow(session({ pinnedAt: null }));
    const unpinned = screen.getByRole("button", { name: /^pin session$/i });
    expect(unpinned.querySelectorAll("svg")).toHaveLength(1);
    expect(hrefOf(unpinned)).toBe("#px-watchlist-off");
    unmount();

    renderRow(session({ pinnedAt: "2026-08-06T10:00:00.000Z" }));
    const pinned = screen.getByRole("button", { name: /unpin session/i });
    expect(pinned.querySelectorAll("svg")).toHaveLength(1);
    expect(hrefOf(pinned)).toBe("#px-watchlist");
  });

  it("anchors a hover-card wrapper around the whole row", () => {
    renderRow(session());
    expect(document.querySelector(".vex-hover-card-root")).not.toBeNull();
  });
});

describe("inline rename (double-click)", () => {
  function renderRenamable(variant: "index" | "register" = "register") {
    const onRename = vi.fn();
    render(
      <SessionRow
        row={session()}
        selected={false}
        variant={variant}
        ordinal={variant === "index" ? 7 : null}
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

  it("renames an index row in place, keeping its ordinal beside the field", () => {
    const onRename = renderRenamable("index");
    fireEvent.doubleClick(screen.getByText("Research TAO"));
    const input = screen.getByRole("textbox", { name: /rename session/i });
    expect(input.closest("[data-vex-ix-item]")?.textContent).toContain("(07)");
    fireEvent.change(input, { target: { value: "Research TAO again" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "Research TAO again");
  });
});

describe("an INDEX row on the left page", () => {
  it("prints the italic ordinal before the title, and the time after it", () => {
    renderRow(session(), false, "index");
    const row = document.querySelector("[data-vex-ix-item='row']");
    expect(row?.querySelector(".vex-ix-row__n")?.textContent).toBe("(02)");
    expect(row?.querySelector(".vex-ix-row__n")?.getAttribute("aria-hidden")).toBe("true");
    expect(row?.querySelector(".vex-ix-row__title")?.textContent).toBe("Research TAO");
    expect(row?.querySelector(".vex-ix-row__time")?.textContent).not.toBe("");
  });

  it("marks the open session with a solid swatch and aria-current, never a fill", () => {
    renderRow(session(), true, "index");
    expect(document.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("done");
    expect(document.querySelector('[aria-current="true"]')).not.toBeNull();
    expect(document.querySelector("[data-vex-ix-item][data-current]")).not.toBeNull();
    expect(document.querySelector(".bg-interactive-hover")).toBeNull();
  });

  it("carries no swatch for an idle session that is not open", () => {
    renderRow(session(), false, "index");
    expect(document.querySelector(".vex-swatch")).toBeNull();
  });

  it("keeps Remove and Pin beside the select button, and the hover preview around it", () => {
    renderRow(session(), false, "index");
    const select = document.querySelector(".vex-ix-row__select");
    const remove = screen.getByRole("button", { name: /remove session/i });
    const pin = screen.getByRole("button", { name: /^pin session$/i });
    expect(select?.contains(remove)).toBe(false);
    expect(select?.contains(pin)).toBe(false);
    expect(document.querySelector(".vex-hover-card-root")).not.toBeNull();
  });
});
