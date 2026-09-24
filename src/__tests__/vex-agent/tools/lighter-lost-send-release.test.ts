import { describe, expect, it } from "vitest";
import {
  LIGHTER_SIGNED_TX_MAX_EXPIRY_LEAD_MS,
  readLighterSignedTxExpiredAtMs,
} from "@tools/lighter/signed-tx-expiry.js";
import {
  LIGHTER_LOST_SEND_RELEASE_GRACE_MS,
  lighterLostSendReleaseAtMs,
} from "@vex-agent/tools/protocols/lighter/lost-send-release.js";

const SIGNED_AT = Date.parse("2030-01-01T00:00:00.000Z");

describe("readLighterSignedTxExpiredAtMs", () => {
  it("reads the SDK-filled expiry from a create-order's signed info", () => {
    const info = `{"AccountIndex":42,"MarketIndex":0,"OrderExpiry":0,"ExpiredAt":${SIGNED_AT + 599_000},"Nonce":3,"Sig":"x"}`;
    expect(readLighterSignedTxExpiredAtMs(info, SIGNED_AT)).toBe(SIGNED_AT + 599_000);
  });

  it("does not mistake a child OrderExpiry for the transaction expiry", () => {
    const info = `{"Orders":[{"OrderExpiry":${SIGNED_AT + 86_400_000}}],"ExpiredAt":${SIGNED_AT + 1_000}}`;
    expect(readLighterSignedTxExpiredAtMs(info, SIGNED_AT)).toBe(SIGNED_AT + 1_000);
  });

  it("returns null when the info carries no ExpiredAt at all", () => {
    expect(readLighterSignedTxExpiredAtMs(`{"signed":"payload"}`, SIGNED_AT)).toBeNull();
    expect(readLighterSignedTxExpiredAtMs("signed-close", SIGNED_AT)).toBeNull();
  });

  it.each([
    [`{"ExpiredAt":1,"ExpiredAt":2}`, "duplicated"],
    [`{"ExpiredAt":"123"}`, "quoted"],
    [`{"ExpiredAt":-5}`, "negative"],
    [`{"ExpiredAt":1.5}`, "fractional"],
    [`{"ExpiredAt":0}`, "zero"],
  ])("refuses %s (%s) rather than guessing", (info) => {
    expect(() => readLighterSignedTxExpiredAtMs(info, SIGNED_AT)).toThrow(/exactly one integer ExpiredAt/);
  });

  it("refuses an expiry beyond the SDK's default window, since every release bound rests on it", () => {
    const edge = SIGNED_AT + LIGHTER_SIGNED_TX_MAX_EXPIRY_LEAD_MS;
    expect(readLighterSignedTxExpiredAtMs(`{"ExpiredAt":${edge}}`, SIGNED_AT)).toBe(edge);
    expect(() => readLighterSignedTxExpiredAtMs(`{"ExpiredAt":${edge + 1}}`, SIGNED_AT))
      .toThrow(/beyond the signer's default window/);
  });
});

describe("lighterLostSendReleaseAtMs", () => {
  const consent = "2030-01-01T00:02:00.000Z";

  it("uses the recorded signed expiry plus the grace", () => {
    expect(lighterLostSendReleaseAtMs({ signerExpiryMs: SIGNED_AT, expiresAt: consent }))
      .toBe(SIGNED_AT + LIGHTER_LOST_SEND_RELEASE_GRACE_MS);
  });

  it("bounds a row signed before its expiry was recorded by consent expiry plus the SDK window", () => {
    expect(lighterLostSendReleaseAtMs({ signerExpiryMs: null, expiresAt: consent }))
      .toBe(Date.parse(consent) + LIGHTER_SIGNED_TX_MAX_EXPIRY_LEAD_MS + LIGHTER_LOST_SEND_RELEASE_GRACE_MS);
    expect(lighterLostSendReleaseAtMs({ expiresAt: new Date(consent) }))
      .toBe(Date.parse(consent) + LIGHTER_SIGNED_TX_MAX_EXPIRY_LEAD_MS + LIGHTER_LOST_SEND_RELEASE_GRACE_MS);
  });

  it("returns null, releasing nothing, when neither bound is usable", () => {
    expect(lighterLostSendReleaseAtMs({ signerExpiryMs: null, expiresAt: "not-a-date" })).toBeNull();
    expect(lighterLostSendReleaseAtMs({ signerExpiryMs: Number.NaN, expiresAt: consent })).toBeNull();
  });
});
