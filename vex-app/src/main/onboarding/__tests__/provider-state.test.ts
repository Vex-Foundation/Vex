import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const sessionMocks = vi.hoisted(() => ({
  getUnlockedSecretPresence: vi.fn(),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../secrets/session.js", () => ({
  getUnlockedSecretPresence: sessionMocks.getUnlockedSecretPresence,
}));

const { probeProvider } = await import("../provider-state.js");

let tmpDir = "";
let envFile = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vex-provider-state-"));
  envFile = path.join(tmpDir, ".env");
  sessionMocks.getUnlockedSecretPresence.mockReset();
  sessionMocks.getUnlockedSecretPresence.mockReturnValue({
    vaultConfigured: true,
    unlocked: true,
    secrets: {},
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function writeEnv(content: string): void {
  writeFileSync(envFile, content, { mode: 0o600 });
}

function withOpenRouterKey(): void {
  sessionMocks.getUnlockedSecretPresence.mockReturnValue({
    vaultConfigured: true,
    unlocked: true,
    secrets: { OPENROUTER_API_KEY: true },
  });
}

describe("probeProvider", () => {
  it("returns name:null when env file is missing", async () => {
    const result = await probeProvider(envFile);
    expect(result).toEqual({
      configured: false,
      name: null,
      modelLabel: null,
      endpointTag: null,
    });
  });

  it("configures explicit OpenRouter when key is in vault and model is in env", async () => {
    withOpenRouterKey();
    writeEnv(
      [
        'AGENT_MODEL="anthropic/claude-sonnet-4.5"',
        'AGENT_PROVIDER="openrouter"',
      ].join("\n") + "\n",
    );

    const result = await probeProvider(envFile);

    expect(result.configured).toBe(true);
    expect(result.name).toBe("openrouter");
    expect(result.modelLabel).toBe("anthropic/claude-sonnet-4.5");
  });

  it("does not configure explicit OpenRouter when model is missing", async () => {
    withOpenRouterKey();
    writeEnv('AGENT_PROVIDER="openrouter"\n');

    const result = await probeProvider(envFile);

    expect(result.configured).toBe(false);
    expect(result.name).toBe("openrouter");
    expect(result.modelLabel).toBe(null);
  });

  it("fails closed on an unsupported explicit provider", async () => {
    withOpenRouterKey();
    writeEnv(
      [
        'AGENT_MODEL="anthropic/claude-sonnet-4.5"',
        'AGENT_PROVIDER="bogus-provider"',
      ].join("\n") + "\n",
    );

    const result = await probeProvider(envFile);

    expect(result.configured).toBe(false);
    expect(result.name).toBe(null);
    expect(result.modelLabel).toBe(null);
  });

  it("falls back to OpenRouter when key is in vault and model is in env", async () => {
    withOpenRouterKey();
    writeEnv('AGENT_MODEL="anthropic/claude-sonnet-4.5"\n');

    const result = await probeProvider(envFile);

    expect(result.configured).toBe(true);
    expect(result.name).toBe("openrouter");
    expect(result.modelLabel).toBe("anthropic/claude-sonnet-4.5");
  });

  it("does not treat a plaintext env key as configured", async () => {
    writeEnv(
      [
        'OPENROUTER_API_KEY="legacy-plaintext"',
        'AGENT_MODEL="anthropic/claude-sonnet-4.5"',
      ].join("\n") + "\n",
    );

    const result = await probeProvider(envFile);

    expect(result.configured).toBe(false);
    expect(result.name).toBe(null);
  });

  it("truncates long model labels", async () => {
    withOpenRouterKey();
    const longModel = "x".repeat(300);
    writeEnv(`AGENT_MODEL="${longModel}"\n`);

    const result = await probeProvider(envFile);

    expect(result.configured).toBe(true);
    expect(result.modelLabel?.length).toBe(200);
  });
});
