/**
 * The chat's first read and the earlier-messages band (`TranscriptStates.tsx`;
 * VEX Cloud's `ThreadLoading` and `ShowEarlier`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  EarlierBand,
  THREAD_LOADING_DELAY_MS,
  TranscriptLoadingState,
} from "../../SessionTranscript/TranscriptStates.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TranscriptLoadingState", () => {
  it("says Loading chat only once the read has lasted 200 ms", () => {
    vi.useFakeTimers();
    render(<TranscriptLoadingState />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(THREAD_LOADING_DELAY_MS - 1);
    });
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const status = screen.getByRole("status", { name: "Loading chat" });
    expect(status.textContent).toBe("Loading chat…");
  });
});

describe("EarlierBand", () => {
  it("keeps a status in every state, speaking only while a page loads", () => {
    const view = render(<EarlierBand state={null} onRetry={() => undefined} />);
    expect(screen.getByRole("status").textContent).toBe("");
    view.rerender(<EarlierBand state="loading" onRetry={() => undefined} />);
    expect(screen.getByRole("status").textContent).toBe("Loading earlier messages");
    view.rerender(<EarlierBand state="end" onRetry={() => undefined} />);
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByText("Start of the chat")).toBeTruthy();
  });

  it("offers Retry on a failure", () => {
    const onRetry = vi.fn();
    render(<EarlierBand state="error" onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toBe("Earlier messages did not load");
    screen.getByRole("button", { name: "Retry" }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
