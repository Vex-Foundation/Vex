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

  it("returns fieldsWritten in canonical order", async () => {
    const result = await writeApiKeys({
      rettiwtApiKey: "r",
      tavilyApiKey: "t",
      jupiterApiKey: "j",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fieldsWritten).toEqual([
        "JUPITER_API_KEY",
        "TAVILY_API_KEY",
        "RETTIWT_API_KEY",
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
