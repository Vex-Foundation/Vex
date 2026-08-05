/**
 * pollKhalaniOrderToTerminal — bounded order tracking (Khalani Integration Guide).
 *
 * Terminal set {filled, refunded, failed}; `refund_pending` is NON-terminal and
 * must NOT end the poll. Cadence: 5s interval, 24 attempts (~2 min). A transient
 * getOrderById failure is swallowed and the loop continues. The budget is hard —
 * a never-terminal order returns its last OBSERVED status.
 *
 * Critically, the result DISTINGUISHES three outcomes: `terminal` (observed
 * terminal), `pending` (observed non-terminal, window closed), and `unavailable`
 * (NO poll ever succeeded — status API outage). There is NO synthetic default:
 * an all-failing track must never look like an observed `created` order.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetOrderById = vi.fn();
vi.mock("@tools/khalani/client.js", () => ({
  getKhalaniClient: () => ({ getOrderById: (...a: unknown[]) => mockGetOrderById(...a) }),
}));

const { pollKhalaniOrderToTerminal, KHALANI_TERMINAL_STATUSES } = await import("@tools/khalani/order-status.js");

beforeEach(() => {
  mockGetOrderById.mockReset();
});

describe("KHALANI_TERMINAL_STATUSES", () => {
  it("is exactly {filled, refunded, failed} — refund_pending is NOT terminal", () => {
    expect([...KHALANI_TERMINAL_STATUSES].sort()).toEqual(["failed", "filled", "refunded"]);
    expect(KHALANI_TERMINAL_STATUSES.has("refund_pending")).toBe(false);
  });
});

describe("pollKhalaniOrderToTerminal — bounded 5s/24 poll", () => {
  it("returns {kind:'terminal'} on the poll where it flips (filled)", async () => {
    vi.useFakeTimers();
    try {
      mockGetOrderById
        .mockResolvedValueOnce({ status: "deposited" })
        .mockResolvedValueOnce({ status: "published" })
        .mockResolvedValueOnce({ status: "filled" });

      const promise = pollKhalaniOrderToTerminal("o1");
      // Poll 1 at t=5s (deposited), poll 2 at t=10s (published), poll 3 at t=15s (filled).
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockGetOrderById).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await promise).toEqual({ kind: "terminal", status: "filled" });
      expect(mockGetOrderById).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT terminate on refund_pending — keeps polling, then returns {kind:'pending'} with it", async () => {
    vi.useFakeTimers();
    try {
      mockGetOrderById.mockResolvedValue({ status: "refund_pending" });
      const promise = pollKhalaniOrderToTerminal("o1");
      // Drive the full 24×5s = 120s budget.
      await vi.advanceTimersByTimeAsync(120_000);
      // Observed non-terminal → pending (NOT terminal, NOT unavailable).
      expect(await promise).toEqual({ kind: "pending", status: "refund_pending" });
      expect(mockGetOrderById).toHaveBeenCalledTimes(24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns {kind:'terminal', status:'refunded'} (distinct from refund_pending)", async () => {
    vi.useFakeTimers();
    try {
      mockGetOrderById.mockResolvedValueOnce({ status: "refunded" });
      const promise = pollKhalaniOrderToTerminal("o1");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await promise).toEqual({ kind: "terminal", status: "refunded" });
      expect(mockGetOrderById).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a transient failure and continues to a later terminal status", async () => {
    vi.useFakeTimers();
    try {
      mockGetOrderById
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ status: "failed" });
      const promise = pollKhalaniOrderToTerminal("o1");
      await vi.advanceTimersByTimeAsync(5_000); // poll 1 throws, swallowed
      await vi.advanceTimersByTimeAsync(5_000); // poll 2 → failed
      expect(await promise).toEqual({ kind: "terminal", status: "failed" });
      expect(mockGetOrderById).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a partial outage still reports the LAST OBSERVED non-terminal status as pending", async () => {
    vi.useFakeTimers();
    try {
      // One real observation ("deposited") then the API goes down for the rest.
      mockGetOrderById
        .mockResolvedValueOnce({ status: "deposited" })
        .mockRejectedValue(new Error("down"));
      const promise = pollKhalaniOrderToTerminal("o1");
      await vi.advanceTimersByTimeAsync(120_000);
      // A status WAS observed once → pending, not unavailable.
      expect(await promise).toEqual({ kind: "pending", status: "deposited" });
      expect(mockGetOrderById).toHaveBeenCalledTimes(24);
    } finally {
      vi.useRealTimers();
    }
  });

  // REAL timers deliberately: with a signal, `delay` is backed by
  // `node:timers/promises`, which vitest's fake timers do NOT intercept. These
  // assert real elapsed wall clock, which is also what the decree is about.
  describe("operator Stop", () => {
    it("returns {kind:'aborted'} in well under a second, without reading the status API", async () => {
      mockGetOrderById.mockResolvedValue({ status: "deposited" });
      const controller = new AbortController();
      controller.abort();

      const startedAt = Date.now();
      const result = await pollKhalaniOrderToTerminal("o1", controller.signal);

      expect(result).toEqual({ kind: "aborted", lastObserved: null });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      // Not a single provider call: the window never opened.
      expect(mockGetOrderById).not.toHaveBeenCalled();
    });

    it("aborts DURING the window instead of serving out the 120s budget", async () => {
      mockGetOrderById.mockResolvedValue({ status: "deposited" });
      const controller = new AbortController();
      setTimeout(() => { controller.abort(); }, 10);

      const startedAt = Date.now();
      const result = await pollKhalaniOrderToTerminal("o1", controller.signal);

      // The bespoke loop this replaced could only land at the next 5s boundary,
      // and at worst cost the full two minutes.
      expect(result).toEqual({ kind: "aborted", lastObserved: null });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });

    it("keeps the no-signal path unchanged (nothing to cancel, byte-identical cadence)", async () => {
      vi.useFakeTimers();
      try {
        mockGetOrderById.mockResolvedValueOnce({ status: "filled" });
        const promise = pollKhalaniOrderToTerminal("o1");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await promise).toEqual({ kind: "terminal", status: "filled" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("returns {kind:'unavailable'} when NO poll ever succeeds (status API outage, never a synthetic 'created')", async () => {
    vi.useFakeTimers();
    try {
      mockGetOrderById.mockRejectedValue(new Error("down"));
      const promise = pollKhalaniOrderToTerminal("o1");
      await vi.advanceTimersByTimeAsync(120_000);
      // NOT a synthetic "created": nothing was ever observed.
      expect(await promise).toEqual({ kind: "unavailable" });
      expect(mockGetOrderById).toHaveBeenCalledTimes(24);
    } finally {
      vi.useRealTimers();
    }
  });
});
