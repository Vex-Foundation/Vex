/**
 * THE TURN'S TRACE CARD AND ITS FOLD (`TurnTrace.tsx`, `turnFold.ts`;
 * docs/design/H3-DESKTOP.md section 1.7; VEX Cloud's built trace). One head
 * per turn folds every step of it: a turn from history opens folded, a
 * running turn stands open and folds itself `FOLD_DELAY_MS` after it
 * settles unless the person pressed its head, and a stopped turn's head is a
 * label that never folds. Drawn through the real rows, so the fold reaches
 * every row of the turn.
 */

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
    // The row of nothing but steps takes its gap back while folded.
    expect(container.querySelector('[data-vex-entry-id="11"]')?.hasAttribute("data-vex-trace-shut")).toBe(true);
    expect(container.querySelector('[data-vex-entry-id="12"]')?.hasAttribute("data-vex-trace-shut")).toBe(false);
  });

  it("opens every step of the turn at the head's press, and shuts them again", () => {
    const { container } = render(draw(TURN, new Set([10, 11, 12]), false));
    fireEvent.click(head(container));
    expect(head(container).getAttribute("aria-expanded")).toBe("true");
    for (const body of bodies(container)) expect(body.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector('[data-vex-entry-id="11"]')?.hasAttribute("data-vex-trace-shut")).toBe(false);
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
