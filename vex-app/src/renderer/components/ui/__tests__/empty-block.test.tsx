/**
 * EmptyBlock in VEX Cloud's anatomy (docs/design/H3-DESKTOP.md section 5.7):
 * a centred card; the section's glyph at 28 and one muted sentence; an error
 * in ink with its cross glyph and Retry as the 44 framed strong key; loading
 * as the loading word over parked covers, a busy status. No caps scope word.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EmptyBlock } from "../empty-block.js";

afterEach(cleanup);

const here = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(
  path.join(here, "..", "..", "..", "styles", "global-css", "ui-primitives", "indicators.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function block(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>("[data-vex-empty-block]");
  if (node === null) throw new Error("missing empty block");
  return node;
}

function rule(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} has no rule`).toBeGreaterThanOrEqual(0);
  return CSS.slice(at, CSS.indexOf("}", at));
}

describe("EmptyBlock", () => {
  it("draws the glyph, the sentence, the line and the next step as a framed key, and no scope word", () => {
    const onClick = vi.fn();
    const { container } = render(
      <EmptyBlock
        scope="Sessions"
        glyph="rail-ask"
        title="No sessions yet"
        detail="Create a session from the sidebar to get started."
        action={{ label: "New chat", onClick }}
      />,
    );
    const node = block(container);
    expect(node.getAttribute("data-scope")).toBe("Sessions");
    expect(node.textContent).not.toContain("Sessions");
    const glyph = node.querySelector(".vex-empty-block__glyph svg");
    expect(glyph?.getAttribute("data-glyph")).toBe("rail-ask");
    expect(glyph?.getAttribute("width")).toBe("28");
    expect(node.querySelector(".vex-empty-block__title")?.textContent).toBe("No sessions yet");
    expect(node.querySelector(".vex-empty-block__detail")?.textContent).toContain("Create a session");
    const key = screen.getByRole("button", { name: "New chat" });
    expect(key.getAttribute("data-vex-button")).toBe("quiet");
    expect(key.getAttribute("data-vex-button-size")).toBe("lg");
    fireEvent.click(key);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(node.hasAttribute("data-tone")).toBe(false);
  });

  it("renders only the sentence when nothing else is given", () => {
    const { container } = render(<EmptyBlock title="No projects yet." />);
    const node = block(container);
    expect(node.textContent).toBe("No projects yet.");
    expect(node.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(node.hasAttribute("role")).toBe(false);
  });

  it("shows loading as the loading word over three parked covers, a busy status", () => {
    const { container } = render(<EmptyBlock scope="Conversation" title="Loading conversation" loading />);
    const node = block(container);
    expect(node.getAttribute("role")).toBe("status");
    expect(node.getAttribute("aria-label")).toBe("Loading conversation");
    expect(node.getAttribute("aria-busy")).toBe("true");
    expect(node.querySelector(".vex-loading-word")?.textContent).toBe("Loading conversation");
    expect(node.querySelector(".vex-loading-word .vex-stripes")).not.toBeNull();
    expect(node.querySelectorAll(".vex-cover")).toHaveLength(3);
    expect(node.querySelector(".vex-loader")).toBeNull();
    expect(node.querySelector("svg")).toBeNull();
  });

  it("draws a failed read in ink with the cross glyph and Retry as the strong framed key", () => {
    const onClick = vi.fn();
    const { container } = render(
      <EmptyBlock
        scope="Portfolio"
        state="error"
        title="Couldn't load your portfolio."
        action={{ label: "Retry", onClick }}
      />,
    );
    const node = block(container);
    expect(node.getAttribute("data-tone")).toBe("error");
    expect(node.querySelector(".vex-empty-block__glyph svg")?.getAttribute("data-glyph")).toBe("rail-no");
    expect(node.hasAttribute("aria-busy")).toBe(false);
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.getAttribute("data-vex-button")).toBe("ink");
    fireEvent.click(retry);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("draws a concerned read with the warning glyph", () => {
    const { container } = render(<EmptyBlock state="concerned" title="Still checking." />);
    expect(block(container).querySelector("svg")?.getAttribute("data-glyph")).toBe("warning");
  });

  it("lets the caller name its own role", () => {
    const { container } = render(<EmptyBlock state="error" title="Couldn't load." role="alert" />);
    expect(block(container).getAttribute("role")).toBe("alert");
  });

  it("paints Cloud's card: the rule frame on the card ground, 40 16, a 14 muted sentence, a 44 key", () => {
    const card = rule(".vex-empty-block");
    expect(card).toContain("padding: 40px 16px");
    expect(card).toContain("border: 1px solid var(--vex-alias-rule-quiet)");
    expect(card).toContain("background: var(--vex-alias-card)");
    expect(card).toContain("align-items: center");
    expect(card).toContain("font-size: 14px");
    expect(card).toContain("color: var(--vex-alias-label-tertiary)");
    expect(card).not.toContain("min-height");
    expect(rule(".vex-empty-block[data-tone]")).toContain("color: var(--vex-alias-label-primary)");
    const key = rule(".vex-empty-block > .vex-empty-block__key");
    expect(key).toContain("height: 44px");
    expect(key).toContain("padding: 0 26px");
  });
});
