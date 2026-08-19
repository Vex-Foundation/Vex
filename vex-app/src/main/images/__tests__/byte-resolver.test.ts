/**
 * C2b — the main-side byte resolver.
 *
 * This is the last gate before image bytes reach a real, irreversible on-chain
 * `create`. What it must guarantee:
 *
 *  - bytes come back paired with the digest RECORDED IN METADATA, so the
 *    execute leg can compare that against the digest bound in the C0
 *    authorization record;
 *  - if the bytes on disk no longer hash to the recorded digest, NOTHING comes
 *    back. An image swapped between authorization and execution must be
 *    indistinguishable from a missing one, because "missing" is a refusal the
 *    caller already handles and "swapped" must never be signed over;
 *  - a missing image is `null` — a normal answer — while a BROKEN store
 *    throws, because a launch must not read "the locker is unreadable" as
 *    "there is no picture" and carry on;
 *  - with nothing registered, the runtime seam throws by name rather than
 *    defaulting to an empty image.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getLockerImage = vi.fn();
const readImageBytes = vi.fn();
const readLockerImageOnchainBytes = vi.fn();

vi.mock("../locker.js", () => ({
  getLockerImage: (id: string) => getLockerImage(id),
  readLockerImageOnchainBytes: (id: string) => readLockerImageOnchainBytes(id),
}));

vi.mock("../byte-store.js", async () => {
  const { createHash } = await import("node:crypto");
  return {
    readImageBytes: (id: string) => readImageBytes(id),
    digestOf: (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"),
  };
});

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createHash } = await import("node:crypto");
const {
  resolveLockerImageBytesForLaunch,
  resolveLockerImageOnchainBytesForLaunch,
  mountLaunchImageByteResolver,
} = await import("../byte-resolver.js");
const seam = await import(
  "@vex-agent/tools/protocols/shared/launch-image-byte-resolver.js"
);

const IMAGE_ID = "img_0123456789abcdef0123456789abcdef";
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const DIGEST = createHash("sha256").update(BYTES).digest("hex");

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    imageId: IMAGE_ID,
    label: "moon.png",
    byteLength: BYTES.byteLength,
    mime: "image/png",
    width: 320,
    height: 200,
    digest: DIGEST,
    onchainByteLength: BYTES.byteLength,
    uploadedAt: "2026-08-02T10:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  seam.resetLaunchImageByteResolver();
  seam.resetLaunchImageOnchainByteResolver();
  vi.clearAllMocks();
});

describe("resolveLockerImageBytesForLaunch", () => {
  it("returns the bytes with the RECORDED digest, so the caller can bind it", async () => {
    getLockerImage.mockResolvedValue(metadata());
    readImageBytes.mockResolvedValue(BYTES);
    await expect(resolveLockerImageBytesForLaunch(IMAGE_ID)).resolves.toEqual({
      bytes: BYTES,
      digest: DIGEST,
    });
  });

  it("returns null for an unknown image id", async () => {
    getLockerImage.mockResolvedValue(null);
    await expect(resolveLockerImageBytesForLaunch(IMAGE_ID)).resolves.toBeNull();
    expect(readImageBytes).not.toHaveBeenCalled();
  });

  it("returns null when the metadata exists but the bytes are gone", async () => {
    getLockerImage.mockResolvedValue(metadata());
    readImageBytes.mockResolvedValue(null);
    await expect(resolveLockerImageBytesForLaunch(IMAGE_ID)).resolves.toBeNull();
  });

  it("REFUSES bytes that no longer match the recorded digest — the swap case", async () => {
    const swapped = new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9, 9, 9]);
    getLockerImage.mockResolvedValue(metadata());
    readImageBytes.mockResolvedValue(swapped);
    await expect(resolveLockerImageBytesForLaunch(IMAGE_ID)).resolves.toBeNull();
  });

  it("refuses when the byte length disagrees with the metadata", async () => {
    const shorter = BYTES.slice(0, 4);
    getLockerImage.mockResolvedValue(metadata({ digest: createHash("sha256").update(shorter).digest("hex") }));
    readImageBytes.mockResolvedValue(shorter);
    // digest agrees, length does not — still a refusal, because the two facts
    // disagreeing means one of them is wrong and we cannot tell which.
    await expect(resolveLockerImageBytesForLaunch(IMAGE_ID)).resolves.toBeNull();
  });

  it("propagates a broken store instead of reporting it as a missing image", async () => {
    getLockerImage.mockRejectedValue(new Error("connection refused"));
    await expect(resolveLockerImageBytesForLaunch(IMAGE_ID)).rejects.toThrow(/connection refused/);
  });
});

/**
 * The TRENCH lane. Its one job beyond the shared verification is to keep
 * "there is no on-chain copy" DISTINCT from "there is no such image": the
 * remedies differ, and telling a user their picture is missing while it sits in
 * the grid in front of them is both false and unactionable.
 */
