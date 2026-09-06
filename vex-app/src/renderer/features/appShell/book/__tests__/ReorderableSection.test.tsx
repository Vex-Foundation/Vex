/**
 * The BOOK rail's drag affordance — native HTML5 DnD plus a real keyboard path.
 *
 * Two properties carry the risk and both are pinned here:
 *  1. NOTHING MOVES ON AN UNVALIDATED DROP. `dataTransfer` is a page-wide
 *     channel; any other drag source (a file, selected text, another list)
 *     can land on this rail, and an id that is not a known section must move
 *     nothing at all.
 *  2. THE DROP SETTLE ("plum") IS THE SAME AFFORDANCE ON BOTH PATHS, and it is
 *     armed for the MOVED CARD ONLY. Under `prefers-reduced-motion` the class
 *     is never applied at all — the reorder is genuinely instant, not merely
 *     fast (the global base.css rule is belt-and-braces underneath).
 *  3. THE POINTER IS NOT THE ONLY WAY. HTML5 DnD is mouse-only, so the handle
 *     is a real button with Arrow/Home/End, and focus stays on it across a
 *     move or the next keystroke would go to the wrong section.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState, type JSX } from "react";
import {
  ReorderableSection,
  useBookSectionReorder,
} from "../ReorderableSection.js";
import {
  BOOK_SECTION_LABEL,
  BOOK_SECTION_REGISTRY,
  SESSION_BOOK_SECTIONS,
  type BookSectionId,
} from "../section-order.js";

/** A minimal host composing the hook and the row, as `BookPanel` does. */
function Harness({
  onOrderChange,
  initial = [...SESSION_BOOK_SECTIONS],
}: {
  readonly onOrderChange: (order: readonly BookSectionId[]) => void;
  readonly initial?: readonly BookSectionId[];
}): JSX.Element {
  const [order, setOrder] = useState(initial);
  const reorder = useBookSectionReorder(
    order,
    (next) => {
      setOrder(next);
      onOrderChange(next);
    },
    BOOK_SECTION_REGISTRY,
  );
  return (
    <ul role="list">
      {order.map((id, index) => (
        <ReorderableSection
          key={id}
          id={id}
          label={BOOK_SECTION_LABEL[id]}
          index={index}
          count={order.length}
          reorder={reorder}
        >
          <div data-testid={`body-${id}`} />
        </ReorderableSection>
      ))}
      <li aria-live="polite" className="sr-only">
        {reorder.announcement}
      </li>
    </ul>
  );
}

/** Force the reduced-motion query (this jsdom build ships no matchMedia). */
function mockReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        matches: query.includes("prefers-reduced-motion") ? matches : false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A `DataTransfer` stand-in — jsdom ships none for synthetic drag events. */
function transfer(payload: string) {
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn(),
    getData: vi.fn(() => payload),
  };
}

function row(id: BookSectionId): HTMLElement {
  const el = document.querySelector(`[data-vex-book-section="${id}"]`);
  if (el === null) throw new Error(`row ${id} not found`);
  return el as HTMLElement;
}

function handle(id: BookSectionId): HTMLElement {
  const el = row(id).querySelector("button");
  if (el === null) throw new Error(`handle ${id} not found`);
  return el;
}

function renderedOrder(): readonly string[] {
  return Array.from(document.querySelectorAll("[data-vex-book-section]")).map(
    (el) => el.getAttribute("data-vex-book-section") ?? "",
  );
}

describe("ReorderableSection - pointer drag", () => {
  it("moves a section AFTER the row it was dropped on", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);

    const dataTransfer = transfer("position");
    fireEvent.dragStart(handle("position"), { dataTransfer });
    fireEvent.dragOver(row("wallets"), {
      dataTransfer,
      clientY: 100,
    });
    fireEvent.drop(row("wallets"), { dataTransfer, clientY: 100 });

    expect(onOrderChange).toHaveBeenCalledTimes(1);
    expect(renderedOrder()[0]).toBe("wallets");
    expect(renderedOrder()[1]).toBe("position");
  });

  it("ignores a drop carrying an id that is not a known section", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);

    const dataTransfer = transfer("../../etc/passwd");
    fireEvent.dragOver(row("wallets"), { dataTransfer });
    fireEvent.drop(row("wallets"), { dataTransfer });

    expect(onOrderChange).not.toHaveBeenCalled();
    expect(renderedOrder()).toEqual([...SESSION_BOOK_SECTIONS]);
  });

  it("a self-drop moves nothing", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);

    const dataTransfer = transfer("wallets");
    fireEvent.dragStart(handle("wallets"), { dataTransfer });
    fireEvent.drop(row("wallets"), { dataTransfer });

    expect(renderedOrder()).toEqual([...SESSION_BOOK_SECTIONS]);
  });

  it("dragend clears the drop indicator without moving anything", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);

    const dataTransfer = transfer("position");
    fireEvent.dragStart(handle("position"), { dataTransfer });
    fireEvent.dragOver(row("wallets"), { dataTransfer });
    expect(row("wallets").getAttribute("data-vex-drop-edge")).not.toBeNull();

    fireEvent.dragEnd(handle("position"));
    expect(row("wallets").getAttribute("data-vex-drop-edge")).toBeNull();
    expect(onOrderChange).not.toHaveBeenCalled();
  });

  it("only the handle is draggable - dragging the card body starts nothing", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    expect(handle("position").getAttribute("draggable")).toBe("true");
    expect(row("position").getAttribute("draggable")).toBeNull();
  });
});

