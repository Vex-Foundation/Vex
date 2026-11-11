/**
 * The Needs you announcer (VEX Cloud's `needs-announcer.tsx`; H3-DESKTOP.md
 * section 4.8): with no header control, the header says a rise of the shared
 * Needs you count, politely, "{count} awaiting your approval", for one poll's
 * length. The first count and a fall are silent, a fall clears the words, and
 * a count nobody verified (loading, a failed read) is not a count.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NeedsYouResult } from "../useVexPresence.js";

const model = vi.hoisted(() => ({ current: null as NeedsYouResult | null }));

vi.mock("../useVexPresence.js", () => ({
  useNeedsYou: () => {
    if (model.current === null) throw new Error("model not arranged");
    return model.current;
  },
}));

const { NeedsYouAnnouncer, NEEDS_YOU_ANNOUNCE_MS, needsYouRiseSaid } = await import("../NeedsYouAnnouncer.js");

function arrange(status: NeedsYouResult["status"], count: number | null): void {
  model.current = {
    status,
    unknownCopy: null,
    count,
    items: [],
    retry: () => undefined,
    retrying: false,
  };
}

function said(): string {
  return document.querySelector("[data-vex-area='needs-you-announcer']")?.textContent ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("NeedsYouAnnouncer", () => {
  it("says only a rise after a known count", () => {
    expect(needsYouRiseSaid(null, 2)).toBe(false);
    expect(needsYouRiseSaid(2, 2)).toBe(false);
    expect(needsYouRiseSaid(2, 1)).toBe(false);
    expect(needsYouRiseSaid(0, 1)).toBe(true);
    expect(needsYouRiseSaid(1, null)).toBe(false);
  });

  it("is a polite status region, silent for the first count", () => {
    arrange("ready", 2);
    render(<NeedsYouAnnouncer />);
    const region = document.querySelector("[data-vex-area='needs-you-announcer']");
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(said()).toBe("");
  });

  it("says a rise from 0 for one poll, then falls quiet", () => {
    arrange("ready", 0);
    const view = render(<NeedsYouAnnouncer />);
    arrange("ready", 1);
    view.rerender(<NeedsYouAnnouncer />);
    expect(said()).toBe("1 awaiting your approval");
    act(() => {
      vi.advanceTimersByTime(NEEDS_YOU_ANNOUNCE_MS - 1);
    });
    expect(said()).toBe("1 awaiting your approval");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(said()).toBe("");
  });

  it("clears the words on a fall and says nothing for it", () => {
    arrange("ready", 1);
    const view = render(<NeedsYouAnnouncer />);
    arrange("ready", 3);
    view.rerender(<NeedsYouAnnouncer />);
    expect(said()).toBe("3 awaiting your approval");
    arrange("ready", 2);
    view.rerender(<NeedsYouAnnouncer />);
    expect(said()).toBe("");
  });

  it("never counts a read still loading or one that failed, and says the rise once it recovers", () => {
    arrange("loading", null);
    const view = render(<NeedsYouAnnouncer />);
    arrange("ready", 1);
    view.rerender(<NeedsYouAnnouncer />);
    // The first known count is silent, even after a load.
    expect(said()).toBe("");
    arrange("unknown", null);
    view.rerender(<NeedsYouAnnouncer />);
    expect(said()).toBe("");
    arrange("ready", 2);
    view.rerender(<NeedsYouAnnouncer />);
    expect(said()).toBe("2 awaiting your approval");
    // A failing read mid-way neither cuts the words short nor keeps them.
    arrange("unknown", null);
    view.rerender(<NeedsYouAnnouncer />);
    expect(said()).toBe("2 awaiting your approval");
    act(() => {
      vi.advanceTimersByTime(NEEDS_YOU_ANNOUNCE_MS);
    });
    expect(said()).toBe("");
  });
});
