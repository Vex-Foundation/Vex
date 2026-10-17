/**
 * useMasterPasswordStrength - real @zxcvbn-ts/core behavior (no mocks).
 * KeystoreStep.test.tsx mocks this hook entirely for its own submit-wiring
 * tests; this file is where the actual estimator + label mapping is
 * verified against real scores (confirmed via a scratch script against the
 * installed `@zxcvbn-ts/core` + `language-common` + `language-en` before
 * writing these assertions).
 */

import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  MIN_ACCEPTABLE_SCORE,
  labelForScore,
  useMasterPasswordStrength,
} from "../useMasterPasswordStrength.js";

// The dynamic import() that loads @zxcvbn-ts/core + its dictionaries can be
// slow on a cold Vite transform (first module in this file to trigger it),
// well past testing-library's default 1000ms waitFor window. A generous
// fixed timeout avoids flaking on that one-time transform cost without
// masking a genuine regression (a real stuck load would still time out).
const READY_TIMEOUT = { timeout: 8000 };

describe("labelForScore", () => {
  it("maps every zxcvbn score (0-4) to weak/fair/good/strong", () => {
    expect(labelForScore(0)).toBe("weak");
    expect(labelForScore(1)).toBe("weak");
    expect(labelForScore(2)).toBe("fair");
    expect(labelForScore(3)).toBe("good");
    expect(labelForScore(4)).toBe("strong");
  });
});

describe("MIN_ACCEPTABLE_SCORE", () => {
  it("is 3 ('good' or better required to submit)", () => {
    expect(MIN_ACCEPTABLE_SCORE).toBe(3);
  });
});

describe("useMasterPasswordStrength", () => {
  it("is not ready before the estimator has loaded", () => {
    const { result } = renderHook(() =>
      useMasterPasswordStrength("password123")
    );
    // Synchronous first render, before the dynamic import resolves.
    expect(result.current.ready).toBe(false);
    expect(result.current.score).toBe(0);
    expect(result.current.meetsMinimumScore).toBe(false);
  });

  it("scores an empty password as not-meeting-minimum once ready, with no feedback", async () => {
    const { result } = renderHook(() => useMasterPasswordStrength(""));
    await waitFor(() => expect(result.current.ready).toBe(true), READY_TIMEOUT);
    expect(result.current.score).toBe(0);
    expect(result.current.label).toBe("weak");
    expect(result.current.meetsMinimumScore).toBe(false);
    expect(result.current.warning).toBeNull();
    expect(result.current.suggestions).toEqual([]);
  });

  it("scores a real common/weak password below the minimum, with feedback", async () => {
    const { result } = renderHook(() =>
      useMasterPasswordStrength("password123")
    );
    await waitFor(() => expect(result.current.ready).toBe(true), READY_TIMEOUT);
    expect(result.current.score).toBe(0);
    expect(result.current.label).toBe("weak");
    expect(result.current.meetsMinimumScore).toBe(false);
    expect(result.current.warning).toBe("This is a commonly used password.");
    expect(result.current.suggestions.length).toBeGreaterThan(0);
  });

  it("scores a real long random passphrase as meeting the minimum, with no feedback", async () => {
    const { result } = renderHook(() =>
      useMasterPasswordStrength("correct-horse-battery-staple-93!")
    );
    await waitFor(() => expect(result.current.ready).toBe(true), READY_TIMEOUT);
    expect(result.current.score).toBe(4);
    expect(result.current.label).toBe("strong");
    expect(result.current.meetsMinimumScore).toBe(true);
    expect(result.current.warning).toBeNull();
    expect(result.current.suggestions).toEqual([]);
  });

  it("re-scores when the password prop changes", async () => {
    const { result, rerender } = renderHook(
      ({ password }) => useMasterPasswordStrength(password),
      { initialProps: { password: "password123" } }
    );
    await waitFor(() => expect(result.current.ready).toBe(true), READY_TIMEOUT);
    expect(result.current.meetsMinimumScore).toBe(false);

    rerender({ password: "correct-horse-battery-staple-93!" });
    await waitFor(() => expect(result.current.score).toBe(4), READY_TIMEOUT);
    expect(result.current.meetsMinimumScore).toBe(true);
  });
});
