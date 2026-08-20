/**
 * Submission policy (B13): the pure gesture resolver's full matrix and the
 * persisted preference store's default + coercion.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SUBMIT_KEY_BEHAVIOR,
  getSubmitKeyBehavior,
  resetSubmitKeyBehaviorForTest,
  resolveSubmitKeyGesture,
  setSubmitKeyBehavior,
  type ComposerKeyGesture,
} from "../composer-submission-policy.js";

function gesture(over: Partial<ComposerKeyGesture> = {}): ComposerKeyGesture {
  return {
    key: "Enter",
    shiftKey: false,
    modKey: false,
    isComposing: false,
    ...over,
  };
}

beforeEach(async () => {
  window.localStorage.clear();
  await resetSubmitKeyBehaviorForTest();
});

describe("resolveSubmitKeyGesture", () => {
  it("plain Enter submits under the default policy (the app's behavior to date)", () => {
    expect(resolveSubmitKeyGesture("enter", gesture())).toBe("submit");
  });

  it("plain Enter inserts a newline under the mod-enter policy", () => {
    expect(resolveSubmitKeyGesture("mod-enter", gesture())).toBe("newline");
  });

  it("Cmd/Ctrl+Enter submits under BOTH policies - the chord is always safe muscle memory", () => {
    expect(resolveSubmitKeyGesture("enter", gesture({ modKey: true }))).toBe(
      "submit",
    );
    expect(
      resolveSubmitKeyGesture("mod-enter", gesture({ modKey: true })),
    ).toBe("submit");
  });

  it("Shift+Enter inserts a newline under both policies", () => {
    expect(resolveSubmitKeyGesture("enter", gesture({ shiftKey: true }))).toBe(
      "newline",
    );
    expect(
      resolveSubmitKeyGesture("mod-enter", gesture({ shiftKey: true })),
    ).toBe("newline");
  });

  it("a live IME composition passes the key to the IME, never submits", () => {
    expect(
      resolveSubmitKeyGesture("enter", gesture({ isComposing: true })),
    ).toBe("pass");
  });

  it("non-Enter keys pass through untouched", () => {
    expect(resolveSubmitKeyGesture("enter", gesture({ key: "a" }))).toBe(
      "pass",
    );
  });
});

describe("submit-key preference store", () => {
  it("defaults to plain-Enter submit and persists an explicit change", async () => {
    expect(getSubmitKeyBehavior()).toBe(DEFAULT_SUBMIT_KEY_BEHAVIOR);
    setSubmitKeyBehavior("mod-enter");
    expect(getSubmitKeyBehavior()).toBe("mod-enter");
    // A fresh rehydrate reads the persisted value back.
    await resetSubmitKeyBehaviorForTest();
    expect(getSubmitKeyBehavior()).toBe("mod-enter");
  });

  it("coerces an unknown persisted value back to the default instead of trusting storage", async () => {
    window.localStorage.setItem(
      "vex.composer.submit-key",
      JSON.stringify({ state: { behavior: "garbage" }, version: 1 }),
    );
    await resetSubmitKeyBehaviorForTest();
    expect(getSubmitKeyBehavior()).toBe(DEFAULT_SUBMIT_KEY_BEHAVIOR);
  });
});
