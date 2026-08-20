/**
 * useCopyFeedback tests: success flips `copied` for the feedback window; a
 * refused write leaves the flag untouched (the control never claims a copy
 * the host declined).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { COPY_FEEDBACK_MS, useCopyFeedback } from "../use-copy-feedback.js";

function stubClipboard(writeText: () => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useCopyFeedback", () => {
  it("flips copied on success and clears after the feedback window", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { result } = renderHook(() => useCopyFeedback("0xabc"));
    expect(result.current.copied).toBe(false);
    await act(async () => {
      result.current.onCopy();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writeText).toHaveBeenCalledWith("0xabc");
    expect(result.current.copied).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS);
    });
    expect(result.current.copied).toBe(false);
  });

  it("stays false when the host refuses the write", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    // jsdom has no execCommand; define the selection fallback as refusing.
    Object.defineProperty(document, "execCommand", {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
    });
    const { result } = renderHook(() => useCopyFeedback("0xabc"));
    await act(async () => {
      result.current.onCopy();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.copied).toBe(false);
  });

  it("honors a custom feedback duration", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { result } = renderHook(() => useCopyFeedback("x", 100));
    await act(async () => {
      result.current.onCopy();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.copied).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.copied).toBe(false);
  });
});
