import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const sessionMocks = vi.hoisted(() => ({
  writeUnlockedSecrets: vi.fn(),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../secrets/session.js", () => ({
  writeUnlockedSecrets: sessionMocks.writeUnlockedSecrets,
}));

const { writeProvider } = await import("../provider-writer.js");
const { readDotenvFileValue } = await import("@vex-lib/dotenv.js");

let tmpDir = "";
let envFile = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vex-provider-"));
  envFile = path.join(tmpDir, ".env");
  sessionMocks.writeUnlockedSecrets.mockReset();
  sessionMocks.writeUnlockedSecrets.mockReturnValue({ ok: true, data: undefined });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("writeProvider", () => {
  it("stores the OpenRouter key in the vault and writes non-secret provider config", async () => {
    const result = await writeProvider(
      {
        provider: "openrouter",
        apiKey: "sk-or-test-123",
        model: "anthropic/claude-sonnet-4.5",
      },
      { envFile },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fieldsWritten).toEqual([
        "OPENROUTER_API_KEY",
        "AGENT_MODEL",
        "AGENT_PROVIDER",
      ]);
    }
    expect(sessionMocks.writeUnlockedSecrets).toHaveBeenCalledWith({
      OPENROUTER_API_KEY: "sk-or-test-123",
    });
    expect(readDotenvFileValue("OPENROUTER_API_KEY", envFile)).toBeNull();
    expect(readDotenvFileValue("AGENT_MODEL", envFile)).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(readDotenvFileValue("AGENT_PROVIDER", envFile)).toBe("openrouter");
  });

  it("strips stale plaintext OpenRouter keys while preserving unrelated non-secret values", async () => {
    writeFileSync(
      envFile,
      [
        'OPENROUTER_API_KEY="legacy-plaintext"',
        'AGENT_PROVIDER="unsupported-provider"',
        'OTHER_KEY="keep-me"',
      ].join("\n") + "\n",
    );

    const result = await writeProvider(
      {
        provider: "openrouter",
        apiKey: "sk-or-test",
        model: "new-model",
      },
      { envFile },
    );

    expect(result.ok).toBe(true);
    expect(readDotenvFileValue("OPENROUTER_API_KEY", envFile)).toBeNull();
    expect(readDotenvFileValue("AGENT_PROVIDER", envFile)).toBe("openrouter");
    expect(readDotenvFileValue("AGENT_MODEL", envFile)).toBe("new-model");
    expect(readDotenvFileValue("OTHER_KEY", envFile)).toBe("keep-me");
    expect(readFileSync(envFile, "utf8")).not.toContain("legacy-plaintext");
  });

  it("strips duplicate provider lines before writing canonical non-secret config", async () => {
    writeFileSync(
      envFile,
      [
        'AGENT_PROVIDER="unsupported-provider"',
        'AGENT_PROVIDER="openrouter"',
        'AGENT_MODEL="stale-model"',
      ].join("\n") + "\n",
    );

    const result = await writeProvider(
      { provider: "openrouter", apiKey: "sk-or-test", model: "new-model" },
      { envFile },
    );

    expect(result.ok).toBe(true);
    const content = readFileSync(envFile, "utf-8");
    expect(content.match(/^AGENT_PROVIDER=/gm)?.length).toBe(1);
    expect(content.match(/^AGENT_MODEL=/gm)?.length).toBe(1);
    expect(readDotenvFileValue("AGENT_MODEL", envFile)).toBe("new-model");
  });

  /**
   * POSIX mode bits are kernel-enforced on macOS and Linux. On Windows libuv
   * maps `mode` onto the read-only attribute alone, so the group/other bits
   * this asserts have no NTFS representation and the check measures nothing
   * there - see the per-platform note in `compose/electron-secret-adapter.ts`.
   *
   * `it.skipIf` rather than a bare early `return`: a skipped test is visible
   * in the reporter, while an early return reports as PASSING on the one
   * platform where it proved nothing.
   */
  it.skipIf(process.platform === "win32")(
    "writes the non-secret env file with mode 0o600",
    async () => {
      await writeProvider(
        { provider: "openrouter", apiKey: "sk-or-test", model: "x" },
        { envFile },
      );
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
    },
  );

  it("returns the locked-vault error before writing non-secret config", async () => {
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

    const result = await writeProvider(
      { provider: "openrouter", apiKey: "sk-or-test", model: "x" },
      { envFile },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("wallet.keystore_locked");
    await expect(fs.access(envFile)).rejects.toThrow();
  });

  it("returns onboarding.env_persist_failed when the non-secret env write fails", async () => {
    const blockingFile = path.join(tmpDir, "blocker");
    writeFileSync(blockingFile, "x");

    const result = await writeProvider(
      { provider: "openrouter", apiKey: "sk-or-test", model: "x" },
      { envFile: path.join(blockingFile, ".env") },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("onboarding.env_persist_failed");
      expect(result.error.domain).toBe("onboarding");
      expect((result.error.details as { verified?: boolean }).verified).toBe(true);
    }
  });
});
