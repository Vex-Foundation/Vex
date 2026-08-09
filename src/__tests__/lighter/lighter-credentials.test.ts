import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes } from "../../errors.js";
import {
  getLighterReadOnlyCredentialStatus,
  requireLighterReadOnlyAuthToken,
} from "@tools/lighter/credentials.js";

const NOW_MS = Date.UTC(2026, 7, 9, 12, 0, 0);

afterEach(() => {
  delete process.env.LIGHTER_CORE_READ_ONLY_AUTH_TOKEN;
  delete process.env.LIGHTER_RHC_READ_ONLY_AUTH_TOKEN;
});

describe("Lighter read-only credential status", () => {
  it("reports missing credentials without token material", () => {
    const status = getLighterReadOnlyCredentialStatus("core", NOW_MS);
    expect(status).toEqual({
      environment: "core",
      envKey: "LIGHTER_CORE_READ_ONLY_AUTH_TOKEN",
      configured: false,
      capability: "read_only_account_data",
      metadata: null,
    });
  });

  it("reports metadata for configured credentials without returning token material", () => {
    const token = "ro:42:all:4102444800:abcdef0123456789";
    process.env.LIGHTER_RHC_READ_ONLY_AUTH_TOKEN = token;

    const status = getLighterReadOnlyCredentialStatus("rhc", NOW_MS);
    expect(status.configured).toBe(true);
    expect(status.metadata).toEqual(expect.objectContaining({
      environment: "rhc",
      accountIndex: 42,
      scope: "all",
      expired: false,
    }));
    expect(JSON.stringify(status)).not.toContain(token);
    expect(JSON.stringify(status)).not.toContain("abcdef0123456789");
  });

  it("fails closed when a credential is missing or expired", () => {
    expect(() => requireLighterReadOnlyAuthToken("core", NOW_MS)).toThrow(
      expect.objectContaining({
        code: ErrorCodes.LIGHTER_INVALID_REQUEST,
        message: "Missing Lighter read-only auth token for core.",
      }),
    );

    process.env.LIGHTER_CORE_READ_ONLY_AUTH_TOKEN = "ro:42:single:1786276799:abcdef";
    expect(() => requireLighterReadOnlyAuthToken("core", NOW_MS)).toThrow(
      expect.objectContaining({
        code: ErrorCodes.LIGHTER_INVALID_REQUEST,
        message: "Expired Lighter read-only auth token for core.",
      }),
    );
  });
});
