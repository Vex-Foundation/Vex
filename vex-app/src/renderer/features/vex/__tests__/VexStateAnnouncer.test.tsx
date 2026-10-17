/**
 * The one announcer of Vex's state (docs/design/R3-MINIMAL.md section 5.2). What is pinned:
 *
 *  - ONE polite region, visually hidden but in the accessibility tree, and no severity prefix;
 *  - the word once per change, one task after it, and the same word spoken again later is still
 *    a DOM change (the alternating pair);
 *  - a flicker is one word: a newer change cancels the one still waiting;
 *  - NO DOUBLE SPEECH with the app's `NotificationAnnouncer`: a notification spoken in the same
 *    moment as the change (just before it or in the same commit) takes the moment, and the word
 *    is dropped; an older one does not mute it.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notify } from "../../../lib/notifications/index.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { SAME_MOMENT_MS } from "../vex-announce.js";
import { VexStateAnnouncer, type VexStateAnnouncerProps } from "../VexStateAnnouncer.js";
import { VEX_STATE_WORD, type VexState } from "../vex-state.js";

const SESSION = "00000000-0000-4000-8000-0000000000a1";

function props(state: VexState, live = false): VexStateAnnouncerProps {
  return { state, word: VEX_STATE_WORD[state], live };
}

function region(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='vex-state-announcer']");
  if (el === null) throw new Error("announcer missing");
  return el;
}

/** What the region holds right now. */
function spoken(): string {
  return region().textContent ?? "";
}

/** Let the waiting word land. */
function flush(): void {
  act(() => {
    vi.advanceTimersByTime(0);
  });
}

/** Mount, and let the first reads settle (mounting is a move: its moment is quiet). */
function mount(state: VexState): ReturnType<typeof render> {
  const view = render(<VexStateAnnouncer {...props(state)} />);
  act(() => {
    vi.advanceTimersByTime(SAME_MOMENT_MS);
  });
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
  useUiStore.setState({ runtimeMode: "agent", activeSessionId: SESSION, activeProjectId: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("VexStateAnnouncer", () => {
  it("is one visually hidden pair of polite status regions, silent at first", () => {
    render(<VexStateAnnouncer {...props("ready")} />);
    flush();
    expect(region().classList.contains("sr-only")).toBe(true);
    const halves = region().querySelectorAll("[role='status']");
    expect(halves).toHaveLength(2);
    for (const half of halves) expect(half.getAttribute("aria-atomic")).toBe("true");
    expect(spoken()).toBe("");
  });

  it("speaks the new word once, one task after the change, with no prefix", () => {
    const view = mount("ready");
    view.rerender(<VexStateAnnouncer {...props("sleeping")} />);
    expect(spoken()).toBe("");
    flush();
    expect(spoken()).toBe("Vex, Sleeping");
    // A re-render in the same state says nothing new.
    view.rerender(<VexStateAnnouncer {...props("sleeping")} />);
    flush();
    expect(spoken()).toBe("Vex, Sleeping");
  });

  it("speaks the same word again as a fresh DOM change", () => {
    const view = mount("ready");
    view.rerender(<VexStateAnnouncer {...props("working")} />);
    flush();
    const halves = (): string[] =>
      Array.from(region().querySelectorAll("[role='status']"), (node) => node.textContent ?? "");
    expect(halves()).toEqual(["Vex, Working", ""]);
    view.rerender(<VexStateAnnouncer {...props("sleeping")} />);
    flush();
    view.rerender(<VexStateAnnouncer {...props("working")} />);
    flush();
    expect(halves()).toEqual(["Vex, Working", ""]);
    view.rerender(<VexStateAnnouncer {...props("concerned")} />);
    view.rerender(<VexStateAnnouncer {...props("working")} />);
    flush();
    // "concerned" was cancelled by the newer change; "Working" lands in the other half.
    expect(halves()).toEqual(["", "Vex, Working"]);
  });

  it("speaks one word for a flicker: the state that holds", () => {
    const view = mount("ready");
    view.rerender(<VexStateAnnouncer {...props("concerned")} />);
    view.rerender(<VexStateAnnouncer {...props("sleeping")} />);
    flush();
    expect(spoken()).toBe("Vex, Sleeping");
  });

  it("leaves a live turn to the turn island", () => {
    const view = mount("ready");
    view.rerender(<VexStateAnnouncer {...props("thinking", true)} />);
    flush();
    view.rerender(<VexStateAnnouncer {...props("working", true)} />);
    flush();
    expect(spoken()).toBe("");
  });

  it("drops the word when a notification was spoken in the same moment", () => {
    const view = mount("working");
    // An engine failure is recorded (and announced) before the render that shows Error.
    act(() => {
      notify({ source: "engine", severity: "error", scope: { kind: "global" }, message: "The turn failed." });
    });
    view.rerender(<VexStateAnnouncer {...props("error")} />);
    flush();
    expect(spoken()).toBe("");
  });

  it("drops the word when the notification lands in the same commit, after it", () => {
    const view = mount("ready");
    view.rerender(<VexStateAnnouncer {...props("awaiting")} />);
    act(() => {
      notify({
        source: "approvals",
        severity: "info",
        scope: { kind: "global" },
        message: "An approval is waiting in Studio.",
      });
    });
    flush();
    expect(spoken()).toBe("");
  });

  it("is not muted by a notification from an earlier moment", () => {
    const view = mount("ready");
    act(() => {
      notify({ source: "updates", severity: "info", scope: { kind: "global" }, message: "An update is ready." });
    });
    act(() => {
      vi.advanceTimersByTime(SAME_MOMENT_MS + 1);
    });
    view.rerender(<VexStateAnnouncer {...props("sleeping")} />);
    flush();
    expect(spoken()).toBe("Vex, Sleeping");
  });

  it("says nothing while its first reads settle after it mounts", () => {
    const view = render(<VexStateAnnouncer {...props("ready")} />);
    view.rerender(<VexStateAnnouncer {...props("working")} />);
    flush();
    expect(spoken()).toBe("");
  });

  it("says nothing when the user opens another chat, while its reads settle", () => {
    const view = mount("working");
    act(() => {
      useUiStore.setState({ activeSessionId: "00000000-0000-4000-8000-0000000000b2" });
    });
    // The new chat's session and run arrive over the next renders.
    view.rerender(<VexStateAnnouncer {...props("ready")} />);
    flush();
    view.rerender(<VexStateAnnouncer {...props("sleeping")} />);
    flush();
    expect(spoken()).toBe("");
    // Once settled, a real change in that chat is spoken.
    act(() => {
      vi.advanceTimersByTime(SAME_MOMENT_MS);
    });
    view.rerender(<VexStateAnnouncer {...props("working")} />);
    flush();
    expect(spoken()).toBe("Vex, Working");
  });
});
