import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  writeUnlockedSecrets: vi.fn(),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../secrets/session.js", () => ({
  writeUnlockedSecrets: sessionMocks.writeUnlockedSecrets,
}));

const { writeApiKeys } = await import("../api-keys-writer.js");

describe("writeApiKeys", () => {
  beforeEach(() => {
    sessionMocks.writeUnlockedSecrets.mockReset();
    sessionMocks.writeUnlockedSecrets.mockReturnValue({ ok: true, data: undefined });
  });

  it("returns empty fieldsWritten when nothing is submitted", async () => {
    const result = await writeApiKeys({});
    expect(result).toEqual({ ok: true, data: { fieldsWritten: [] } });
    expect(sessionMocks.writeUnlockedSecrets).not.toHaveBeenCalled();
  });

  it("stores JUPITER_API_KEY in the encrypted vault", async () => {
    const result = await writeApiKeys({ jupiterApiKey: "sk-jup-xyz" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.fieldsWritten).toEqual(["JUPITER_API_KEY"]);
    expect(sessionMocks.writeUnlockedSecrets).toHaveBeenCalledWith({
      JUPITER_API_KEY: "sk-jup-xyz",
    });
  });

  it("stores Lighter read-only tokens in the encrypted vault", async () => {
    const result = await writeApiKeys({
      lighterCoreReadOnlyToken: "ro:1:single:2000000000:abcdef",
      lighterRhcReadOnlyToken: "ro:1:all:2000000000:123456",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fieldsWritten).toEqual([
        "LIGHTER_CORE_READ_ONLY_AUTH_TOKEN",
        "LIGHTER_RHC_READ_ONLY_AUTH_TOKEN",
      ]);
    }
    expect(sessionMocks.writeUnlockedSecrets).toHaveBeenCalledWith({
      LIGHTER_CORE_READ_ONLY_AUTH_TOKEN: "ro:1:single:2000000000:abcdef",
      LIGHTER_RHC_READ_ONLY_AUTH_TOKEN: "ro:1:all:2000000000:123456",
    });
  });

  it("rejects malformed Lighter credentials before writing", async () => {
    const result = await writeApiKeys({
      lighterRhcReadOnlyToken: "not-a-read-only-token",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("provider.invalid_api_key");
      expect(result.error.message).not.toContain("not-a-read-only-token");
    }
    expect(sessionMocks.writeUnlockedSecrets).not.toHaveBeenCalled();
  });

  it("returns fieldsWritten in canonical order", async () => {
    const result = await writeApiKeys({
      rettiwtApiKey: "r",
      tavilyApiKey: "t",
      jupiterApiKey: "j",
      lighterRhcReadOnlyToken: "ro:1:single:2000000000:abcdef",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fieldsWritten).toEqual([
        "JUPITER_API_KEY",
        "TAVILY_API_KEY",
        "RETTIWT_API_KEY",
        "LIGHTER_RHC_READ_ONLY_AUTH_TOKEN",
      ]);
    }
  });

  it("returns the locked-vault error from the secret session", async () => {
    sessionMocks.writeUnlockedSecrets.mockReturnValue({
      ok: false,
      error: {
        code: "wallet.keystore_locked",
        domain: "wallet",
        message: "Unlock Vex first.",
        retryable: false,
        userActionable: true,
        redacted: true,
      },
    });

    const result = await writeApiKeys({ jupiterApiKey: "j" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("wallet.keystore_locked");
  });
});
