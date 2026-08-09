import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../errors.js";
import { parseLighterReadOnlyAuthToken } from "@tools/lighter/auth-token.js";

const NOW_MS = Date.UTC(2026, 7, 9, 12, 0, 0);

describe("Lighter read-only auth token metadata parser", () => {
  it("parses metadata without returning token material", () => {
    const metadata = parseLighterReadOnlyAuthToken(
      "core",
      "ro:42:all:4102444800:abcdef0123456789",
      NOW_MS,
    );

    expect(metadata).toEqual({
      environment: "core",
      accountIndex: 42,
      scope: "all",
      expiryUnixSeconds: 4102444800,
      expiresAt: "2100-01-01T00:00:00.000Z",
      expired: false,
      expiresSoon: false,
    });
    expect(JSON.stringify(metadata)).not.toContain("abcdef");
  });

  it("marks expired and soon-expiring tokens", () => {
    const expired = parseLighterReadOnlyAuthToken(
      "rhc",
      "ro:7:single:1786276799:abc123",
      NOW_MS,
    );
    expect(expired.expired).toBe(true);
    expect(expired.expiresSoon).toBe(false);

    const soon = parseLighterReadOnlyAuthToken(
      "rhc",
      "ro:7:single:1786363200:abc123",
      NOW_MS,
    );
    expect(soon.expired).toBe(false);
    expect(soon.expiresSoon).toBe(true);
  });

  it("rejects non-read-only token formats", () => {
    for (const token of [
      "4102444800:42:2:abcdef",
      "sk-lighter-private",
      "ro:42:trade:4102444800:abcdef",
      "ro:42:all:4102444800:not-hex",
    ]) {
      expect(() => parseLighterReadOnlyAuthToken("core", token, NOW_MS)).toThrow(
        expect.objectContaining({
          code: ErrorCodes.LIGHTER_INVALID_REQUEST,
        }),
      );
    }
  });
});
