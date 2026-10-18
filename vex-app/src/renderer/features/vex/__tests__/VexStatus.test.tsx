/**
 * VexStatus: Vex with the avatar off (docs/design/R3-MINIMAL.md section 5.1),
 * the bare 44px flat disc beside or over the host's word. The kit's "Avatar
 * off" drawing has no ring: the word, its swatch and its timer carry the state.
 * Regressions this catches:
 *  - a ring (or any drawing besides the token's own) back round the disc, in
 *    any state;
 *  - a token announced to assistive tech (the word carries the state);
 *  - the word dropped, or laid out on the wrong side of the token;
 *  - a token that moves (nothing to collapse under reduced motion).
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VxToken } from "../../../components/ui/vx-token.js";
import { VexStatus, VexStatusToken } from "../VexStatus.js";
import { VEX_STATES } from "../vex-state.js";

/** What the flat token draws on its own (its disc and its mark): the most any state may draw. */
function bareToken(): { readonly svgs: number; readonly circles: number } {
  const { container, unmount } = render(<VxToken size={44} />);
  const count = {
    svgs: container.querySelectorAll("svg").length,
    circles: container.querySelectorAll("circle").length,
  };
  unmount();
  return count;
}

describe("VexStatusToken", () => {
  it("is the 44px flat token alone, hidden from assistive tech", () => {
    const { container } = render(<VexStatusToken />);
    const token = container.querySelector<HTMLElement>("[data-vex-status-token]");
    expect(token?.getAttribute("aria-hidden")).toBe("true");
    expect(token?.querySelector("[data-vex-vx-token] svg")?.getAttribute("width")).toBe("44");
    expect(token?.style.width).toBe("44px");
    expect(token?.style.height).toBe("44px");
  });

  it("follows the size it is given, with no room kept round the disc", () => {
    const { container } = render(<VexStatusToken size={32} />);
    const token = container.querySelector<HTMLElement>("[data-vex-status-token]");
    expect(token?.querySelector("[data-vex-vx-token] svg")?.getAttribute("width")).toBe("32");
    expect(token?.style.width).toBe("32px");
    expect(token?.style.height).toBe("32px");
  });

  it("never moves: no animation or transition on the token", () => {
    const { container } = render(<VexStatusToken />);
    const token = container.querySelector("[data-vex-status-token]");
    expect(token?.getAttribute("class") ?? "").not.toMatch(/animate|transition/);
    expect(token?.querySelector("animate, animateTransform")).toBeNull();
  });
});

describe("no state ring", () => {
  it("draws no ring in any state: the token's own svg is the only drawing", () => {
    const bare = bareToken();
    for (const state of VEX_STATES) {
      const { container, unmount } = render(
        <VexStatus state={state}>
          <p>{state}</p>
        </VexStatus>,
      );
      const token = container.querySelector("[data-vex-status-token]");
      expect(container.querySelector("[data-vex-status-ring]")).toBeNull();
      expect(container.querySelector("[data-vex-status-badge]")).toBeNull();
      expect(container.querySelectorAll("svg")).toHaveLength(bare.svgs);
      expect(container.querySelectorAll("circle")).toHaveLength(bare.circles);
      expect(token?.querySelectorAll("svg")).toHaveLength(bare.svgs);
      expect(token?.querySelector("[data-vex-vx-token] svg")).not.toBeNull();
      expect(container.querySelector("[data-vex-status-word]")?.querySelector("svg")).toBeNull();
      expect(container.querySelector("[data-vex-status]")?.getAttribute("data-vex-status")).toBe(state);
      unmount();
    }
  });

  it("draws no ring round the bare token either", () => {
    const { container } = render(<VexStatusToken />);
    expect(container.querySelector("[data-vex-status-ring]")).toBeNull();
    const bare = bareToken();
    expect(container.querySelectorAll("svg")).toHaveLength(bare.svgs);
    expect(container.querySelectorAll("circle")).toHaveLength(bare.circles);
  });
});

describe("VexStatus", () => {
  it("row: the token beside the host's word (the Vex sidebar)", () => {
    const { container } = render(
      <VexStatus state="working">
        <p>This chat: Working</p>
      </VexStatus>,
    );
    const root = container.querySelector("[data-vex-status]");
    expect(root?.getAttribute("data-vex-status")).toBe("working");
    expect(root?.getAttribute("data-vex-status-layout")).toBe("row");
    expect(root?.className).toContain("flex");
    expect(root?.className).not.toContain("flex-col");
    expect(root?.firstElementChild?.hasAttribute("data-vex-status-token")).toBe(true);
    expect(container.querySelector("[data-vex-status-word]")?.textContent).toBe(
      "This chat: Working",
    );
  });

  it("stack: the token over the host's word (the welcome)", () => {
    const { container } = render(
      <VexStatus state="ready" layout="stack">
        <p>Ready</p>
      </VexStatus>,
    );
    const root = container.querySelector("[data-vex-status]");
    expect(root?.getAttribute("data-vex-status-layout")).toBe("stack");
    expect(root?.className).toContain("flex-col");
    expect(root?.textContent).toBe("Ready");
  });
});
