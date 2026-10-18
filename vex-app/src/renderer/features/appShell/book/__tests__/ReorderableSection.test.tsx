/**
 * The Portfolio page's drag affordance: native HTML5 DnD plus a real keyboard
 * path, on the page's five sections (wallets, balances, lighter, activity,
 * launchpads).
 *
 * Properties that carry the risk, all pinned here:
 *  1. NOTHING MOVES ON AN UNVALIDATED DROP. `dataTransfer` is a page-wide
 *     channel; any other drag source (a file, selected text, another list)
 *     can land on this page, and an id that is not a known section (including
 *     an id the old side panel stored and the page retired) must move nothing
 *     at all.
 *  2. THE DROP SETTLE ("plum") IS THE SAME AFFORDANCE ON BOTH PATHS, and it is
 *     armed for the MOVED CARD ONLY. Under `prefers-reduced-motion` the class
 *     is never applied at all: the reorder is genuinely instant, not merely
 *     fast (the global base.css rule is belt-and-braces underneath).
 *  3. THE POINTER IS NOT THE ONLY WAY. HTML5 DnD is mouse-only, so the handle
 *     is a real button with Arrow/Home/End, and focus stays on it across a
 *     move or the next keystroke would go to the wrong section.
 *  4. THE SEAMS THE SHEET IS WRITTEN AGAINST: the row is
 *     `data-vex-portfolio-section` with the `vex-pf__item` class, the grip is
 *     `vex-pf__grip`, the row being dragged says so with `data-dragging`, and
 *     the page's two column band reaches the sheet as `data-vex-band`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useState, type JSX } from "react";
import {
  ReorderableSection,
  useBookSectionReorder,
} from "../ReorderableSection.js";
import {
  BOOK_SECTION_LABEL,
  BOOK_SECTION_REGISTRY,
  bookSectionBands,
  DEFAULT_BOOK_SECTIONS,
  type BookSectionId,
} from "../section-order.js";

type Band = "start" | "end";

/**
 * A minimal host composing the hook and the row, as the Portfolio page does.
 * `bands` is how the page hands each row its band slot; the default is no
 * band at all, so every row spans the page.
 */
