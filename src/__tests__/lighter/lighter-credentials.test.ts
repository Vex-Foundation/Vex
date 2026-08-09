import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes } from "../../errors.js";
import {
  authorizeLighterReadOnlyAuthTokenForAccount,
  getLighterReadOnlyCredentialStatus,
  requireLighterReadOnlyAuthForAccount,
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

  it("defaults account reads to the token subject and enforces single-account scope", () => {
    const token = "ro:42:single:4102444800:abcdef0123456789";

    const defaulted = authorizeLighterReadOnlyAuthTokenForAccount("core", token, undefined, NOW_MS);
    expect(defaulted.accountIndex).toBe(42);
    expect(defaulted.accountIndexSource).toBe("credential");

    const matching = authorizeLighterReadOnlyAuthTokenForAccount("core", token, 42, NOW_MS);
    expect(matching.accountIndex).toBe(42);
    expect(matching.accountIndexSource).toBe("caller");

    expect(() => authorizeLighterReadOnlyAuthTokenForAccount("core", token, 43, NOW_MS)).toThrow(
      expect.objectContaining({
        code: ErrorCodes.LIGHTER_INVALID_REQUEST,
        message: "Lighter read-only auth token for core is scoped to account 42, not account 43.",
      }),
    );
  });

  it("reads scoped account authorization from the configured environment token", () => {
    process.env.LIGHTER_RHC_READ_ONLY_AUTH_TOKEN = "ro:7:single:4102444800:abcdef0123456789";

    const auth = requireLighterReadOnlyAuthForAccount("rhc", undefined, NOW_MS);

    expect(auth.accountIndex).toBe(7);
    expect(auth.metadata.scope).toBe("single");
    expect(JSON.stringify(auth.metadata)).not.toContain("abcdef0123456789");
  });
});
