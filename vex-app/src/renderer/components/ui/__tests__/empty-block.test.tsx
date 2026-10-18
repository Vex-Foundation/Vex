/**
 * EmptyBlock: one plain sentence and, where there is one, the next step.
 * Pins: the sentence always renders; scope, line and next step only when
 * given; loading is a word with a fill and the quiet line, busy, never a
 * skeleton; a failed read takes its fill beside the sentence.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EmptyBlock } from "../empty-block.js";

afterEach(cleanup);

function block(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>("[data-vex-empty-block]");
  if (node === null) throw new Error("missing empty block");
  return node;
}

describe("EmptyBlock", () => {
  it("renders the scope, the sentence, the line and the next step", () => {
    const onClick = vi.fn();
    const { container } = render(
      <EmptyBlock
        scope="Sessions"
        title="No sessions yet"
        detail="Create a session from the sidebar to get started."
        action={{ label: "New chat", onClick }}
      />,
    );
    const node = block(container);
    expect(node.querySelector(".vex-empty-block__scope")?.textContent).toBe("Sessions");
    expect(node.querySelector(".vex-empty-block__title")?.textContent).toBe("No sessions yet");
    expect(node.querySelector(".vex-empty-block__detail")?.textContent).toContain("Create a session");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(node.querySelector(".vex-swatch")).toBeNull();
  });

  it("renders only the sentence when nothing else is given", () => {
    const { container } = render(<EmptyBlock title="No projects yet." />);
    const node = block(container);
    expect(node.textContent).toBe("No projects yet.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows loading as a word with the dot screen and the quiet line", () => {
    const { container } = render(<EmptyBlock scope="Conversation" title="Loading conversation" loading />);
    const node = block(container);
    expect(node.getAttribute("aria-busy")).toBe("true");
    expect(node.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("listening");
    expect(node.querySelector(".vex-state-word")?.textContent).toBe("Loading conversation");
    expect(node.querySelectorAll(".vex-loader__segment")).toHaveLength(1);
  });

  it("puts a failed read's fill beside the sentence", () => {
    const { container } = render(
      <EmptyBlock scope="Portfolio" state="error" title="Couldn't load your portfolio." />,
    );
    const node = block(container);
    expect(node.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("error");
    expect(node.hasAttribute("aria-busy")).toBe(false);
    expect(node.querySelector(".vex-loader")).toBeNull();
  });
});
