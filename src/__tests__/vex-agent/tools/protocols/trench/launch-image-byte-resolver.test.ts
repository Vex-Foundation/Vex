/**
 * C2b byte-resolver seam — fail-closed contract.
 *
 * The security property under test: with no main-side implementation mounted,
 * asking for launch image bytes THROWS a named error. It must never resolve to
 * `null`, empty bytes, or any other value a caller could mistake for "the user
 * simply has no image" — that difference decides whether a real, irreversible
 * on-chain create is signed with an empty image.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  LaunchImageResolverUnavailableError,
  hasLaunchImageByteResolver,
  hasLaunchImageOnchainByteResolver,
  registerLaunchImageByteResolver,
  registerLaunchImageOnchainByteResolver,
  resetLaunchImageByteResolver,
  resetLaunchImageOnchainByteResolver,
  resolveLaunchImageBytes,
  resolveLaunchImageOnchainBytes,
} from "@vex-agent/tools/protocols/shared/launch-image-byte-resolver.js";

afterEach(() => {
  resetLaunchImageByteResolver();
  resetLaunchImageOnchainByteResolver();
});

describe("launch image byte resolver", () => {
  it("fails closed by name when no resolver is registered", async () => {
    expect(hasLaunchImageByteResolver()).toBe(false);
    await expect(resolveLaunchImageBytes("img_1")).rejects.toBeInstanceOf(
      LaunchImageResolverUnavailableError,
    );
  });

  it("never answers a missing resolver with a silent empty image", async () => {
    const outcome = await resolveLaunchImageBytes("img_1").then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "threw" as const, error }),
    );
    expect(outcome.kind).toBe("threw");
  });

  it("delegates to the registered implementation and returns bytes + digest", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    registerLaunchImageByteResolver(async (imageId) =>
      imageId === "img_1" ? { bytes, digest: "abc" } : null,
    );

    expect(hasLaunchImageByteResolver()).toBe(true);
    await expect(resolveLaunchImageBytes("img_1")).resolves.toEqual({
      bytes,
      digest: "abc",
    });
  });

  it("distinguishes an unknown image (null) from an unmounted resolver (throw)", async () => {
    registerLaunchImageByteResolver(async () => null);
    await expect(resolveLaunchImageBytes("nope")).resolves.toBeNull();
  });

  it("reset unmounts the implementation and restores the fail-closed default", async () => {
    registerLaunchImageByteResolver(async () => ({
      bytes: new Uint8Array(),
      digest: "d",
    }));
    resetLaunchImageByteResolver();

    expect(hasLaunchImageByteResolver()).toBe(false);
    await expect(resolveLaunchImageBytes("img_1")).rejects.toBeInstanceOf(
      LaunchImageResolverUnavailableError,
    );
  });
});

/**
 * The TRENCH lane (per-lane image decision, 2026-08-19). Same fail-closed
 * contract, an INDEPENDENT slot, and a throw that names which seam is missing -
 * a half-mounted app must not be misread as a broken locker.
 */
describe("launch image ON-CHAIN byte resolver", () => {
  it("fails closed by name, and names ITS OWN seam", async () => {
    expect(hasLaunchImageOnchainByteResolver()).toBe(false);
    await expect(resolveLaunchImageOnchainBytes("img_1")).rejects.toBeInstanceOf(
      LaunchImageResolverUnavailableError,
    );
    await expect(resolveLaunchImageOnchainBytes("img_1")).rejects.toThrow(
      /no LaunchImageOnchainByteResolver is registered/,
    );
  });

  it("is a SEPARATE slot: mounting the original lane does not satisfy it", async () => {
    // One slot with a mode flag would let a half-finished bootstrap serve the
    // pools originals - possibly megabytes - into Trench calldata.
    registerLaunchImageByteResolver(async () => null);
    expect(hasLaunchImageByteResolver()).toBe(true);
    expect(hasLaunchImageOnchainByteResolver()).toBe(false);
    await expect(resolveLaunchImageOnchainBytes("img_1")).rejects.toBeInstanceOf(
      LaunchImageResolverUnavailableError,
    );
  });

  it("passes through 'resolved', 'no_onchain_variant', and null unchanged", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    registerLaunchImageOnchainByteResolver(async (imageId) => {
      if (imageId === "img_ok") return { kind: "resolved", bytes, digest: "a".repeat(64) };
      if (imageId === "img_big") return { kind: "no_onchain_variant", originalByteLength: 2_104_822 };
      return null;
    });

    await expect(resolveLaunchImageOnchainBytes("img_ok")).resolves.toEqual({
      kind: "resolved",
      bytes,
      digest: "a".repeat(64),
    });
    await expect(resolveLaunchImageOnchainBytes("img_big")).resolves.toEqual({
      kind: "no_onchain_variant",
      originalByteLength: 2_104_822,
    });
    // `null` still means "no such image" and nothing else.
    await expect(resolveLaunchImageOnchainBytes("img_missing")).resolves.toBeNull();
  });

  it("returns to failing closed after reset", async () => {
    registerLaunchImageOnchainByteResolver(async () => null);
    resetLaunchImageOnchainByteResolver();
    expect(hasLaunchImageOnchainByteResolver()).toBe(false);
    await expect(resolveLaunchImageOnchainBytes("img_1")).rejects.toBeInstanceOf(
      LaunchImageResolverUnavailableError,
    );
  });
});
