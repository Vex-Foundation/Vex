/**
 * Vex Cloud as the selected provider: what the writer puts on disk and what
 * the state probe reports.
 *
 * Pinned:
 *  - the writer writes only `AGENT_MODEL` and `AGENT_PROVIDER=vexcloud`,
 *    touches no vault secret (the credential is the session sign-in stored),
 *    and leaves the OpenRouter endpoint pin in place for a switch back;
 *  - the probe reports Vex Cloud configured exactly when a session AND a
 *    model exist, and never reports an OpenRouter pin under Vex Cloud.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const sessionMocks = vi.hoisted(() => ({
  writeUnlockedSecrets: vi.fn(),
  getUnlockedSecretPresence: vi.fn(),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../secrets/session.js", () => ({
  writeUnlockedSecrets: sessionMocks.writeUnlockedSecrets,
  getUnlockedSecretPresence: sessionMocks.getUnlockedSecretPresence,
}));

const { writeProvider } = await import("../provider-writer.js");
const { probeProvider } = await import("../provider-state.js");
const { readDotenvFileValue } = await import("@vex-lib/dotenv.js");

let tmpDir = "";
let envFile = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vex-provider-vexcloud-"));
  envFile = path.join(tmpDir, ".env");
  sessionMocks.writeUnlockedSecrets.mockReset();
  sessionMocks.getUnlockedSecretPresence.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("writeProvider for Vex Cloud", () => {
  it("writes the model and the provider, no secret, and keeps the OpenRouter pin", async () => {
    writeFileSync(envFile, "AGENT_PROVIDER=openrouter\nAGENT_MODEL=old/model\nOPENROUTER_ENDPOINT_TAG=anthropic/2\n", { mode: 0o600 });

    const result = await writeProvider({ provider: "vexcloud", model: "anthropic/claude-haiku-5.5" }, { envFile });

    expect(result).toEqual({ ok: true, data: { fieldsWritten: ["AGENT_MODEL", "AGENT_PROVIDER"] } });
    expect(readDotenvFileValue("AGENT_PROVIDER", envFile)).toBe("vexcloud");
    expect(readDotenvFileValue("AGENT_MODEL", envFile)).toBe("anthropic/claude-haiku-5.5");
    expect(readDotenvFileValue("OPENROUTER_ENDPOINT_TAG", envFile)).toBe("anthropic/2");
    expect(sessionMocks.writeUnlockedSecrets).not.toHaveBeenCalled();
  });
});

describe("probeProvider under Vex Cloud", () => {
  it.each([
    ["a session and a model", { VEX_CLOUD_SESSION_TOKEN: true }, true],
    ["no session", {}, false],
    ["only an OpenRouter key", { OPENROUTER_API_KEY: true }, false],
  ])("%s -> configured %s", async (_name, secrets, configured) => {
    writeFileSync(envFile, "AGENT_PROVIDER=vexcloud\nAGENT_MODEL=anthropic/claude-haiku-5.5\nOPENROUTER_ENDPOINT_TAG=anthropic/2\n", { mode: 0o600 });
    sessionMocks.getUnlockedSecretPresence.mockReturnValue({ vaultConfigured: true, unlocked: true, secrets });

    await expect(probeProvider(envFile)).resolves.toEqual({
      configured,
      name: "vexcloud",
      modelLabel: "anthropic/claude-haiku-5.5",
      endpointTag: null,
    });
  });
});
