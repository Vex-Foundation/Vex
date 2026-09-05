/**
 * The retention bound, asserted as the pure decision it is.
 *
 * No process here on purpose: the policy ("keep the leading bytes, drop whole
 * chunks past the bound, count both") is what the two fixtures rely on, and a
 * test that had to spawn something to reach it would be proving the spawn.
 */

import { test, expect } from "@playwright/test";
import { createBoundedTextCapture } from "./bounded-text-capture.js";

test.describe("bounded text capture", () => {
  test("keeps everything that fits and reports no drop", () => {
    const capture = createBoundedTextCapture("stream", 64);
    capture.append("hello ");
    capture.append("world");
    expect(capture.text()).toBe("hello world");
    expect(capture.droppedBytes()).toBe(0);
    expect(capture.droppedChunks()).toBe(0);
    expect(capture.dropReport()).toBe("");
  });

  test("drops the chunks past the bound and names the bytes it lost", () => {
    const capture = createBoundedTextCapture("codex stdout", 10);
    capture.append("0123456789");
    capture.append("this one does not fit");
    capture.append("nor this");

    expect(capture.text(), "the retained head is the bytes that fit").toBe("0123456789");
    expect(capture.droppedChunks()).toBe(2);
    expect(capture.droppedBytes()).toBe("this one does not fit".length + "nor this".length);
    // The whole point of the bound: the loss is REPORTED, not silent.
    expect(capture.dropReport()).toContain("codex stdout");
    expect(capture.dropReport()).toContain("2 chunk(s)");
    expect(capture.dropReport()).toContain(String(capture.droppedBytes()));
  });

  test("counts bytes rather than characters, so multi-byte text is bounded honestly", () => {
    // Four characters, twelve UTF-8 bytes: a character-counting bound would
    // have kept this and blown the budget by a factor of three.
    const capture = createBoundedTextCapture("stream", 8);
    capture.append("한국어글");
    expect(capture.text()).toBe("");
    expect(capture.droppedBytes()).toBe(12);
  });

  test("never splits a chunk, so retained text is always what the peer wrote", () => {
    const capture = createBoundedTextCapture("stream", 5);
    capture.append("abc");
    capture.append("de-too-long");
    expect(capture.text()).toBe("abc");
  });

  test("refuses a limit that is not a positive byte count", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => createBoundedTextCapture("stream", limit), String(limit)).toThrow(
        /positive byte limit/u,
      );
    }
  });
});
