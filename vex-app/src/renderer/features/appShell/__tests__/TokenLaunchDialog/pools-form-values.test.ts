/**
 * The pools.fun form's validation rule.
 *
 * `poolsFormToPayload` returning `null` is what keeps stage 1 out of reach, so
 * every case here is a reason the user cannot yet ask main to prepare a launch.
 * Pinned as a pure function: these are the constraints on a money form and they
 * should be provable without a DOM.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_POOLS_LAUNCH_FORM,
  feeRecipientNeedsResolution,
  isAcceptableFeeRecipient,
  normalizePoolsAmount,
  poolsFormToPayload,
  type PoolsLaunchFormValues,
} from "../../TokenLaunchDialog/pools/form-values.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";

/** A form that is complete and valid, as the baseline for one-field defects. */
function validForm(over: Partial<PoolsLaunchFormValues> = {}): PoolsLaunchFormValues {
  return {
    ...EMPTY_POOLS_LAUNCH_FORM,
    name: "Flamingo",
    symbol: "FLAM",
    imageSource: "url",
    imageUrl: "https://example.test/flamingo.png",
    feeRecipient: ADDRESS,
    ...over,
  };
}

describe("poolsFormToPayload — what it accepts", () => {
  it("maps a complete form onto the wire payload", () => {
    expect(poolsFormToPayload(validForm())).toEqual({
      name: "Flamingo",
      symbol: "FLAM",
      pairedAsset: "weth",
      prebuy: null,
      image: { kind: "url", url: "https://example.test/flamingo.png" },
      tweetUrl: null,
      websiteUrl: null,
      feeRecipient: { kind: "address", address: ADDRESS },
    });
  });

  it("sends an X username as a RESOLVABLE choice, never as an address", () => {
    const payload = poolsFormToPayload(validForm({ feeRecipient: "@vexdotfun" }));
    expect(payload?.feeRecipient).toEqual({ kind: "x_username", username: "@vexdotfun" });
  });

  it("distinguishes NO prebuy from a prebuy of zero", () => {
    // An untouched field means the user asked for no prebuy at all, which is
    // absent on the wire — not the number zero.
    expect(poolsFormToPayload(validForm({ prebuy: "" }))?.prebuy).toBeNull();
    expect(poolsFormToPayload(validForm({ prebuy: "0.25" }))?.prebuy).toEqual({
      amountHuman: "0.25",
    });
  });

  it("sends the chosen source as ONE branch of the union, never both", () => {
    // The form keeps a locker id AND a URL box so switching does not lose what
    // was typed. The wire takes one branch, so the ambiguity that blanked a
    // funded launch cannot even be expressed.
    const locker = poolsFormToPayload(
      validForm({
        imageSource: "locker",
        imageId: "img-1",
        imageUrl: "https://example.test/ignored.png",
      }),
    );
    expect(locker?.image).toEqual({ kind: "locker", imageId: "img-1" });

    const url = poolsFormToPayload(
      validForm({ imageSource: "url", imageId: "img-1", imageUrl: "https://example.test/f.png" }),
    );
    expect(url?.image).toEqual({ kind: "url", url: "https://example.test/f.png" });
  });
});

