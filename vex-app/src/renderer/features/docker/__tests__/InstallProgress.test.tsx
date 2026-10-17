/**
 * The installer's progress strip (`InstallProgress.tsx`): the phase word and the percent over the
 * 2px progress line, filled by the real percent; nothing while inactive.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { InstallProgress } from "@shared/schemas/docker.js";
import { InstallProgressStrip } from "../InstallProgress.js";

type Listener = (payload: InstallProgress) => void;

function arrange(): { emit: Listener; off: ReturnType<typeof vi.fn> } {
  let listener: Listener | null = null;
  const off = vi.fn();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      docker: {
        onInstallProgress: (cb: Listener) => {
          listener = cb;
          return off;
        },
      },
    },
  });
  return {
    emit: (payload) => {
      listener?.(payload);
    },
    off,
  };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "vex");
});

describe("InstallProgressStrip", () => {
  it("renders nothing while inactive", () => {
    arrange();
    const { container } = render(<InstallProgressStrip active={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("starts on the starting phase with a short segment, then follows the real percent", () => {
    const { emit } = arrange();
    const { container, getByText } = render(<InstallProgressStrip active />);
    expect(getByText("starting")).toBeTruthy();
    const fill = (): HTMLElement | null => container.querySelector(".vex-fr-progress__fill");
    expect(fill()?.style.width).toBe("33%");
    act(() => emit({ phase: "downloading", message: "Fetching the installer", percent: 42 }));
    expect(getByText("downloading").className).toContain("capitalize");
    expect(getByText("42%").className).toContain("vex-num");
    expect(getByText("Fetching the installer")).toBeTruthy();
    expect(fill()?.style.width).toBe("42%");
  });

  it("unsubscribes when it goes inactive or unmounts", () => {
    const { off } = arrange();
    const view = render(<InstallProgressStrip active />);
    view.unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
