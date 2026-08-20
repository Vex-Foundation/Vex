/**
 * Which arrivals animate, and where the animation is allowed to live.
 *
 * The second half is the load-bearing one. The transcript's top-anchor effect
 * measures the row element's rect BEFORE paint; if the entry animation rode
 * that element, its opening `translateY(12px)` would be inside the measurement
 * and the just-sent message would anchor 12px off, then visibly slide out from
 * under the anchor. A descendant's transform cannot move its parent's border
 * box — so the class must sit on an inner wrapper, and this suite is what keeps
 * it there.
 */

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { TranscriptRows } from "../../SessionTranscript/TranscriptRows.js";
import type { TranscriptEntry } from "../../transcriptRowModel.js";

vi.mock("../../TranscriptMessage.js", () => ({
  TranscriptMessage: () => <div data-testid="row-body" />,
}));

function row(
  id: number,
  variant: TranscriptEntry["variant"],
): TranscriptEntry {
  return {
    id,
    variant,
    role: variant === "user" ? "user" : "assistant",
    kind: "text",
    content: `row-${id}`,
    createdAt: "2026-08-05T10:00:00.000Z",
    toolCallId: null,
    toolName: null,
    toolCalls: null,
    explorerRefs: null,
    reasoning: null,
    durationMs: null,
    success: null,
    displayStatus: null,
  } as unknown as TranscriptEntry;
}

function renderRows(
  rows: readonly TranscriptEntry[],
  settledIds: ReadonlySet<number> | null,
) {
  return render(
    <TranscriptRows
      sessionId="00000000-0000-4000-8000-00000000aaaa"
      rows={rows}
      settledIds={settledIds}
      pendingApprovals={new Map()}
      workingAgentEntryKey={null}
    />,
  );
}

function entry(container: HTMLElement, id: number): HTMLElement {
  const el = container.querySelector(`[data-vex-entry-id="${id}"]`);
  if (el === null) throw new Error(`entry ${id} not found`);
  return el as HTMLElement;
}

describe("TranscriptRows - what animates", () => {
  it("gives a live-appended USER row the send entry", () => {
    const { container } = renderRows([row(1, "user")], new Set());
    expect(entry(container, 1).innerHTML).toContain("vex-message-send");
  });

  it("gives every other live arrival the quieter print", () => {
    const { container } = renderRows([row(2, "assistant")], new Set());
    const html = entry(container, 2).innerHTML;
    expect(html).toContain("vex-entry-settle");
    expect(html).not.toContain("vex-message-send");
  });

  it("HISTORY hard-cuts - opening an old session must not replay every send", () => {
    const { container } = renderRows(
      [row(1, "user"), row(2, "assistant")],
      new Set([1, 2]),
    );
    for (const id of [1, 2]) {
      const html = entry(container, id).innerHTML;
      expect(html).not.toContain("vex-message-send");
      expect(html).not.toContain("vex-entry-settle");
    }
  });

  it("animates nothing while the first page is still landing (settledIds null)", () => {
    const { container } = renderRows([row(1, "user")], null);
    expect(entry(container, 1).innerHTML).not.toContain("vex-message-send");
  });
});

describe("TranscriptRows - the animation must not sit on the anchored element", () => {
  it("keeps the entry class OFF the element the top-anchor effect measures", () => {
    // `data-vex-entry-id` + `data-vex-entry-variant` is exactly the selector
    // SessionTranscript's layout effect queries.
    const { container } = renderRows([row(1, "user")], new Set());
    const anchored = entry(container, 1);
    expect(anchored.className).not.toContain("vex-message-send");
    expect(anchored.className).not.toContain("vex-entry-settle");
    // …and the class is genuinely present, one level in.
    expect(
      anchored.querySelector(".vex-message-send"),
    ).not.toBeNull();
  });

  it("keeps the turn rhythm on the row element, where layout belongs", () => {
    const { container } = renderRows([row(1, "user")], new Set());
    expect(entry(container, 1).className).toContain("mt-4");
  });
});
