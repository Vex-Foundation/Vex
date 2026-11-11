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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { TranscriptRows } from "../../SessionTranscript/TranscriptRows.js";
import type { TranscriptEntry } from "../../transcriptRowModel.js";

/**
 * The row body, reporting the ONE prop this suite's second subject is about.
 * A board card riding a row reads its arrival from here, so what the list
 * decides is what the unseen dot gets.
 */
vi.mock("../../TranscriptMessage.js", () => ({
  TranscriptMessage: ({ boardArrival, latest }: { boardArrival?: string; latest?: boolean }) => (
    <div data-testid="row-body" data-board-arrival={boardArrival} data-latest={latest ? "" : undefined} />
  ),
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
    board: null,
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

/**
 * ONE DECISION, TWO CONSUMERS. The unseen dot and the print animation read the
 * SAME `liveAppend`, so they cannot disagree about which rows are new - and the
 * fail-closed case (no settled set yet) is history for both.
 */
describe("TranscriptRows - the arrival a board card rides on", () => {
  function arrival(container: HTMLElement, id: number): string | null {
    return entry(container, id)
      .querySelector("[data-testid='row-body']")
      ?.getAttribute("data-board-arrival") ?? null;
  }

  it("marks a genuinely live append as live", () => {
    const { container } = renderRows([row(2, "assistant")], new Set());
    expect(arrival(container, 2)).toBe("live-append");
  });

  it("marks a historical mount as settled", () => {
    const { container } = renderRows([row(2, "assistant")], new Set([2]));
    expect(arrival(container, 2)).toBe("settled");
  });

  it("FAILS CLOSED while the first page is still landing", () => {
    // Unknown provenance never lights a dot: the same rule that stops the
    // whole first page from replaying its animations.
    const { container } = renderRows([row(2, "assistant")], null);
    expect(arrival(container, 2)).toBe("settled");
  });
});

describe("TranscriptRows - the animation must not sit on the anchored element", () => {
  it("keeps the entry class OFF the element the scroll model measures", () => {
    // The scroll model reads this element's border box with
    // `getBoundingClientRect()` when it captures and restores a paging anchor
    // or a saved reader position, in the same commit a live row mounts in. A
    // transform HERE would fold the animation's opening offset into the
    // restored scrollTop; a descendant's transform cannot move its parent's
    // border box.
    const { container } = renderRows([row(1, "user")], new Set());
    const anchored = entry(container, 1);
    expect(anchored.className).not.toContain("vex-message-send");
    expect(anchored.className).not.toContain("vex-entry-settle");
    // …and the class is genuinely present, one level in.
    expect(
      anchored.querySelector(".vex-message-send"),
    ).not.toBeNull();
  });

  it("carries a STABLE anchor key on that same element", () => {
    // `data-vex-anchor-key` is the scroll model's identity for a row. It is
    // the entry key, not the row id: a tool GROUP borrows its first call's id,
    // so an id-keyed anchor could not survive regrouping across a prepend.
    const { container } = renderRows([row(1, "user")], new Set());
    const anchored = entry(container, 1);
    const key = anchored.getAttribute("data-vex-anchor-key");
    expect(key).not.toBeNull();
    expect(key).not.toBe("");
  });

  it("keeps the flow rhythm on the row element, where layout belongs", () => {
    // VEX Cloud's 6 / 12 / 16 (`flowRhythm.ts`): the row carries its gap. The
    // first row under the day line stands 6 under it; Vex's answer 12 under
    // the person's message; their next message 12 under her answer.
    const { container } = renderRows(
      [row(1, "user"), row(2, "assistant"), row(3, "user")],
      new Set(),
    );
    expect(entry(container, 1).getAttribute("data-vex-gap")).toBe("6");
    expect(entry(container, 2).getAttribute("data-vex-gap")).toBe("12");
    expect(entry(container, 3).getAttribute("data-vex-gap")).toBe("12");
    expect(entry(container, 1).className).not.toContain("mt-1");
    expect(container.querySelector("[data-vex-day-separator]")?.getAttribute("data-vex-gap")).toBe("0");
  });
});

describe("TranscriptRows - the day line", () => {
  it("names the day in its own span between the two hairlines, caps 11 muted", () => {
    const { container } = renderRows([row(1, "user")], new Set([1]));
    const line = container.querySelector("[data-vex-day-separator]");
    expect(line?.getAttribute("aria-hidden")).toBe("true");
    expect(line?.className).toBe("vex-day");
    expect(line?.children).toHaveLength(1);
    expect(line?.firstElementChild?.tagName).toBe("SPAN");
    const css = readFileSync(
      join(process.cwd(), "src/renderer/styles/global-css/chat-transcript.css"),
      "utf8",
    );
    // VEX Cloud's `.vx-tx-day`: caps 11, 14 from the hairlines, which fade
    // from the chosen rule to nothing.
    expect(css).toMatch(
      /\.vex-day \{[^}]*gap: 14px;[^}]*font-size: 11px;[^}]*text-transform: uppercase;/,
    );
    expect(css).toMatch(
      /\.vex-day::before,\s*\.vex-day::after \{[^}]*background: linear-gradient\(90deg, transparent, var\(--vex-alias-rule-chosen\)\);/,
    );
  });
});

describe("TranscriptRows - the latest messages", () => {
  it("marks the person's newest message and Vex's newest answer after it, and no other", () => {
    const { container } = renderRows(
      [row(1, "user"), row(2, "assistant"), row(3, "user"), row(4, "assistant"), row(5, "notice")],
      new Set([1, 2, 3, 4, 5]),
    );
    const latest = (id: number) =>
      entry(container, id).querySelector("[data-testid='row-body']")?.hasAttribute("data-latest");
    expect(latest(1)).toBe(false);
    expect(latest(2)).toBe(false);
    expect(latest(3)).toBe(true);
    expect(latest(4)).toBe(true);
    expect(latest(5)).toBe(false);
  });

  it("gives Vex no latest answer while the newest turn has none yet", () => {
    const { container } = renderRows([row(1, "user"), row(2, "assistant"), row(3, "user")], new Set([1, 2, 3]));
    expect(entry(container, 2).querySelector("[data-latest]")).toBeNull();
    expect(entry(container, 3).querySelector("[data-latest]")).not.toBeNull();
  });
});