describe("resolveLockerImageOnchainBytesForLaunch", () => {
  it("returns the verified copy when the locker has one", async () => {
    readLockerImageOnchainBytes.mockResolvedValue({ bytes: BYTES, digest: DIGEST });
    await expect(resolveLockerImageOnchainBytesForLaunch(IMAGE_ID)).resolves.toEqual({
      kind: "resolved",
      bytes: BYTES,
      digest: DIGEST,
    });
  });

  it("names 'no on-chain copy' for an image the ladder could not shrink", async () => {
    readLockerImageOnchainBytes.mockResolvedValue(null);
    getLockerImage.mockResolvedValue(metadata({ byteLength: 2_104_822, onchainByteLength: null }));

    await expect(resolveLockerImageOnchainBytesForLaunch(IMAGE_ID)).resolves.toEqual({
      kind: "no_onchain_variant",
      originalByteLength: 2_104_822,
    });
  });

  it("answers null for an image that genuinely is not in the locker", async () => {
    readLockerImageOnchainBytes.mockResolvedValue(null);
    getLockerImage.mockResolvedValue(null);
    await expect(resolveLockerImageOnchainBytesForLaunch(IMAGE_ID)).resolves.toBeNull();
  });

  it("answers null when the row claims a copy whose bytes did not verify", async () => {
    // Swapped or truncated bytes must look EXACTLY like a missing image, not
    // like a size problem the user could fix by picking something smaller.
    readLockerImageOnchainBytes.mockResolvedValue(null);
    getLockerImage.mockResolvedValue(metadata());
    await expect(resolveLockerImageOnchainBytesForLaunch(IMAGE_ID)).resolves.toBeNull();
  });
});

describe("mounting into the C2b seam", () => {
  beforeEach(() => {
    seam.resetLaunchImageByteResolver();
    seam.resetLaunchImageOnchainByteResolver();
  });

  it("fails closed by name on the ONCHAIN seam too, and says which seam is missing", async () => {
    expect(seam.hasLaunchImageOnchainByteResolver()).toBe(false);
    await expect(seam.resolveLaunchImageOnchainBytes(IMAGE_ID)).rejects.toThrow(
      /LaunchImageOnchainByteResolver/,
    );
  });

  it("mounts BOTH lanes, and tears both down together", async () => {
    getLockerImage.mockResolvedValue(metadata());
    readImageBytes.mockResolvedValue(BYTES);
    readLockerImageOnchainBytes.mockResolvedValue({ bytes: BYTES, digest: DIGEST });

    const unmount = mountLaunchImageByteResolver();
    expect(seam.hasLaunchImageByteResolver()).toBe(true);
    expect(seam.hasLaunchImageOnchainByteResolver()).toBe(true);
    await expect(seam.resolveLaunchImageOnchainBytes(IMAGE_ID)).resolves.toEqual({
      kind: "resolved",
      bytes: BYTES,
      digest: DIGEST,
    });

    unmount();
    expect(seam.hasLaunchImageByteResolver()).toBe(false);
    expect(seam.hasLaunchImageOnchainByteResolver()).toBe(false);
  });

  it("fails closed by name when nothing is registered — never an empty image", async () => {
    expect(seam.hasLaunchImageByteResolver()).toBe(false);
    await expect(seam.resolveLaunchImageBytes(IMAGE_ID)).rejects.toThrow(
      seam.LaunchImageResolverUnavailableError,
    );
  });

  it("serves the main-side implementation once mounted", async () => {
    getLockerImage.mockResolvedValue(metadata());
    readImageBytes.mockResolvedValue(BYTES);
    const unmount = mountLaunchImageByteResolver();
    expect(seam.hasLaunchImageByteResolver()).toBe(true);
    await expect(seam.resolveLaunchImageBytes(IMAGE_ID)).resolves.toEqual({
      bytes: BYTES,
      digest: DIGEST,
    });
    unmount();
  });

  it("returns to failing closed after teardown", async () => {
    const unmount = mountLaunchImageByteResolver();
    unmount();
    await expect(seam.resolveLaunchImageBytes(IMAGE_ID)).rejects.toThrow(
      seam.LaunchImageResolverUnavailableError,
    );
  });
});