describe("poolsFormToPayload — what it refuses", () => {
  it.each([
    ["no name", { name: "" }],
    ["no symbol", { symbol: "" }],
    ["no image at all", { imageSource: "url" as const, imageUrl: "" }],
    ["a locker source with nothing selected", { imageSource: "locker" as const, imageId: null }],
    ["a non-https image", { imageUrl: "http://example.test/x.png" }],
    ["a javascript: image", { imageUrl: "javascript:alert(1)" }],
    ["no fee recipient", { feeRecipient: "" }],
    ["a malformed fee recipient", { feeRecipient: "0xnope" }],
    ["a non-numeric prebuy", { prebuy: "some" }],
    ["a non-https website", { websiteUrl: "http://example.test" }],
  ])("refuses %s", (_label, over) => {
    expect(poolsFormToPayload(validForm(over))).toBeNull();
  });

  it("refuses text that cannot be written to token metadata", () => {
    expect(poolsFormToPayload(validForm({ name: 'Flam"ingo' }))).toBeNull();
    expect(poolsFormToPayload(validForm({ name: "Flam\ningo" }))).toBeNull();
  });

  it("refuses a prebuy finer than the paired asset can represent", () => {
    // USDG has six decimals, so a seventh digit is not a rounding detail — it is
    // an amount the user cannot actually send.
    const usdg = { pairedAsset: "usdg" as const, prebuy: "1.0000001" };
    expect(poolsFormToPayload(validForm(usdg))).toBeNull();
    expect(poolsFormToPayload(validForm({ ...usdg, prebuy: "1.000001" }))).not.toBeNull();
    // The same digits are fine against WETH's eighteen.
    expect(
      poolsFormToPayload(validForm({ pairedAsset: "weth", prebuy: "1.0000001" })),
    ).not.toBeNull();
  });
});

describe("normalizePoolsAmount", () => {
  it("treats an empty field as zero and refuses anything not a plain decimal", () => {
    expect(normalizePoolsAmount("", 18)).toBe("0");
    expect(normalizePoolsAmount("  ", 18)).toBe("0");
    expect(normalizePoolsAmount("0.5", 18)).toBe("0.5");
    for (const bad of ["-1", "1e18", "1,5", "abc", "1.2.3"]) {
      expect(normalizePoolsAmount(bad, 18)).toBeNull();
    }
  });

  it("refuses rather than truncates a fraction the asset cannot hold", () => {
    expect(normalizePoolsAmount("1.1234567", 6)).toBeNull();
    expect(normalizePoolsAmount("1.123456", 6)).toBe("1.123456");
  });
});

describe("fee recipient shape", () => {
  it("accepts an address or an X username, with or without the @", () => {
    expect(isAcceptableFeeRecipient(ADDRESS)).toBe(true);
    expect(isAcceptableFeeRecipient("vexdotfun")).toBe(true);
    expect(isAcceptableFeeRecipient("@vexdotfun")).toBe(true);
  });

  it("rejects an empty, malformed or oversized recipient", () => {
    for (const bad of ["", "   ", "@" + "x".repeat(16), "not a name"]) {
      expect(isAcceptableFeeRecipient(bad)).toBe(false);
    }
  });

  it("never re-reads a HALF-TYPED ADDRESS as an X username", () => {
    // `0x123` is six word characters and matches the username shape. Accepting
    // it would turn a truncated address into a lookup for a different
    // recipient entirely, and the fee stream is permanent.
    for (const truncated of [
      "0x123",
      "0xnope",
      "0X123",
      // The `@` must not smuggle it past the guard either.
      "@0x123",
      `${ADDRESS}00`,
      ADDRESS.slice(0, -1),
    ]) {
      expect(isAcceptableFeeRecipient(truncated)).toBe(false);
      expect(feeRecipientNeedsResolution(truncated)).toBe(false);
    }
  });

  it("agrees with the IPC schema, so the form never accepts what the boundary refuses", () => {
    // The schema is the contract and this classification is the UX. A value the
    // form calls acceptable and the boundary rejects would fail at prepare with
    // no field to point at.
    const acceptedHere = ["vex0x", "x0nline", "0vex", "web3guy", "@a1b2c3", ADDRESS];
    for (const value of acceptedHere) expect(isAcceptableFeeRecipient(value)).toBe(true);
  });

  it("knows which recipients main must RESOLVE before Deploy", () => {
    // An address is already final; a username is not, and the form has to make
    // the user confirm what it resolved to.
    expect(feeRecipientNeedsResolution(ADDRESS)).toBe(false);
    expect(feeRecipientNeedsResolution("@vexdotfun")).toBe(true);
  });
});
