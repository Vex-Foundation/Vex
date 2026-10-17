/**
 * The K2 host (`VexK2.tsx`) in jsdom, where no canvas paints. Regressions this catches: a host that
 * is announced to assistive tech or takes the pointer, a lost placement or ground seam, a lost
 * episode seam (the open dock, the closed token) or one that does not follow its prop, a mount
 * that throws or starts fetching art while its host has no size, and a token toggle host that does
 * not hand its caller the coin's box on its fit or takes the pointer itself.
 */

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Box, fitFor, tokenBox } from "../k2-rig.js";
import { VexK2 } from "../VexK2.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VexK2", () => {
  it("is a decorative host with one canvas, its placement and ground as seams", () => {
    const { container } = render(<VexK2 placement="sidebar" ground="print" className="h-[280px]" />);
    const host = container.querySelector("[data-vex-k2]");
    expect(host?.getAttribute("data-vex-k2")).toBe("sidebar");
    expect(host?.getAttribute("data-vex-k2-ground")).toBe("print");
    expect(host?.getAttribute("aria-hidden")).toBe("true");
    expect(host?.className).toContain("pointer-events-none");
    expect(host?.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("loads no art while its host has no size", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { container, unmount } = render(<VexK2 placement="welcome" ground="paper" />);
    expect(container.querySelector("[data-vex-k2-ready]")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    unmount();
  });

  it("names its episodes as seams: the open dock on mount, the closed token while closed", () => {
    const { container, rerender } = render(
      <VexK2 placement="sidebar" ground="print" open className="h-[280px]" />,
    );
    const host = () => container.querySelector("[data-vex-k2]");
    expect(host()?.hasAttribute("data-vex-k2-open")).toBe(true);
    expect(host()?.hasAttribute("data-vex-k2-closed")).toBe(false);
    rerender(<VexK2 placement="sidebar" ground="print" open closed className="h-[280px]" />);
    expect(host()?.hasAttribute("data-vex-k2-closed")).toBe(true);
    rerender(<VexK2 placement="sidebar" ground="print" className="h-[280px]" />);
    expect(host()?.hasAttribute("data-vex-k2-open")).toBe(false);
    expect(host()?.hasAttribute("data-vex-k2-closed")).toBe(false);
  });

  it("hands its caller the coin's box on its fit, and stays decorative with the toggle on", () => {
    // her host has a size; the art never arrives (the box comes from the fit, before any art)
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(284);
    try {
      const boxes: Box[] = [];
      const { container, unmount } = render(
        <VexK2 placement="welcome" ground="paper" tokenOnly onTokenBox={(b) => boxes.push(b)} />,
      );
      const fit = fitFor("welcome", 320, 284);
      if (fit === null) throw new Error("no fit");
      // every fit sends it (the mount and the emotion's re-fit), always the same coin
      expect(boxes.length).toBeGreaterThan(0);
      for (const b of boxes) expect(b).toEqual(tokenBox(fit));
      const host = container.querySelector("[data-vex-k2]");
      expect(host?.getAttribute("aria-hidden")).toBe("true");
      expect(host?.className).toContain("pointer-events-none");
      expect(host?.querySelector("button")).toBeNull();
      // the state seam waits for the engine's first report
      expect(host?.hasAttribute("data-vex-k2-token")).toBe(false);
      unmount();
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });
});
