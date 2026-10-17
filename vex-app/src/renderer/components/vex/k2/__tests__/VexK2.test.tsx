/**
 * The K2 host (`VexK2.tsx`) in jsdom, where no canvas paints. Regressions this catches: a host that
 * is announced to assistive tech or takes the pointer, a lost placement or ground seam, and a mount
 * that throws or starts fetching art while its host has no size.
 */

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
