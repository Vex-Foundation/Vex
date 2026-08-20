/**
 * Composer queue store (A27): per-session isolation, FIFO order, row
 * mutations, and the take-for-dispatch contract (a removed row must never
 * dispatch).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  enqueueMessage,
  readQueue,
  removeQueuedMessage,
  resetComposerQueueForTest,
  takeQueuedMessage,
  updateQueuedMessage,
} from "../composer-queue.js";

beforeEach(() => {
  resetComposerQueueForTest();
});

describe("composer-queue", () => {
  it("queues per session in FIFO order and never leaks rows across sessions", () => {
    enqueueMessage("s1", "first");
    enqueueMessage("s1", "second");
    enqueueMessage("s2", "other session");
    expect(readQueue("s1").map((row) => row.text)).toEqual([
      "first",
      "second",
    ]);
    expect(readQueue("s2").map((row) => row.text)).toEqual(["other session"]);
  });

  it("take with no id pops the HEAD, so the drain sends messages in the order they were queued", () => {
    enqueueMessage("s1", "first");
    enqueueMessage("s1", "second");
    expect(takeQueuedMessage("s1")?.text).toBe("first");
    expect(takeQueuedMessage("s1")?.text).toBe("second");
    expect(takeQueuedMessage("s1")).toBeNull();
  });

  it("take by id pops exactly the named row (send-now on a non-head row)", () => {
    enqueueMessage("s1", "first");
    const second = enqueueMessage("s1", "second");
    expect(takeQueuedMessage("s1", second.id)?.text).toBe("second");
    expect(readQueue("s1").map((row) => row.text)).toEqual(["first"]);
  });

  it("a row removed before dispatch is never taken - take answers null instead of sending a deleted message", () => {
    const row = enqueueMessage("s1", "obsolete");
    removeQueuedMessage("s1", row.id);
    expect(takeQueuedMessage("s1", row.id)).toBeNull();
    expect(takeQueuedMessage("s1")).toBeNull();
  });

  it("an edit rewrites the row text in place without reordering", () => {
    const first = enqueueMessage("s1", "first");
    enqueueMessage("s1", "second");
    updateQueuedMessage("s1", first.id, "first, revised");
    expect(readQueue("s1").map((row) => row.text)).toEqual([
      "first, revised",
      "second",
    ]);
  });
});
