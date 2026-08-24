/**
 * `trench.images` — the agent's read-only view of the image locker (C2).
 *
 * Two things this handler must never do, both pinned here:
 *  1. leak BYTES or anything byte-shaped into the model's context (rule 07) —
 *     including the sha256 digest, which is a content fingerprint of the
 *     user's own file and has no business in a prompt;
 *  2. report an EMPTY locker as a failure. An empty locker means "a human has
 *     to upload an image before this mission can go further", and `fail` reads
 *     to a model as "this tool is broken, try another approach" — which is
 *     exactly the wrong move at the exact moment it matters.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const listLaunchImages = vi.fn();

vi.mock("@vex-agent/db/repos/launch-images.js", () => ({
  listLaunchImages: () => listLaunchImages(),
}));

const { trenchImagesHandler } = await import(
  "@vex-agent/tools/protocols/trench/handlers/images.js"
);

function row(imageId: string, label: string, uploadedAt: string) {
  return {
    imageId,
    label,
    byteLength: 4096,
    mime: "image/png",
    width: 320,
    height: 200,
    digest: "a".repeat(64),
    uploadedAt,
  };
}

const NEWER = row("img_0123456789abcdef0123456789abcdef", "moon.png", "2026-08-02T12:00:00.000Z");
const OLDER = row("img_ffffffffffffffffffffffffffffffff", "rocket.png", "2026-08-01T09:00:00.000Z");

function parsed(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("metadata only — never bytes", () => {
  it("returns the C2 display fields", async () => {
    listLaunchImages.mockResolvedValue([NEWER]);
    const result = await trenchImagesHandler({});
    expect(result.success).toBe(true);
    const data = parsed(result.output);
    expect(data.images).toEqual([
      {
        imageId: NEWER.imageId,
        label: "moon.png",
        mime: "image/png",
        byteLength: 4096,
        width: 320,
        height: 200,
        uploadedAt: NEWER.uploadedAt,
      },
    ]);
  });

  it("does not expose the digest — a content fingerprint of the user's file", async () => {
    listLaunchImages.mockResolvedValue([NEWER]);
    const result = await trenchImagesHandler({});
    expect(result.output).not.toContain("a".repeat(64));
    expect(result.output).not.toContain("digest");
  });

  it("does not expose anything path-shaped", async () => {
    listLaunchImages.mockResolvedValue([NEWER]);
    const result = await trenchImagesHandler({});
    expect(result.output).not.toContain(".bin");
    expect(result.output).not.toMatch(/\/home\/|C:\\\\/);
  });

  it("preserves the repo's most-recent-first order", async () => {
    listLaunchImages.mockResolvedValue([NEWER, OLDER]);
    const data = parsed((await trenchImagesHandler({})).output);
    expect((data.images as Array<{ imageId: string }>).map((i) => i.imageId)).toEqual([
      NEWER.imageId,
      OLDER.imageId,
    ]);
  });
});

describe("the empty locker", () => {
  it("is a SUCCESS carrying guidance, not a failure", async () => {
    listLaunchImages.mockResolvedValue([]);
    const result = await trenchImagesHandler({});
    expect(result.success).toBe(true);
    const data = parsed(result.output);
    expect(data.count).toBe(0);
    expect(String(data.guidance)).toMatch(/TRENCH PHOTOS/);
    expect(String(data.guidance)).toMatch(/right side/i);
  });

  it("tells the agent not to attempt a launch", async () => {
    listLaunchImages.mockResolvedValue([]);
    const data = parsed((await trenchImagesHandler({})).output);
    expect(String(data.guidance)).toMatch(/do not attempt a launch/i);
  });

  it("omits the guidance once images exist", async () => {
    listLaunchImages.mockResolvedValue([NEWER]);
    const data = parsed((await trenchImagesHandler({})).output);
    expect(data.guidance).toBeUndefined();
  });
});

describe("limit", () => {
  it("defaults to 20 and reports how many exist beyond the page", async () => {
    listLaunchImages.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => row(`img_${String(i).padStart(32, "0")}`, `x${i}.png`, NEWER.uploadedAt)),
    );
    const data = parsed((await trenchImagesHandler({})).output);
    expect(data.count).toBe(20);
    expect(data.totalAvailable).toBe(25);
  });

  it("honours an explicit limit", async () => {
    listLaunchImages.mockResolvedValue([NEWER, OLDER]);
    const data = parsed((await trenchImagesHandler({ limit: 1 })).output);
    expect(data.count).toBe(1);
  });
});

// ── The dropped rows are stated, not silent (O4, owner ruling D16) ──
//
// This read is `bounded_non_pageable` (parameter-vocabulary.md 4.1): it drops
// rows and offers NO continuation, so the reply has to say that it dropped
// them and name the one knob that brings them back. The boundary is what
// matters here: exactly `limit` rows is not truncation, one more row is.
describe("truncation disclosure", () => {
  it("reports truncated:false when the locker holds exactly `limit` rows", async () => {
    listLaunchImages.mockResolvedValue([NEWER, OLDER]);
    const data = parsed((await trenchImagesHandler({ limit: 2 })).output);
    expect(data.truncated).toBe(false);
    expect(data.truncationNote).toBeUndefined();
  });

  it("reports truncated:true with the dropped count and the narrowing action one row later", async () => {
    listLaunchImages.mockResolvedValue([NEWER, OLDER]);
    const data = parsed((await trenchImagesHandler({ limit: 1 })).output);
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toContain("1 more image exists");
    expect(String(data.truncationNote)).toMatch(/no continuation/i);
    expect(String(data.truncationNote)).toContain("raise `limit` (maximum 50)");
  });

  it("says the rest are unreachable when `limit` is already at its maximum", async () => {
    listLaunchImages.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => row(`img_${String(i).padStart(32, "0")}`, `x${i}.png`, NEWER.uploadedAt)),
    );
    const data = parsed((await trenchImagesHandler({ limit: 50 })).output);
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toContain("unreachable here");
    expect(String(data.truncationNote)).not.toContain("raise `limit`");
  });

  it("an empty locker is not truncated", async () => {
    listLaunchImages.mockResolvedValue([]);
    const data = parsed((await trenchImagesHandler({})).output);
    expect(data.truncated).toBe(false);
  });

  it.each([0, -1, 51, 1.5])("rejects limit=%s BY NAME rather than clamping", async (limit) => {
    listLaunchImages.mockResolvedValue([NEWER]);
    const result = await trenchImagesHandler({ limit });
    expect(result.success).toBe(false);
    expect(result.output).toContain("limit");
    expect(listLaunchImages).not.toHaveBeenCalled();
  });
});

describe("an unreadable locker", () => {
  it("fails, and warns against launching on an unconfirmed image", async () => {
    listLaunchImages.mockRejectedValue(new Error("connection refused"));
    const result = await trenchImagesHandler({});
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/do not launch/i);
  });
});
