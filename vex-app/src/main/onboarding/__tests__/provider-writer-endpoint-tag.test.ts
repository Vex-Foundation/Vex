/**
 * `.env` lifecycle of the optional endpoint pin.
 *
 * The load-bearing case is RECONFIGURATION: "Auto" must erase a previous pin
 * from BOTH the file and `process.env`. A file-only delete would leave the old
 * tag resident in the process, and `loadProviderDotenv` — which only SETS keys
 * the file contains — would never clear it, so the agent would keep routing to
 * an endpoint the operator just unpinned.
 *
 * Separate file from `provider-writer.test.ts`, which owns the vault/secret
 * behaviour and is already sizeable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const sessionMocks = vi.hoisted(() => ({ writeUnlockedSecrets: vi.fn() }));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../secrets/session.js", () => ({
  writeUnlockedSecrets: sessionMocks.writeUnlockedSecrets,
}));

const { writeProvider } = await import("../provider-writer.js");
const { readDotenvFileValue, loadDotenvFileIntoProcess } = await import(
  "@vex-lib/dotenv.js"
);

const TAG_KEY = "OPENROUTER_ENDPOINT_TAG";
const base = {
  provider: "openrouter" as const,
  apiKey: "sk-or-test-123",
  model: "anthropic/claude-sonnet-4.5",
};

let tmpDir = "";
let envFile = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vex-endpoint-tag-"));
  envFile = path.join(tmpDir, ".env");
  delete process.env[TAG_KEY];
  sessionMocks.writeUnlockedSecrets.mockReset();
  sessionMocks.writeUnlockedSecrets.mockReturnValue({ ok: true, data: undefined });
});

afterEach(async () => {
  delete process.env[TAG_KEY];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("endpoint pin persistence", () => {
  it("writes the tag and reports it in fieldsWritten", async () => {
    const result = await writeProvider(
      { ...base, endpointTag: "google-vertex/global" },
      { envFile },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fieldsWritten).toEqual([
        "OPENROUTER_API_KEY",
        "AGENT_MODEL",
        "AGENT_PROVIDER",
        TAG_KEY,
      ]);
    }
    expect(readDotenvFileValue(TAG_KEY, envFile)).toBe("google-vertex/global");
  });

  it("omits the key entirely on Auto and does not claim it was written", async () => {
    const result = await writeProvider(base, { envFile });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fieldsWritten).not.toContain(TAG_KEY);
    }
    expect(readDotenvFileValue(TAG_KEY, envFile)).toBeNull();
  });

  it("erases a previous pin from the file AND process.env when switching to Auto", async () => {
    await writeProvider({ ...base, endpointTag: "anthropic/2" }, { envFile });
    loadDotenvFileIntoProcess(envFile, { overwrite: true });
    expect(process.env[TAG_KEY]).toBe("anthropic/2");

    await writeProvider(base, { envFile });

    expect(readDotenvFileValue(TAG_KEY, envFile)).toBeNull();
    expect(process.env[TAG_KEY]).toBeUndefined();

    // The reload the IPC handler performs next must not resurrect it.
    loadDotenvFileIntoProcess(envFile, { overwrite: true });
    expect(process.env[TAG_KEY]).toBeUndefined();
  });

  it("replaces a previous pin rather than leaving both lines behind", async () => {
    await writeProvider({ ...base, endpointTag: "anthropic" }, { envFile });
    await writeProvider({ ...base, endpointTag: "azure/us-east-2" }, { envFile });

    const content = await fs.readFile(envFile, "utf-8");
    expect(content.match(new RegExp(`^${TAG_KEY}=`, "gm"))).toHaveLength(1);
    expect(readDotenvFileValue(TAG_KEY, envFile)).toBe("azure/us-east-2");
  });

  it("treats a whitespace-only tag as Auto", async () => {
    process.env[TAG_KEY] = "stale";
    await writeProvider({ ...base, endpointTag: "   " }, { envFile });
    expect(readDotenvFileValue(TAG_KEY, envFile)).toBeNull();
    expect(process.env[TAG_KEY]).toBeUndefined();
  });
});
