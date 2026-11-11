/**
 * THE TURN'S TRACE CARD AND ITS FOLD (`TurnTrace.tsx`, `turnFold.ts`;
 * docs/design/H3-DESKTOP.md section 1.7; VEX Cloud's built trace). One head
 * per turn folds every step of it: a turn from history opens folded, a
 * running turn stands open and folds itself `FOLD_DELAY_MS` after it
 * settles unless the person pressed its head, and a stopped turn's head is a
 * label that never folds. Drawn through the real rows, so the fold reaches
 * every row of the turn.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TranscriptRows } from "../../SessionTranscript/TranscriptRows.js";
import { FOLD_DELAY_MS } from "../../SessionTranscript/turnFold.js";
import { useTurnClockStore } from "../../TurnIsland/turnClock.js";
import type { TranscriptEntry } from "../../transcriptRowModel.js";

const SESSION = "00000000-0000-4000-8000-00000000f01d";
const ISO = "2026-11-09T10:00:00.000Z";

function user(id: number): TranscriptEntry {
  return { id, variant: "user", label: null, content: `ask ${String(id)}`, createdAt: ISO };
}

function answer(id: number, reasoning: string | null): TranscriptEntry {
  return { id, variant: "assistant", label: null, content: `answer ${String(id)}`, createdAt: ISO, reasoning };
}

function call(id: number, reasoning: string | null): TranscriptEntry {
  return {
    id,
    variant: "tool",
    toolKind: "call",
    label: null,
    content: "",
    createdAt: ISO,
    reasoning,
    toolActs: [
      { toolCallId: `c${String(id)}`, toolName: "wallet_balances", toolArgs: null, output: null },
    ],
  };
}

const TURN: readonly TranscriptEntry[] = [user(10), call(11, "check the wallet"), answer(12, "now answer")];

function draw(
  rows: readonly TranscriptEntry[],
  settledIds: ReadonlySet<number>,
  live: boolean,
) {
  return (
    <TranscriptRows
      rows={rows}
      sessionId={SESSION}
      settledIds={settledIds}
      pendingApprovals={new Map()}
      workingAgentEntryKey={null}
      live={live}
    />
  );
}

function head(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-vex-trace-head]");
  if (el === null) throw new Error("no trace head");
  return el;
}

function bodies(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-vex-trace-body]")];
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useTurnClockStore.setState({ bySession: {} });
});

describe("the turn's trace head", () => {
  it("folds a turn from history: the head alone over its steps, the answer in view", () => {
    const { container } = render(draw(TURN, new Set([10, 11, 12]), false));
    const key = screen.getByRole("button", { name: "Thought, 3 steps" });
    expect(key.getAttribute("aria-expanded")).toBe("false");
    expect(key.getAttribute("data-tone")).toBe("done");
    // One head for the whole turn, on its first step's row.
    expect(container.querySelectorAll("[data-vex-trace-head]")).toHaveLength(1);
    expect(container.querySelector('[data-vex-entry-id="11"] [data-vex-trace-head]')).not.toBeNull();
    // Every step of the turn folds, the answer's thought included; the
    // answer stays, and find in page can still reach the steps.
    expect(bodies(container)).toHaveLength(2);
    for (const body of bodies(container)) expect(body.getAttribute("hidden")).toBe("until-found");
    expect(screen.getByText("answer 12")).toBeTruthy();
    // The head's row stands, folded to its head; the answer's row stands.
    expect(container.querySelector('[data-vex-entry-id="11"]')?.hasAttribute("data-vex-trace-shut")).toBe(false);
    expect(container.querySelector('[data-vex-entry-id="12"]')?.hasAttribute("data-vex-trace-shut")).toBe(false);
  });

  it("opens every step of the turn at the head's press, and shuts them again", () => {
    const { container } = render(draw(TURN, new Set([10, 11, 12]), false));
    fireEvent.click(head(container));
    expect(head(container).getAttribute("aria-expanded")).toBe("true");
    for (const body of bodies(container)) expect(body.hasAttribute("hidden")).toBe(false);
    fireEvent.click(head(container));
    for (const body of bodies(container)) expect(body.getAttribute("hidden")).toBe("until-found");
  });

  it("carries no summary of the trace", () => {
    const { container } = render(draw(TURN, new Set([10, 11, 12]), false));
    expect(head(container).textContent).not.toContain("check the wallet");
  });

  it("opens the turn when find in page reaches a folded step", () => {
    const { container } = render(draw(TURN, new Set([10, 11, 12]), false));
    const [first] = bodies(container);
    act(() => {
      first?.dispatchEvent(new Event("beforematch"));
    });
    expect(head(container).getAttribute("aria-expanded")).toBe("true");
  });

  it("says Thought for the live clock's reading, only after a turn watched live", () => {
    useTurnClockStore.getState().record(SESSION, 10, 2_800);
    render(draw(TURN, new Set([10, 11, 12]), false));
    expect(screen.getByRole("button", { name: "Thought for 2.8s, 3 steps" })).toBeTruthy();
  });

  it("is a label for a stopped turn: no key, and its steps stay in view", () => {
    const rows: TranscriptEntry[] = [
      user(10),
      call(11, "why"),
      { id: 12, variant: "assistant_stopped", label: null, content: "half", createdAt: ISO, reasoning: null },
    ];
    const { container } = render(draw(rows, new Set([10, 11, 12]), false));
    expect(head(container).tagName).toBe("DIV");
    expect(head(container).textContent).toContain("Stopped");
    expect(head(container).hasAttribute("aria-expanded")).toBe(false);
    for (const body of bodies(container)) expect(body.hasAttribute("hidden")).toBe(false);
  });

  it("draws the 3x3 cells by state, and the cross for a failed turn", () => {
    const done = render(draw(TURN, new Set([10, 11, 12]), false));
    expect(done.container.querySelector('[data-vex-trace-cells][data-tone="done"]')?.children).toHaveLength(9);
    done.unmount();
    const running = render(draw([user(10), call(11, "why")], new Set(), true));
    expect(running.container.querySelector('[data-vex-trace-cells][data-tone="run"]')).not.toBeNull();
    running.unmount();
    const failed = render(
      draw(
        [
          user(10),
          call(11, "why"),
          { id: 12, variant: "notice", noticeTone: "error", label: null, content: "failed", createdAt: ISO },
        ],
        new Set([10, 11, 12]),
        false,
      ),
    );
    expect(head(failed.container).textContent).toContain("Failed");
    expect(failed.container.querySelector("[data-vex-trace-cross]")).not.toBeNull();
    expect(failed.container.querySelector("[data-vex-trace-cells]")).toBeNull();
  });

  it("heads a turn that only called tools", () => {
    const rows = [user(10), call(11, null), answer(12, null)];
    render(draw(rows, new Set([10, 11, 12]), false));
    expect(screen.getByRole("button", { name: "Thought, 1 step" })).toBeTruthy();
  });
});

describe("the turn's fold while it runs", () => {
  it("stands open while running and folds itself after the delay once settled", () => {
    vi.useFakeTimers();
    const rows = [user(10), call(11, "check the wallet")];
    const view = render(draw(rows, new Set(), true));
    const key = head(view.container);
    expect(key.getAttribute("data-tone")).toBe("run");
    expect(key.textContent).toContain("Working");
    expect(key.getAttribute("aria-expanded")).toBe("true");
    for (const body of bodies(view.container)) expect(body.hasAttribute("hidden")).toBe(false);

    view.rerender(draw([...rows, answer(12, "now answer")], new Set(), false));
    expect(head(view.container).getAttribute("data-tone")).toBe("done");
    // Settled, it stays open until the delay has run out.
    act(() => {
      vi.advanceTimersByTime(FOLD_DELAY_MS - 1);
    });
    expect(head(view.container).getAttribute("aria-expanded")).toBe("true");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(head(view.container).getAttribute("aria-expanded")).toBe("false");
    for (const body of bodies(view.container)) expect(body.getAttribute("hidden")).toBe("until-found");
  });

  it("respects the person's press: a turn they opened does not fold itself", () => {
    vi.useFakeTimers();
    const rows = [user(10), call(11, "check the wallet")];
    const view = render(draw(rows, new Set(), true));
    fireEvent.click(head(view.container));
    fireEvent.click(head(view.container));
    expect(head(view.container).getAttribute("aria-expanded")).toBe("true");
    view.rerender(draw([...rows, answer(12, "now answer")], new Set(), false));
    act(() => {
      vi.advanceTimersByTime(FOLD_DELAY_MS * 2);
    });
    expect(head(view.container).getAttribute("aria-expanded")).toBe("true");
  });

  it("never reopens the turn above a send whose message has not landed yet", () => {
    vi.useFakeTimers();
    // A turn watched live: its rows arrived in this view, then it settled
    // and folded itself.
    const view = render(draw(TURN, new Set(), true));
    view.rerender(draw(TURN, new Set(), false));
    act(() => {
      vi.advanceTimersByTime(FOLD_DELAY_MS);
    });
    expect(head(view.container).getAttribute("aria-expanded")).toBe("false");
    // The next send: a turn is in flight, its own message is not in the rows
    // yet, so the rows' newest turn is still the folded one.
    view.rerender(draw(TURN, new Set(), true));
    expect(head(view.container).getAttribute("aria-expanded")).toBe("false");
    expect(head(view.container).getAttribute("data-tone")).toBe("done");
    act(() => {
      vi.advanceTimersByTime(FOLD_DELAY_MS);
    });
    expect(head(view.container).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the trace's steps (VEX Cloud's .vx-trace-steps)", () => {
  it("draws each group as one card holding one list, a step per item, with its kind", () => {
    const { container } = render(draw(TURN, new Set([10, 11, 12]), false));
    fireEvent.click(head(container));
    const cards = container.querySelectorAll(".vex-trace[data-vex-trace-group]");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.querySelectorAll(":scope > [data-vex-trace-body] > ol.vex-trace-steps")).toHaveLength(1);
    }
    // Row 11: its thought and its call, one list; row 12: the answer's thought.
    const first = cards[0]?.querySelector("ol.vex-trace-steps");
    expect([...(first?.children ?? [])].map((li) => li.getAttribute("data-vex-trace-kind"))).toEqual([
      "model",
      "tool",
    ]);
    expect([...(first?.children ?? [])].every((li) => li.tagName === "LI")).toBe(true);
    expect(first?.querySelectorAll(".vex-step__kind")).toHaveLength(2);
  });

  it("keeps each step's name: the kind column is a drawing", () => {
    render(draw(TURN, new Set([10, 11, 12]), false));
    fireEvent.click(screen.getByRole("button", { name: "Thought, 3 steps" }));
    // A thought's key is its label; a tool's key its title (and its word).
    expect(screen.getAllByRole("button", { name: "Thought" })).toHaveLength(2);
    const tool = document.querySelector<HTMLElement>('[data-vex-trace-kind="tool"] button');
    expect(tool?.getAttribute("aria-expanded")).toBe("false");
    expect(tool?.querySelector(".vex-step__kind")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("raw-CSS contract: the rail at x 19, no rule between steps, the 12 / 64 / text / time / 16 grid", () => {
    const css = readFileSync(
      join(process.cwd(), "src/renderer/styles/global-css/chat-transcript.css"),
      "utf8",
    );
    expect(css).toMatch(/\.vex-trace-steps::before \{[^}]*top: 18px;[^}]*bottom: 18px;[^}]*left: 19px;[^}]*width: 1px;/);
    expect(css).toMatch(
      /:is\(\.vex-step, \.vex-step__key\)\.vex-step__grid \{[^}]*grid-template-columns: 12px 64px minmax\(0, 1fr\) auto 16px;[^}]*column-gap: 14px;[^}]*padding: 9px 14px;/,
    );
    expect(css).toMatch(/\.vex-step__kind \{[^}]*font-size: 10px;[^}]*letter-spacing: 0\.1em;[^}]*text-transform: uppercase;/);
    expect(css).toMatch(/\.vex-trace \{[^}]*border: 1px solid var\(--vex-alias-rule\);[^}]*background: var\(--vex-alias-card\);/);
    // No rule between two steps of a list.
    expect(css).not.toMatch(/\[data-vex-message-role="tool"\] \+ \[data-vex-message-role="tool"\] \{/);
  });
});

describe("the flow rhythm around the trace (VEX Cloud's 6 / 12 / 16)", () => {
  const gap = (container: HTMLElement, id: number) =>
    container.querySelector(`[data-vex-entry-id="${String(id)}"]`)?.getAttribute("data-vex-gap");

  it("stands the head 16 under the message, hides a folded row of steps, and the answer 12 under", () => {
    const rows = [user(10), call(11, "check the wallet"), call(12, null), answer(13, null)];
    const { container } = render(draw(rows, new Set([10, 11, 12, 13]), false));
    expect(gap(container, 11)).toBe("16");
    // Row 12 holds nothing but steps: folded, it takes no gap.
    const hidden = container.querySelector('[data-vex-entry-id="12"]');
    expect(hidden?.hasAttribute("data-vex-trace-shut")).toBe(true);
    expect(gap(container, 12)).toBe("0");
    // Under the folded head, the answer: the head's 16 wins over its 12.
    expect(gap(container, 13)).toBe("16");
    // Opened, the row of steps joins the card above; the answer 12 under it.
    fireEvent.click(head(container));
    expect(gap(container, 12)).toBe("0");
    expect(container.querySelector('[data-vex-entry-id="12"]')?.hasAttribute("data-vex-run-continues")).toBe(true);
    expect(gap(container, 13)).toBe("12");
  });

  it("raw-CSS contract: the column has no gap of its own; rows take 6, 12 or 16", () => {
    const css = readFileSync(
      join(process.cwd(), "src/renderer/styles/global-css/chat-transcript.css"),
      "utf8",
    );
    expect(css).toMatch(/\[data-vex-flow\] > \[data-vex-gap="6"\] \{\s*margin-top: 6px;/);
    expect(css).toMatch(/\[data-vex-flow\] > \[data-vex-gap="12"\] \{\s*margin-top: 12px;/);
    expect(css).toMatch(/\[data-vex-flow\] > \[data-vex-gap="16"\] \{\s*margin-top: 16px;/);
    expect(css).toMatch(/\[data-vex-flow\] > \[data-vex-area="stream-preview"\]:not\(:first-child\) \{\s*margin-top: 12px;/);
    // The old beat and its negative take-backs are gone.
    expect(css).not.toMatch(/margin-top: -18px/);
    const source = readFileSync(
      join(process.cwd(), "src/renderer/features/appShell/SessionTranscript.tsx"),
      "utf8",
    );
    expect(source).not.toContain("gap-[18px]");
    expect(source).toContain('data-vex-flow=""');
  });
});
