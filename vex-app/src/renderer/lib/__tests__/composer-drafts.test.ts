/**
 * Per-session draft store (B1): keyed persistence across session switches,
 * empty-write release, and subscriber notification.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDraft,
  draftKeyFor,
  readDraft,
  resetDraftsForTest,
  subscribeDrafts,
  WELCOME_DRAFT_KEY,
  writeDraft,
} from "../composer-drafts.js";

beforeEach(() => {
  resetDraftsForTest();
});

describe("composer-drafts", () => {
  it("a draft written under one session key survives reads under other keys and comes back verbatim", () => {
    writeDraft("session-a", "half-typed order");
    writeDraft("session-b", "another thought");
    expect(readDraft("session-a")).toBe("half-typed order");
    expect(readDraft("session-b")).toBe("another thought");
    // Switching away and back is just reading the key again - nothing decays.
    expect(readDraft("session-a")).toBe("half-typed order");
  });

  it("an unknown key reads as the empty draft, never undefined", () => {
    expect(readDraft("never-written")).toBe("");
  });

  it("the welcome composer maps the null session onto the reserved key", () => {
    expect(draftKeyFor(null)).toBe(WELCOME_DRAFT_KEY);
    expect(draftKeyFor("s1")).toBe("s1");
  });

  it("writing the empty string releases the slot instead of storing ''", () => {
    writeDraft("session-a", "text");
    clearDraft("session-a");
    expect(readDraft("session-a")).toBe("");
  });

  it("notifies subscribers on a real change and stays silent on a no-op write", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDrafts(listener);
    writeDraft("session-a", "x");
    expect(listener).toHaveBeenCalledTimes(1);
    // Same value again - no notification, so useSyncExternalStore stays calm.
    writeDraft("session-a", "x");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    writeDraft("session-a", "y");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
