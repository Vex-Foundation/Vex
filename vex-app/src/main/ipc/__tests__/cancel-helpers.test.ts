/**
 * Tests for `raceWithAbort`, `isAbortError`, `cancelledError`.
 *
 * No Electron, no IPC — pure runtime behaviour.
 */

import { describe, expect, it } from "vitest";
import {
  AbortError,
  cancelledError,
  isAbortError,
  raceWithAbort,
} from "../cancel-helpers.js";

describe("isAbortError", () => {
  it("recognises an AbortError instance", () => {
    expect(isAbortError(new AbortError())).toBe(true);
  });

  it("recognises an Error with name=AbortError", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(isAbortError(e)).toBe(true);
  });

  it("recognises a plain object with name=AbortError (DOMException shape)", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError("aborted")).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError({ name: "TypeError" })).toBe(false);
  });
});

describe("raceWithAbort", () => {
  it("is a transparent pass-through when signal is undefined", async () => {
    const result = await raceWithAbort(Promise.resolve(42), undefined);
    expect(result).toBe(42);
  });

  it("resolves to the promise's value when the signal never aborts", async () => {
    const controller = new AbortController();
    const result = await raceWithAbort(Promise.resolve("ok"), controller.signal);
    expect(result).toBe("ok");
  });

  it("rejects immediately if the signal is already aborted before the race", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      raceWithAbort(new Promise(() => {}), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when the signal aborts mid-race", async () => {
    const controller = new AbortController();
    const slow = new Promise((resolve) => setTimeout(resolve, 10_000, "late"));
    const race = raceWithAbort(slow, controller.signal);
    controller.abort();
    await expect(race).rejects.toMatchObject({ name: "AbortError" });
  });

  it("forwards the inner rejection when the promise rejects before any abort", async () => {
    const controller = new AbortController();
    const reason = new Error("inner failure");
    await expect(
      raceWithAbort(Promise.reject(reason), controller.signal),
    ).rejects.toBe(reason);
  });

  it("cleans up the abort listener after resolve (no leaked listeners)", async () => {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    const origRemove =
      controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((
      ...args: Parameters<typeof origAdd>
    ) => {
      added += 1;
      return origAdd(...args);
    }) as typeof origAdd;
    controller.signal.removeEventListener = ((
      ...args: Parameters<typeof origRemove>
    ) => {
      removed += 1;
      return origRemove(...args);
    }) as typeof origRemove;
    await raceWithAbort(Promise.resolve("done"), controller.signal);
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });

  it("does NOT propagate the underlying promise's resolution after an abort", async () => {
    const controller = new AbortController();
    let resolveInner: ((v: string) => void) | null = null;
    const inner = new Promise<string>((res) => {
      resolveInner = res;
    });
    const race = raceWithAbort(inner, controller.signal);
    controller.abort();
    await expect(race).rejects.toMatchObject({ name: "AbortError" });
    // After abort, the inner promise's resolution is dropped — race
    // already rejected, can't be re-fulfilled.
    resolveInner!("too late");
    // No assertion: the test just verifies no unhandled rejection
    // and no thrown error from the late resolution.
  });
});

describe("cancelledError", () => {
  it("returns the canonical internal.cancelled VexError shape", () => {
    const err = cancelledError("database", "req-42");
    expect(err).toEqual({
      code: "internal.cancelled",
      domain: "database",
      message: "Operation cancelled.",
      retryable: true,
      userActionable: false,
      redacted: true,
      correlationId: "req-42",
    });
  });

  it("preserves the domain passed by the caller", () => {
    const err = cancelledError("wallet", "id-1");
    expect(err.domain).toBe("wallet");
  });
});
