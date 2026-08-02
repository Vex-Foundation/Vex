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
  registerLaunchImageByteResolver,
  resetLaunchImageByteResolver,
  resolveLaunchImageBytes,
} from "@vex-agent/tools/protocols/trench/launch-image-byte-resolver.js";

afterEach(() => {
  resetLaunchImageByteResolver();
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