describe("ReorderableSection - keyboard path", () => {
  it("ArrowDown moves the section one slot down and keeps focus on the handle", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);
    const first = handle("position");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });

    expect(renderedOrder()[1]).toBe("position");
    expect(document.activeElement).toBe(handle("position"));
    expect(onOrderChange).toHaveBeenCalledTimes(1);
  });

  it("ArrowUp at the top and ArrowDown at the bottom are no-ops", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);
    const first = SESSION_BOOK_SECTIONS[0];
    const last = SESSION_BOOK_SECTIONS.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("the session rail has no sections");
    }
    fireEvent.keyDown(handle(first), { key: "ArrowUp" });
    fireEvent.keyDown(handle(last), { key: "ArrowDown" });
    expect(onOrderChange).not.toHaveBeenCalled();
    expect(renderedOrder()).toEqual([...SESSION_BOOK_SECTIONS]);
  });

  it("Home and End jump to the first and last slot", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    fireEvent.keyDown(handle("trench"), { key: "Home" });
    expect(renderedOrder()[0]).toBe("trench");
    fireEvent.keyDown(handle("trench"), { key: "End" });
    expect(renderedOrder().at(-1)).toBe("trench");
  });

  it("announces the new position, and names the section on its handle", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    expect(handle("balances").getAttribute("aria-label")).toMatch(/balances/i);
    fireEvent.keyDown(handle("balances"), { key: "ArrowDown" });
    // 6 sections since "Runtime & Cost" retired in round 3.
    expect(screen.getByText(/moved to position 4 of 6/i)).not.toBeNull();
  });
});

describe("ReorderableSection - the insertion cue", () => {
  it("shows the insertion cue on the hovered row ONLY, naming the edge", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    const dataTransfer = transfer("trench");
    fireEvent.dragStart(handle("trench"), { dataTransfer });
    fireEvent.dragOver(row("wallets"), { dataTransfer });

    // WHICH edge is chosen depends on the pointer's position against the row's
    // midpoint, and this jsdom build carries neither layout nor a DragEvent's
    // clientY — so the browser is the only place that can be verified. What IS
    // provable here: exactly one row wears the cue, and it names a real edge.
    expect(row("wallets").getAttribute("data-vex-drop-edge")).toMatch(
      /^(before|after)$/,
    );
    for (const other of SESSION_BOOK_SECTIONS.filter((id) => id !== "wallets")) {
      expect(row(other).getAttribute("data-vex-drop-edge")).toBeNull();
    }

    // The cue follows the pointer to the next row rather than accumulating.
    fireEvent.dragOver(row("balances"), { dataTransfer });
    expect(row("wallets").getAttribute("data-vex-drop-edge")).toBeNull();
    expect(row("balances").getAttribute("data-vex-drop-edge")).not.toBeNull();
  });

  it("dims the card being dragged so its origin is legible", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    const dataTransfer = transfer("position");
    fireEvent.dragStart(handle("position"), { dataTransfer });
    expect(row("position").className).toContain("opacity-60");
  });
});

describe("ReorderableSection - the drop settle", () => {
  it("settles the MOVED card only, after a pointer drop", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    const dataTransfer = transfer("position");
    fireEvent.dragStart(handle("position"), { dataTransfer });
    fireEvent.drop(row("wallets"), { dataTransfer, clientY: 100 });

    expect(row("position").className).toContain("vex-section-settle");
    expect(row("position").getAttribute("data-vex-section-settling")).toBe("");
    for (const other of SESSION_BOOK_SECTIONS.filter((id) => id !== "position")) {
      expect(row(other).className).not.toContain("vex-section-settle");
    }
  });

  it("settles identically after a KEYBOARD move - one affordance, both paths", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    fireEvent.keyDown(handle("balances"), { key: "ArrowDown" });
    expect(row("balances").className).toContain("vex-section-settle");
  });

  it("comes off when the settle is over, so the NEXT move can re-trigger it", () => {
    vi.useFakeTimers();
    try {
      render(<Harness onOrderChange={vi.fn()} />);
      fireEvent.keyDown(handle("balances"), { key: "ArrowDown" });
      expect(row("balances").className).toContain("vex-section-settle");

      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(row("balances").className).not.toContain("vex-section-settle");

      // The class must be fully absent first, or the keyframe could not
      // restart on this reused DOM node.
      fireEvent.keyDown(handle("balances"), { key: "ArrowUp" });
      expect(row("balances").className).toContain("vex-section-settle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers-reduced-motion: the reorder happens, the settle never does", () => {
    mockReducedMotion(true);
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);
    fireEvent.keyDown(handle("balances"), { key: "ArrowDown" });

    expect(onOrderChange).toHaveBeenCalledTimes(1);
    expect(renderedOrder()[3]).toBe("balances");
    expect(row("balances").className).not.toContain("vex-section-settle");
    expect(row("balances").getAttribute("data-vex-section-settling")).toBeNull();
  });
});
