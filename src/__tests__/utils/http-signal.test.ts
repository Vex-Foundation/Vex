/**
 * Wave S1 (T3) — `fetchWithTimeout` signal composition.
 *
 * Three properties:
 *  - no caller signal ⇒ the timeout path is unchanged and still produces the
 *    `HTTP_TIMEOUT` VexError (regression guard for all 13 provider clients);
 *  - a caller abort is NOT reported as `HTTP_TIMEOUT`. Telling the agent
 *    "Request timed out after 30000ms" when the operator pressed Stop is a lie
 *    to the agent (owner decree 2026-08-02) — the abort propagates as itself;
 *  - supplying a caller signal does NOT remove the timeout ceiling: when the
 *    deadline fires first the error is still `HTTP_TIMEOUT`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "@utils/http.js";
import { ErrorCodes, VexError } from "../../errors.js";

/** A fetch that never answers; it only rejects when its signal aborts. */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason as Error);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
    })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithTimeout signal composition", () => {
  it("keeps the HTTP_TIMEOUT shape when no caller signal is supplied", async () => {
    vi.stubGlobal("fetch", hangingFetch());

    let thrown: unknown;
    try {
      await fetchWithTimeout("https://example.test/x", { timeoutMs: 10 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(VexError);
    const error = thrown as VexError;
    expect(error.code).toBe(ErrorCodes.HTTP_TIMEOUT);
    expect(error.message).toBe("Request timed out after 10ms");
  });

  it("does not report a caller abort as HTTP_TIMEOUT", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();
    const pending = fetchWithTimeout("https://example.test/x", {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);

    let thrown: unknown;
    try {
      await pending;
    } catch (err) {
      thrown = err;
    }

    expect(thrown).not.toBeInstanceOf(VexError);
    expect((thrown as Error).name).toBe("AbortError");
  });

  it("keeps the timeout ceiling when a caller signal is present", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();

    let thrown: unknown;
    try {
      await fetchWithTimeout("https://example.test/x", {
        timeoutMs: 10,
        signal: controller.signal,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(VexError);
    expect((thrown as VexError).code).toBe(ErrorCodes.HTTP_TIMEOUT);
    expect(controller.signal.aborted).toBe(false);
  });
});
