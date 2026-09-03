/**
 * The Agent composer's focus seam, and the LATCH that makes the back-to-Agent
 * chord work.
 *
 * The chord's handler flips `runtimeMode` and then asks for the composer. At
 * that instant the Studio centre is still the mounted column and no composer
 * exists - `AppShell` renders the two as alternatives - so a seam that only
 * called a registered handle would answer nothing, every time, which is the
 * `document.body` landing this exists to repair.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearComposerFocus,
  focusAgentComposer,
  publishComposerFocus,
} from "../composer-focus.js";

afterEach(() => {
  clearComposerFocus();
});

describe("the Agent composer focus seam", () => {
  it("focuses a composer that is already mounted", () => {
    const focus = vi.fn();
    publishComposerFocus(focus);

    expect(focusAgentComposer()).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("latches a request made before any composer exists, and the next one takes it", () => {
    // The whole point: this is the ordinary case, not an edge case.
    const focus = vi.fn();
    expect(focusAgentComposer()).toBe(true);
    expect(focus).not.toHaveBeenCalled();

    publishComposerFocus(focus);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("consumes the request ONCE, so a later composer does not steal focus", () => {
    const first = vi.fn();
    const second = vi.fn();
    focusAgentComposer();

    publishComposerFocus(first)();
    publishComposerFocus(second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("does not let a composer that unmounted late delete its successor's handle", () => {
    const outgoing = vi.fn();
    const incoming = vi.fn();
    const unregisterOutgoing = publishComposerFocus(outgoing);
    publishComposerFocus(incoming);

    // The predecessor's cleanup runs AFTER the successor mounted.
    unregisterOutgoing();

    focusAgentComposer();
    expect(incoming).toHaveBeenCalledTimes(1);
    expect(outgoing).not.toHaveBeenCalled();
  });

  it("drops a pending request on teardown rather than firing it into the next window", () => {
    const focus = vi.fn();
    focusAgentComposer();
    clearComposerFocus();

    publishComposerFocus(focus);
    expect(focus).not.toHaveBeenCalled();
  });
});
