/**
 * HowVexWorksScreen: the five-minute tour as a page (docs/design/R3-MINIMAL.md
 * sections 9.6 and 12) with "On this page" beside it.
 *
 * Pinned here: the serif page head is the h1; "On this page" lists exactly the
 * article's section heads, in order, the first one in view; a key scrolls its
 * section to the top and takes the blue; and the copy follows the app as it is
 * now: Vex is the hologram with a fill and a word per state, approvals are
 * "Needs you", the money is on the Portfolio page. None of the retired words
 * (the "vexing" state, a particle cloud, the "Awaiting signature" stamp, the
 * BOOK panel, the AWAITING badge, the Runtime & Cost card, the left rail) and
 * no em or en dash may come back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useUiStore } from "../../../../stores/uiStore.js";
import { HowVexWorksScreen } from "../HowVexWorksScreen.js";

const scrolled: Element[] = [];
const realRect = Element.prototype.getBoundingClientRect;
let scrollTop = 0;

/** jsdom lays nothing out: give each section head its own place down the page. */
function layOutHeads(this: Element): DOMRect {
  const top =
    this.tagName === "H2"
      ? Array.from<Element>(document.querySelectorAll("h2")).indexOf(this) * 500 - scrollTop
      : 0;
  return { top, bottom: top + 30, left: 0, right: 600, width: 600, height: 30, x: 0, y: top, toJSON: () => ({}) };
}

beforeEach(() => {
  useUiStore.setState({ shellRoute: { kind: "none" } });
  scrolled.length = 0;
  scrollTop = 0;
  Element.prototype.getBoundingClientRect = layOutHeads;
  Element.prototype.scrollIntoView = vi.fn(function scroll(this: Element) {
    scrolled.push(this);
  });
});

afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = realRect;
  // jsdom has no scrollIntoView; the stub is removed again.
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

function renderPage() {
  return render(<HowVexWorksScreen origin={null} onClose={() => undefined} />);
}

describe("HowVexWorksScreen", () => {
  it("heads the page with the serif title and keeps the article beside its contents", () => {
    const { container } = renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "How Vex works" })).not.toBeNull();
    expect(container.querySelector('[data-width="wide"]')).not.toBeNull();
    expect(container.querySelector(".vex-article__col")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "On this page" })).not.toBeNull();
  });

  it("sets each section head in the sans at 20 / 500", () => {
    const { container } = renderPage();
    const heads = container.querySelectorAll(".vex-article__col h2");
    expect(heads.length).toBeGreaterThan(10);
    for (const head of heads) {
      expect(head.className).toContain("text-[20px]");
      expect(head.className).not.toContain("font-serif");
    }
  });

  it("lists exactly the section heads, in order, the first one in view", () => {
    const { container } = renderPage();
    const heads = [...container.querySelectorAll(".vex-article__col h2")].map(
      (node) => node.textContent,
    );
    const nav = screen.getByRole("navigation", { name: "On this page" });
    const keys = within(nav).getAllByRole("button");
    expect(keys.map((key) => key.textContent)).toEqual(heads);
    expect(heads[0]).toBe("Your first hour");
    expect(keys[0]?.getAttribute("aria-current")).toBe("true");
    expect(keys.filter((key) => key.hasAttribute("aria-current"))).toHaveLength(1);
  });

  it("a key scrolls its section to the top and takes the blue", () => {
    const { container } = renderPage();
    const nav = screen.getByRole("navigation", { name: "On this page" });
    const keys = within(nav).getAllByRole("button");
    const third = keys[2];
    if (third === undefined) throw new Error("no third key");
    fireEvent.click(third);
    const heads = container.querySelectorAll(".vex-article__col h2");
    expect(scrolled).toEqual([heads[2]]);
    expect(third.getAttribute("aria-current")).toBe("true");
    expect(keys[0]?.hasAttribute("aria-current")).toBe(false);
  });

  it("follows the page as it scrolls: the section that reached the top is the one in blue", () => {
    const { container } = renderPage();
    const nav = screen.getByRole("navigation", { name: "On this page" });
    const keys = within(nav).getAllByRole("button");
    const scroller = container.ownerDocument.querySelector(".vex-ov__scroll");
    if (scroller === null) throw new Error("no scroller");
    scrollTop = 1000;
    fireEvent.scroll(scroller);
    expect(keys[2]?.getAttribute("aria-current")).toBe("true");
    expect(keys.filter((key) => key.hasAttribute("aria-current"))).toHaveLength(1);
    scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(keys[0]?.getAttribute("aria-current")).toBe("true");
  });

  it("describes the app as it is: Needs you, the state words, the Portfolio page", () => {
    const { container } = renderPage();
    const text = container.querySelector(".vex-article__col")?.textContent ?? "";
    for (const phrase of [
      "Needs you",
      "Waiting for approval",
      "This chat: Ready",
      "Click **Studio**".replace(/\*\*/g, ""),
      "Portfolio page",
      "Show avatar",
      "Check wallet balances",
      "Runtime row",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    for (const state of ["Ready", "Listening", "Thinking", "Working", "Done", "Concerned", "Error", "Sleeping"]) {
      expect(text, state).toContain(state);
    }
  });

  it("names the Vex toggle's chord, and puts no state word on the welcome", () => {
    const { container } = renderPage();
    const text = container.querySelector(".vex-article__col")?.textContent ?? "";
    expect(text).toContain("or Ctrl+Shift+. (Cmd+Shift+. on a Mac), changes that.");
    // the owner: no state word under Vex on the welcome or the start-up screens
    expect(text).not.toContain("and on the welcome screen");
    expect(text).toContain("The welcome screen and the start-up screens show her without a word.");
  });

  it("no longer names what the redesign retired", () => {
    const { container } = renderPage();
    const text = container.querySelector(".vex-article__col")?.textContent ?? "";
    for (const retired of [
      /vexing/i,
      /particle cloud/i,
      /Awaiting signature/i,
      /\bAWAITING\b/,
      /BOOK panel/i,
      /Runtime & Cost/i,
      /left rail/i,
      /PREVIEW badge/i,
      /Hunt trending memecoins/i,
      /Agent \| Studio/,
    ]) {
      expect(text).not.toMatch(retired);
    }
  });

  it("has no em dash or en dash in its words", () => {
    const { container } = renderPage();
    const dashes = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
    expect(container.textContent).not.toMatch(dashes);
  });
});
