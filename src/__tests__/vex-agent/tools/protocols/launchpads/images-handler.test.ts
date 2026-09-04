/**
 * `launchpads.images` - the agent's read-only view of the SHARED image locker.
 *
 * This is the Trench suite's contract one layer up, plus the two things that
 * are new because the locker stopped belonging to a single venue:
 *
 *  1. the reply carries `publicUrl` - a picture that already has a public
 *     address does not need publishing again, and the agent can only know
 *     that if it is told - while STILL never carrying the digest or a byte;
 *  2. the empty-locker guidance is launchpad-NEUTRAL. The previous wording
 *     named one venue, which taught the model the locker was that venue's.
 *
 * The truncation block is the same boundary the Trench suite pins, and it
 * asserts the NOTE, not merely the boolean: a silent cut is forbidden by
 * decree, so the reply has to state how many rows it dropped and how to reach
 * them. A test that only watched a flag would pass for a silent cut too.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const listLaunchImages = vi.fn();

vi.mock("@vex-agent/db/repos/launch-images.js", () => ({
  listLaunchImages: () => listLaunchImages(),
}));

const { launchpadsImagesHandler } = await import(
  "@vex-agent/tools/protocols/launchpads/handlers/images.js"
);

const DIGEST = "a".repeat(64);
const PUBLIC_CID = "b".repeat(64);
const PUBLIC_URL = `https://cdn.example.test/a/${PUBLIC_CID}.png`;

function row(
  imageId: string,
  label: string,
  uploadedAt: string,
  published: { cid: string; url: string } | null = null,
) {
  return {
    imageId,
    label,
    byteLength: 4096,
    mime: "image/png",
    width: 320,
    height: 200,
    digest: DIGEST,
    onchainByteLength: null,
    onchainDigest: null,
    uploadedAt,
    publicCid: published?.cid ?? null,
    publicUrl: published?.url ?? null,
    publicUploadedAt: published === null ? null : "2026-08-03T10:00:00.000Z",
  };
}

const NEWER = row("img_0123456789abcdef0123456789abcdef", "moon.png", "2026-08-02T12:00:00.000Z");
const OLDER = row("img_ffffffffffffffffffffffffffffffff", "rocket.png", "2026-08-01T09:00:00.000Z");
const PUBLISHED = row("img_cccccccccccccccccccccccccccccccc", "already.png", "2026-08-04T08:00:00.000Z", {
  cid: PUBLIC_CID,
  url: PUBLIC_URL,
});

function parsed(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

function manyRows(count: number) {
  return Array.from({ length: count }, (_, i) =>
    row(`img_${String(i).padStart(32, "0")}`, `x${i}.png`, NEWER.uploadedAt),
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("metadata only - never bytes", () => {
  it("returns the locker display fields, including whether the picture is already public", async () => {
    listLaunchImages.mockResolvedValue([NEWER]);
    const result = await launchpadsImagesHandler({});
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
        publicUrl: null,
      },
    ]);
  });

  it("carries the public URL for a published picture, so the agent does not publish it twice", async () => {
    listLaunchImages.mockResolvedValue([PUBLISHED, NEWER]);
    const data = parsed((await launchpadsImagesHandler({})).output);
    const images = data.images as Array<{ imageId: string; publicUrl: string | null }>;
    expect(images.map((i) => i.publicUrl)).toEqual([PUBLIC_URL, null]);
  });

  it("does not expose the digest - a content fingerprint of the user's own file", async () => {
    listLaunchImages.mockResolvedValue([NEWER, PUBLISHED]);
    const result = await launchpadsImagesHandler({});
    expect(result.output).not.toContain(DIGEST);
    expect(result.output).not.toContain("digest");
  });

  it("does not expose the public CID either: the URL is the only handle the agent needs", async () => {
    listLaunchImages.mockResolvedValue([PUBLISHED]);
    const result = await launchpadsImagesHandler({});
    expect(result.output).not.toContain("publicCid");
    expect(result.output).not.toContain("onchainDigest");
  });

  it("does not expose anything path-shaped", async () => {
    listLaunchImages.mockResolvedValue([NEWER]);
    const result = await launchpadsImagesHandler({});
    expect(result.output).not.toContain(".bin");
    expect(result.output).not.toMatch(/\/home\/|C:\\\\/);
  });

  it("preserves the repo's most-recent-first order", async () => {
    listLaunchImages.mockResolvedValue([NEWER, OLDER]);
    const data = parsed((await launchpadsImagesHandler({})).output);
    expect((data.images as Array<{ imageId: string }>).map((i) => i.imageId)).toEqual([
      NEWER.imageId,
      OLDER.imageId,
    ]);
  });
});

describe("the empty locker", () => {
  it("is a SUCCESS carrying guidance, not a failure", async () => {
    listLaunchImages.mockResolvedValue([]);
    const result = await launchpadsImagesHandler({});
    expect(result.success).toBe(true);
    const data = parsed(result.output);
    expect(data.count).toBe(0);
    expect(String(data.guidance)).toMatch(/right side/i);
  });

  it("tells the agent it cannot upload one itself, and that only the user can", async () => {
    listLaunchImages.mockResolvedValue([]);
    const data = parsed((await launchpadsImagesHandler({})).output);
    expect(String(data.guidance)).toMatch(/you cannot upload one/i);
    expect(String(data.guidance)).toMatch(/ask the user/i);
  });

  it("tells the agent not to attempt a launch", async () => {
    listLaunchImages.mockResolvedValue([]);
    const data = parsed((await launchpadsImagesHandler({})).output);
    expect(String(data.guidance)).toMatch(/do not attempt a launch/i);
  });

  // The locker is ONE locker, shared by every launchpad. Naming a venue in the
  // guidance is what taught the model it belonged to that venue.
  it("is launchpad-NEUTRAL: it names no single venue", async () => {
    listLaunchImages.mockResolvedValue([]);
    const guidance = String(parsed((await launchpadsImagesHandler({})).output).guidance);
    expect(guidance).not.toMatch(/trench/i);
    expect(guidance).not.toMatch(/pools\.fun/i);
    expect(guidance).not.toMatch(/pump\.fun/i);
  });

  it("omits the guidance once images exist", async () => {
    listLaunchImages.mockResolvedValue([NEWER]);
    const data = parsed((await launchpadsImagesHandler({})).output);
    expect(data.guidance).toBeUndefined();
  });
});

describe("limit", () => {
  it("defaults to 20 and reports how many exist beyond the page", async () => {
    listLaunchImages.mockResolvedValue(manyRows(25));
    const data = parsed((await launchpadsImagesHandler({})).output);
    expect(data.count).toBe(20);
    expect(data.totalAvailable).toBe(25);
  });

  it("honours an explicit limit", async () => {
    listLaunchImages.mockResolvedValue([NEWER, OLDER]);
    const data = parsed((await launchpadsImagesHandler({ limit: 1 })).output);
    expect(data.count).toBe(1);
  });
});

// ── The dropped rows are STATED, never silently cut ────────────────────────
//
// This read is `bounded_non_pageable`: it drops rows and offers no
// continuation, so the reply has to say that it dropped them, how many, and
// name the one knob that brings them back. The boundary is what matters:
// exactly `limit` rows is not truncation, one more row is.
describe("truncation disclosure", () => {
  it("reports truncated:false when the locker holds exactly `limit` rows", async () => {
    listLaunchImages.mockResolvedValue([NEWER, OLDER]);
    const data = parsed((await launchpadsImagesHandler({ limit: 2 })).output);
    expect(data.truncated).toBe(false);
    expect(data.truncationNote).toBeUndefined();
  });

  it("reports truncated:true with the dropped COUNT and the remedy one row later", async () => {
    listLaunchImages.mockResolvedValue([NEWER, OLDER]);
    const data = parsed((await launchpadsImagesHandler({ limit: 1 })).output);
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toContain("1 more image exists");
    expect(String(data.truncationNote)).toMatch(/no continuation/i);
    expect(String(data.truncationNote)).toContain("raise `limit` (maximum 50)");
  });

  it("states the plural dropped count, not just that something was dropped", async () => {
    listLaunchImages.mockResolvedValue(manyRows(25));
    const data = parsed((await launchpadsImagesHandler({ limit: 20 })).output);
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toContain("5 more images exist");
  });

  it("says the rest are unreachable and to ask the user when `limit` is already at its maximum", async () => {
    listLaunchImages.mockResolvedValue(manyRows(51));
    const data = parsed((await launchpadsImagesHandler({ limit: 50 })).output);
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toContain("1 more image exists");
    expect(String(data.truncationNote)).toContain("unreachable here");
    expect(String(data.truncationNote)).toMatch(/ask the user/i);
    expect(String(data.truncationNote)).not.toContain("raise `limit`");
  });

  it("an empty locker is not truncated", async () => {
    listLaunchImages.mockResolvedValue([]);
    const data = parsed((await launchpadsImagesHandler({})).output);
    expect(data.truncated).toBe(false);
  });

  it.each([0, -1, 51, 1.5])("rejects limit=%s BY NAME rather than clamping", async (limit) => {
    listLaunchImages.mockResolvedValue([NEWER]);
    const result = await launchpadsImagesHandler({ limit });
    expect(result.success).toBe(false);
    expect(result.output).toContain("limit");
    // The refusal is decided before the locker is read at all.
    expect(listLaunchImages).not.toHaveBeenCalled();
  });
});

describe("an unreadable locker", () => {
  it("fails, and warns against launching on an unconfirmed image", async () => {
    listLaunchImages.mockRejectedValue(new Error("connection refused"));
    const result = await launchpadsImagesHandler({});
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/do not launch/i);
  });

  it("returns no images at all when the locker could not be read", async () => {
    listLaunchImages.mockRejectedValue(new Error("connection refused"));
    const result = await launchpadsImagesHandler({});
    expect(result.output).not.toContain("imageId");
  });
});