function Harness({
  onOrderChange,
  initial = [...DEFAULT_BOOK_SECTIONS],
  bands = () => undefined,
}: {
  readonly onOrderChange: (order: readonly BookSectionId[]) => void;
  readonly initial?: readonly BookSectionId[];
  readonly bands?: (order: readonly BookSectionId[], id: BookSectionId) => Band | undefined;
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
          band={bands(order, id)}
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

/** The page's own band rule, as `bookSectionBands` computes it. */
function pageBands(order: readonly BookSectionId[], id: BookSectionId): Band | undefined {
  return bookSectionBands(order).get(id);
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

/** A `DataTransfer` stand-in: jsdom ships none for synthetic drag events. */
function transfer(payload: string) {
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn(),
    getData: vi.fn(() => payload),
  };
}

/**
 * A drag event with a pointer height. jsdom has no DragEvent, so `clientY`
 * would be absent; every row's rect is all zeros there, so its midpoint is 0
 * and a NEGATIVE height is "above the middle" (before), a positive one is
 * below it (after).
 */
function dragAt(
  type: "dragOver" | "drop",
  target: HTMLElement,
  dataTransfer: ReturnType<typeof transfer>,
  clientY: number,
): void {
  const event = createEvent[type](target, { dataTransfer });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(target, event);
}

function row(id: BookSectionId): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-vex-portfolio-section="${id}"]`);
  if (el === null) throw new Error(`row ${id} not found`);
  return el;
}

function handle(id: BookSectionId): HTMLElement {
  const el = row(id).querySelector("button");
  if (el === null) throw new Error(`handle ${id} not found`);
  return el;
}

function renderedOrder(): readonly string[] {
  return Array.from(document.querySelectorAll("[data-vex-portfolio-section]")).map(
    (el) => el.getAttribute("data-vex-portfolio-section") ?? "",
  );
}

describe("ReorderableSection - the seams the sheet is written against", () => {
  it("renders every section as a row with the portfolio seam and its own class", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    expect(renderedOrder()).toEqual([...DEFAULT_BOOK_SECTIONS]);
    for (const id of DEFAULT_BOOK_SECTIONS) {
      expect(row(id).tagName).toBe("LI");
      expect(row(id).className).toContain("vex-pf__item");
    }
  });

  it("no longer carries the side panel's `data-vex-book-section` seam", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    expect(document.querySelector("[data-vex-book-section]")).toBeNull();
  });

  it("the grip is the row's one button, in the `vex-pf__grip` class, holding the section body untouched", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    for (const id of DEFAULT_BOOK_SECTIONS) {
      expect(row(id).querySelectorAll("button")).toHaveLength(1);
      expect(handle(id).className).toContain("vex-pf__grip");
      expect(row(id).querySelector(`[data-testid="body-${id}"]`)).not.toBeNull();
    }
  });
});

describe("ReorderableSection - the band", () => {
  it("band start and band end reach the row as data-vex-band", () => {
    render(
      <Harness
        onOrderChange={vi.fn()}
        bands={(_order, id) => (id === "wallets" ? "start" : id === "balances" ? "end" : undefined)}
      />,
    );
    expect(row("wallets").getAttribute("data-vex-band")).toBe("start");
    expect(row("balances").getAttribute("data-vex-band")).toBe("end");
  });

  it("a row without a band carries no data-vex-band at all (it spans the page)", () => {
    render(
      <Harness
        onOrderChange={vi.fn()}
        bands={(_order, id) => (id === "wallets" ? "start" : id === "balances" ? "end" : undefined)}
      />,
    );
    for (const id of ["lighter", "activity", "launchpads"] as const) {
      expect(row(id).hasAttribute("data-vex-band")).toBe(false);
    }
  });

  it("with no band prop at all, no row carries one", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    expect(document.querySelector("[data-vex-band]")).toBeNull();
  });

  it("the band does not change what the row is: same seam, same class, same grip", () => {
    render(<Harness onOrderChange={vi.fn()} bands={pageBands} />);
    expect(row("wallets").getAttribute("data-vex-band")).toBe("start");
    expect(row("wallets").className).toContain("vex-pf__item");
    expect(handle("wallets").className).toContain("vex-pf__grip");
    expect(handle("wallets").getAttribute("aria-label")).toBe(
      "Reorder Wallets - position 1 of 5",
    );
  });

  it("follows the order the user makes: the band forms wherever Wallets and Balances meet", () => {
    render(<Harness onOrderChange={vi.fn()} bands={pageBands} />);
    // Default: wallets, balances adjacent.
    expect(row("wallets").getAttribute("data-vex-band")).toBe("start");
    expect(row("balances").getAttribute("data-vex-band")).toBe("end");

    // Balances up one: they swap, and the band swaps with them.
    fireEvent.keyDown(handle("balances"), { key: "ArrowUp" });
    expect(renderedOrder().slice(0, 2)).toEqual(["balances", "wallets"]);
    expect(row("balances").getAttribute("data-vex-band")).toBe("start");
    expect(row("wallets").getAttribute("data-vex-band")).toBe("end");

    // Lighter slides between them: no band, everything spans the page.
    fireEvent.keyDown(handle("lighter"), { key: "Home" });
    fireEvent.keyDown(handle("lighter"), { key: "ArrowDown" });
    expect(renderedOrder().slice(0, 3)).toEqual(["balances", "lighter", "wallets"]);
    expect(document.querySelector("[data-vex-band]")).toBeNull();
  });
});

describe("ReorderableSection - pointer drag", () => {
  it("moves a section AFTER the row it was dropped on", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);

    const dataTransfer = transfer("wallets");
    fireEvent.dragStart(handle("wallets"), { dataTransfer });
    dragAt("dragOver", row("balances"), dataTransfer, 100);
    dragAt("drop", row("balances"), dataTransfer, 100);

    expect(onOrderChange).toHaveBeenCalledTimes(1);
    expect(renderedOrder()).toEqual(["balances", "wallets", "lighter", "activity", "launchpads"]);
  });

  it("moves a section BEFORE the row it was dropped on, when the pointer is above its middle", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);

    const dataTransfer = transfer("launchpads");
    fireEvent.dragStart(handle("launchpads"), { dataTransfer });
    dragAt("dragOver", row("balances"), dataTransfer, -10);
    dragAt("drop", row("balances"), dataTransfer, -10);

    expect(onOrderChange).toHaveBeenCalledTimes(1);
    expect(renderedOrder()).toEqual(["wallets", "launchpads", "balances", "lighter", "activity"]);
  });

  it("announces where the dropped section landed", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    const dataTransfer = transfer("wallets");
    fireEvent.dragStart(handle("wallets"), { dataTransfer });
    dragAt("drop", row("activity"), dataTransfer, 100);
    expect(screen.getByText(/Wallets moved to position 4 of 5/)).not.toBeNull();
  });

  it("ignores a drop carrying an id that is not a known section", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);

    const dataTransfer = transfer("../../etc/passwd");
    fireEvent.dragOver(row("wallets"), { dataTransfer });
    fireEvent.drop(row("wallets"), { dataTransfer });

    expect(onOrderChange).not.toHaveBeenCalled();
    expect(renderedOrder()).toEqual([...DEFAULT_BOOK_SECTIONS]);
  });

  it.each(["position", "session", "project", "runtime", ""])(
    "ignores a drop carrying the retired side panel id %j",
    (retired) => {
      const onOrderChange = vi.fn();
      render(<Harness onOrderChange={onOrderChange} />);

      const dataTransfer = transfer(retired);
      fireEvent.drop(row("wallets"), { dataTransfer });

      expect(onOrderChange).not.toHaveBeenCalled();
      expect(renderedOrder()).toEqual([...DEFAULT_BOOK_SECTIONS]);
    },
  );

  it("a self-drop moves nothing", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);

    const dataTransfer = transfer("wallets");
    fireEvent.dragStart(handle("wallets"), { dataTransfer });
    fireEvent.drop(row("wallets"), { dataTransfer });

    expect(onOrderChange).not.toHaveBeenCalled();
    expect(renderedOrder()).toEqual([...DEFAULT_BOOK_SECTIONS]);
  });

  it("dragend clears the drop indicator without moving anything", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);

    const dataTransfer = transfer("launchpads");
    fireEvent.dragStart(handle("launchpads"), { dataTransfer });
    fireEvent.dragOver(row("wallets"), { dataTransfer });
    expect(row("wallets").getAttribute("data-vex-drop-edge")).not.toBeNull();

    fireEvent.dragEnd(handle("launchpads"));
    expect(row("wallets").getAttribute("data-vex-drop-edge")).toBeNull();
    expect(onOrderChange).not.toHaveBeenCalled();
  });

  it("only the handle is draggable - dragging the card body starts nothing", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    expect(handle("lighter").getAttribute("draggable")).toBe("true");
    expect(row("lighter").getAttribute("draggable")).toBeNull();
  });

  it("starting a drag carries the section id and nothing else in the drag channel", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    const dataTransfer = transfer("");
    fireEvent.dragStart(handle("activity"), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledTimes(1);
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "activity");
    expect(dataTransfer.effectAllowed).toBe("move");
  });
});

describe("ReorderableSection - keyboard path", () => {
  it("ArrowDown moves the section one slot down and keeps focus on the handle", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);
    const first = handle("wallets");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });

    expect(renderedOrder()[1]).toBe("wallets");
    expect(document.activeElement).toBe(handle("wallets"));
    expect(onOrderChange).toHaveBeenCalledTimes(1);
  });

  it("ArrowUp moves the section one slot up", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    fireEvent.keyDown(handle("activity"), { key: "ArrowUp" });
    expect(renderedOrder()).toEqual(["wallets", "balances", "activity", "lighter", "launchpads"]);
  });

  it("ArrowUp at the top and ArrowDown at the bottom are no-ops", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);
    const first = DEFAULT_BOOK_SECTIONS[0];
    const last = DEFAULT_BOOK_SECTIONS.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("the page has no sections");
    }
    fireEvent.keyDown(handle(first), { key: "ArrowUp" });
    fireEvent.keyDown(handle(last), { key: "ArrowDown" });
    expect(onOrderChange).not.toHaveBeenCalled();
    expect(renderedOrder()).toEqual([...DEFAULT_BOOK_SECTIONS]);
  });

  it("Home and End jump to the first and last slot", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    fireEvent.keyDown(handle("launchpads"), { key: "Home" });
    expect(renderedOrder()[0]).toBe("launchpads");
    fireEvent.keyDown(handle("launchpads"), { key: "End" });
    expect(renderedOrder().at(-1)).toBe("launchpads");
  });

  it("a key that is not a movement key moves nothing", () => {
    const onOrderChange = vi.fn();
    render(<Harness onOrderChange={onOrderChange} />);
    fireEvent.keyDown(handle("balances"), { key: "Enter" });
    fireEvent.keyDown(handle("balances"), { key: "ArrowLeft" });
    expect(onOrderChange).not.toHaveBeenCalled();
  });

  it("names the section and its position on the handle, and announces the new position", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    expect(handle("balances").getAttribute("aria-label")).toBe(
      "Reorder Balances - position 2 of 5",
    );
    fireEvent.keyDown(handle("balances"), { key: "ArrowDown" });
    // Five sections: wallets, balances, lighter, activity, launchpads.
    expect(screen.getByText(/Balances moved to position 3 of 5/)).not.toBeNull();
    expect(handle("balances").getAttribute("aria-label")).toBe(
      "Reorder Balances - position 3 of 5",
    );
  });
});

describe("ReorderableSection - the insertion cue", () => {
  it("shows the insertion cue on the hovered row ONLY, naming the edge", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    const dataTransfer = transfer("launchpads");
    fireEvent.dragStart(handle("launchpads"), { dataTransfer });
    fireEvent.dragOver(row("wallets"), { dataTransfer });

    // Exactly one row wears the cue, and it names a real edge.
    expect(row("wallets").getAttribute("data-vex-drop-edge")).toMatch(/^(before|after)$/);
    for (const other of DEFAULT_BOOK_SECTIONS.filter((id) => id !== "wallets")) {
      expect(row(other).getAttribute("data-vex-drop-edge")).toBeNull();
    }

    // The cue follows the pointer to the next row rather than accumulating.
    fireEvent.dragOver(row("balances"), { dataTransfer });
    expect(row("wallets").getAttribute("data-vex-drop-edge")).toBeNull();
    expect(row("balances").getAttribute("data-vex-drop-edge")).not.toBeNull();
  });

  it("names the edge by the pointer's height against the row's middle", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    const dataTransfer = transfer("launchpads");
    fireEvent.dragStart(handle("launchpads"), { dataTransfer });

    dragAt("dragOver", row("balances"), dataTransfer, -10);
    expect(row("balances").getAttribute("data-vex-drop-edge")).toBe("before");

    dragAt("dragOver", row("balances"), dataTransfer, 100);
    expect(row("balances").getAttribute("data-vex-drop-edge")).toBe("after");
  });

  it("marks the card being dragged with data-dragging so its origin is legible", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    expect(document.querySelector("[data-dragging]")).toBeNull();

    const dataTransfer = transfer("lighter");
    fireEvent.dragStart(handle("lighter"), { dataTransfer });
    expect(row("lighter").hasAttribute("data-dragging")).toBe(true);
    // The mark is the attribute, not the retired opacity utility.
    expect(row("lighter").className).not.toContain("opacity-60");
    // ONLY the dragged card wears it.
    for (const other of DEFAULT_BOOK_SECTIONS.filter((id) => id !== "lighter")) {
      expect(row(other).hasAttribute("data-dragging")).toBe(false);
    }
  });

  it("the data-dragging mark comes off at dragend and at a drop", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    const dataTransfer = transfer("lighter");

    fireEvent.dragStart(handle("lighter"), { dataTransfer });
    fireEvent.dragEnd(handle("lighter"));
    expect(document.querySelector("[data-dragging]")).toBeNull();

    fireEvent.dragStart(handle("lighter"), { dataTransfer });
    expect(row("lighter").hasAttribute("data-dragging")).toBe(true);
    dragAt("drop", row("wallets"), dataTransfer, 100);
    expect(document.querySelector("[data-dragging]")).toBeNull();
  });
});

describe("ReorderableSection - the drop settle", () => {
  it("settles the MOVED card only, after a pointer drop", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    const dataTransfer = transfer("lighter");
    fireEvent.dragStart(handle("lighter"), { dataTransfer });
    dragAt("drop", row("wallets"), dataTransfer, 100);

    expect(row("lighter").className).toContain("vex-section-settle");
    expect(row("lighter").getAttribute("data-vex-section-settling")).toBe("");
    for (const other of DEFAULT_BOOK_SECTIONS.filter((id) => id !== "lighter")) {
      expect(row(other).className).not.toContain("vex-section-settle");
    }
  });

  it("settles identically after a KEYBOARD move - one affordance, both paths", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    fireEvent.keyDown(handle("balances"), { key: "ArrowDown" });
    expect(row("balances").className).toContain("vex-section-settle");
    expect(row("balances").getAttribute("data-vex-section-settling")).toBe("");
  });

  it("keeps the row's own class while it settles", () => {
    render(<Harness onOrderChange={vi.fn()} />);
    fireEvent.keyDown(handle("balances"), { key: "ArrowDown" });
    expect(row("balances").className).toContain("vex-pf__item");
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
    expect(renderedOrder()[2]).toBe("balances");
    expect(row("balances").className).not.toContain("vex-section-settle");
    expect(row("balances").getAttribute("data-vex-section-settling")).toBeNull();
  });
});
