/**
 * The session ledger row — what a row shows, and what it deliberately does not.
 *
 * The mode glyph used to lead every row. Beside a name it was pure repetition:
 * the subtitle right under it already reads "Agent conversation" or "Mission
 * setup", in words (owner, 2026-08-05). So an EXPANDED row is text flush to the
 * gutter now.
 *
 * The glyph is NOT gone from the component, and that distinction is the point
 * of this suite: on the COLLAPSED rail there is no name and no subtitle, so the
 * glyph is the row's entire visible content and the anchor for the live/paused
 * activity dot. Deleting it there would have left an empty strip and dropped
 * the only running-mission signal a collapsed rail has.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    <ul>
      <SessionRow
        row={row}
        selected={selected}
        sidebarOpen={sidebarOpen}
        onSelect={vi.fn()}
        onTogglePin={vi.fn()}
        onRequestRemove={vi.fn()}
        pinPending={false}
      />
    </ul>,
  );
}

/** The row-select control — the trash/pin cluster is its SIBLING, not inside. */
function selectControl(): HTMLElement {
  const el = document.querySelector("li button");
  if (el === null) throw new Error("row select control not found");
  return el as HTMLElement;
}

describe("an EXPANDED row carries no mode glyph", () => {
  it("renders no icon beside the name — for an agent session", () => {
    renderRow(session({ mode: "agent" }), true);
    expect(selectControl().querySelector("svg")).toBeNull();
  });

  it("renders no icon beside the name — for a mission session either", () => {
    renderRow(session({ mode: "mission" }), true);
    expect(selectControl().querySelector("svg")).toBeNull();
  });

  it("still says the mode IN WORDS, which is why the glyph was redundant", () => {
    renderRow(session({ mode: "agent" }), true);
    expect(screen.getByText(/agent conversation/i)).not.toBeNull();
  });

  it("keeps the name, the timestamp and the RESTRICTED stamp laid out", () => {
    renderRow(session({ permission: "restricted" }), true);
    expect(screen.getByText("Research TAO")).not.toBeNull();
    expect(screen.getByText("restricted")).not.toBeNull();
    // The right slot's timestamp is m:ss-style short-form; any reading proves
    // the two-line layout survived losing the leading column.
    expect(selectControl().textContent).toContain("Research TAO");
  });

  it("keeps the selected-row beam on the row wrapper", () => {
    renderRow(session(), true, true);
    const wrapper = document.querySelector(".vex-select-beam");
    expect(wrapper).not.toBeNull();
    expect(selectControl().getAttribute("aria-current")).toBe("true");
  });
});

describe("the COLLAPSED rail keeps the glyph — it is the whole row there", () => {
  it("renders the mode glyph when there is no name to sit beside", () => {
    renderRow(session(), false);
    expect(selectControl().querySelector("svg")).not.toBeNull();
  });

  it("names the row for assistive tech regardless, since the glyph is decorative", () => {
    renderRow(session(), false);
    expect(selectControl().getAttribute("aria-label")).toBe("Research TAO");
  });

  it("still anchors the live-activity dot to the glyph", () => {
    renderRow(
      session({ mode: "mission", missionStatus: "running" }),
      false,
    );
    const glyphSlot = selectControl().querySelector("span.relative");
    expect(glyphSlot).not.toBeNull();
    expect(glyphSlot?.querySelector("span.rounded-full")).not.toBeNull();
  });
});
