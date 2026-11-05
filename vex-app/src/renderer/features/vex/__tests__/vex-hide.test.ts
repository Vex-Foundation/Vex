/**
 * The meeting point of the Vex toggles and the open sidebar (docs/design/H3-DESKTOP.md sections
 * 3.4 and 3.6): a hide the user asks for is left to the sidebar that takes it, and commits at
 * once when the sidebar declines or when no sidebar is open.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  keepVex,
  registerVexCloser,
  requestVexHide,
  setVexClosing,
  vexClosing,
  type VexCloser,
} from "../vex-hide.js";

const disposers: (() => void)[] = [];

function register(closer: VexCloser): () => void {
  const dispose = registerVexCloser(closer);
  disposers.push(dispose);
  return dispose;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  setVexClosing(false);
});

describe("requestVexHide", () => {
  it("commits at once when no sidebar is open", () => {
    const commit = vi.fn();
    requestVexHide(commit);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("leaves the commit to the sidebar that takes the request", () => {
    const commit = vi.fn();
    const close = vi.fn(() => true);
    register({ close, keep: () => undefined });
    requestVexHide(commit);
    expect(close).toHaveBeenCalledWith(commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits at once when the sidebar declines (her section's own wipe is the close)", () => {
    const commit = vi.fn();
    register({ close: () => false, keep: () => undefined });
    requestVexHide(commit);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("asks the sidebar to keep her on a second press", () => {
    const keep = vi.fn();
    register({ close: () => true, keep });
    keepVex();
    expect(keep).toHaveBeenCalledTimes(1);
  });
});

describe("registerVexCloser", () => {
  it("clears only its own registration, and the closing flag with it", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const disposeFirst = register({ close: first, keep: () => undefined });
    register({ close: second, keep: () => undefined });
    setVexClosing(true);
    // A StrictMode re-run disposes the first after the second registered: the live one stays.
    disposeFirst();
    expect(vexClosing()).toBe(true);
    requestVexHide(() => undefined);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
