/**
 * WHERE FOCUS GOES, and - the half that matters more - when it must not move.
 *
 * The measured defect these decide: a project opened with `Enter` on the
 * welcome's "Open <project>" left `document.activeElement` on `document.body`,
 * and the back-to-Agent chord did the same, so a keyboard user tabbed in from
 * the top of the window after every open and every mode switch.
 *
 * The permission rule is the one that needs pinning hardest, because it is what
 * makes the callers' RETRY loop safe: they ask again after every commit until a
 * terminal exists, and if the rule were "focus whenever the target is not
 * focused" that loop would yank the caret back out of whatever the user reached
 * for while the revive was in flight.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  focusActiveTerminal,
  focusStudioWelcome,
  focusWorkspaceStrip,
  studioFocusPermission,
} from "../workspace-focus.js";

function mount(html: string): HTMLElement {
  const card = document.createElement("div");
  card.innerHTML = html;
  document.body.appendChild(card);
  return card;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("studioFocusPermission", () => {
  it("takes focus only when nothing holds it", () => {
    const card = mount("<button>a</button>");
    expect(studioFocusPermission(card, document.body)).toBe("take");
    expect(studioFocusPermission(card, null)).toBe("take");
  });

  it("reports that the surface already has focus, so nothing need move", () => {
    const card = mount('<button id="mine">a</button>');
    const mine = card.querySelector<HTMLElement>("#mine");
    expect(studioFocusPermission(card, mine)).toBe("inside");
  });

  it("leaves somebody else's focus alone", () => {
    const card = mount("<button>a</button>");
    const other = document.createElement("input");
    document.body.appendChild(other);
    expect(studioFocusPermission(card, other)).toBe("elsewhere");
  });

  it("has no opinion when there is no surface yet", () => {
    expect(studioFocusPermission(null, document.body)).toBe("elsewhere");
  });
});

describe("focusWorkspaceStrip - the close path's chain", () => {
  it("prefers the selected tab", () => {
    const card = mount(`
      <button role="tab" aria-selected="false" id="other">t1</button>
      <button role="tab" aria-selected="true" id="selected">t2</button>
      <button aria-label="New terminal" id="plus">+</button>
    `);
    expect(focusWorkspaceStrip(card)).toBe(true);
    expect(document.activeElement?.id).toBe("selected");
  });

  it("falls back to the one control an empty strip always has", () => {
    const card = mount('<button aria-label="New terminal" id="plus">+</button>');
    expect(focusWorkspaceStrip(card)).toBe(true);
    expect(document.activeElement?.id).toBe("plus");
  });

  it("reports honestly when the strip has nothing to focus yet", () => {
    const card = mount("<div>still rendering</div>");
    expect(focusWorkspaceStrip(card)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("focusActiveTerminal - the open path's target", () => {
  const twoTerminals = `
    <button role="tab" aria-selected="true" id="selected">t</button>
    <div data-terminal-id="term-a">
      <textarea aria-label="Terminal input" id="input-a"></textarea>
    </div>
    <div data-terminal-id="term-b">
      <textarea aria-label="Terminal input" id="input-b"></textarea>
    </div>
  `;

  it("focuses the ACTIVE terminal, not the first one in the card", () => {
    // A split group renders several attached terminals inside one card, so
    // "the first textarea" is not the shell the user is in.
    const card = mount(twoTerminals);
    expect(focusActiveTerminal(card, "term-b")).toBe(true);
    expect(document.activeElement?.id).toBe("input-b");
  });

  it("reports NOT YET rather than falling back, when the pane has not attached", () => {
    // The tab exists a commit before `XtermHost` parents the wrapper. Falling
    // through to the strip here is what put the caret on a tab and left the
    // user to reach for the shell themselves.
    const card = mount(`
      <button role="tab" aria-selected="true" id="selected">t</button>
      <div data-terminal-id="term-a"></div>
    `);
    expect(focusActiveTerminal(card, "term-a")).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("reports NOT YET for a terminal whose wrapper is not in the card at all", () => {
    const card = mount('<button role="tab" aria-selected="true">t</button>');
    expect(focusActiveTerminal(card, "term-a")).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("does not build a selector out of an id it does not own", () => {
    // Terminal ids are minted elsewhere. A quoted interpolation would throw on
    // this one rather than simply not matching.
    const card = mount(twoTerminals);
    expect(() => focusActiveTerminal(card, 'a"]:has(*),[x')).not.toThrow();
    expect(focusActiveTerminal(card, 'a"]:has(*),[x')).toBe(false);
  });
});

describe("focusStudioWelcome", () => {
  it("takes the marked primary action, not the first button on the screen", () => {
    // The bridge diagnostic sits ABOVE the Start row and the way back to Agent
    // sits below it, and both are buttons.
    const welcome = mount(`
      <button id="diagnostic">Retry the bridge check</button>
      <button id="primary" data-vex-studio-welcome-action="primary">New project</button>
      <button id="to-agent">Go to Agent</button>
    `);
    expect(focusStudioWelcome(welcome)).toBe(true);
    expect(document.activeElement?.id).toBe("primary");
  });

  it("reports honestly while the Start row has not rendered", () => {
    const welcome = mount('<button id="to-agent">Go to Agent</button>');
    expect(focusStudioWelcome(welcome)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});
