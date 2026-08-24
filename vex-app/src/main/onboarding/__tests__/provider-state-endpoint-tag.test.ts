/**
 * The provider status the renderer receives carries the ROUTING PIN and
 * NOTHING SECRET.
 *
 * `ProviderState` gained `endpointTag` so the configured screen can show what
 * is actually in effect and prefill its editor. That shape crosses IPC to an
 * untrusted renderer, so the load-bearing assertion here is negative: even
 * with a key in the vault AND a stale plaintext key hand-written into `.env`,
 * nothing derived from key material — value, length, prefix, masked tail —
 * appears anywhere in the probe result.
 *
 * New file: `provider-state.test.ts` owns the provider RESOLUTION rules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, writeFileSync } from "node:fs";
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

const VAULT_KEY = "sk-or-SECRET-vault-value-123456";
const MODEL = "anthropic/claude-sonnet-4.5";

let tmpDir = "";
let envFile = "";

function writeEnv(content: string): void {
  writeFileSync(envFile, content, { mode: 0o600 });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vex-provider-state-"));
  envFile = path.join(tmpDir, ".env");
  sessionMocks.getUnlockedSecretPresence.mockReset();
  sessionMocks.getUnlockedSecretPresence.mockReturnValue({
    vaultConfigured: true,
    unlocked: true,
    secrets: { OPENROUTER_API_KEY: true },
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("probeProvider endpoint pin", () => {
  it("reports the pinned tag when one is persisted", async () => {
    writeEnv(
      [
        `AGENT_MODEL="${MODEL}"`,
        'AGENT_PROVIDER="openrouter"',
        'OPENROUTER_ENDPOINT_TAG="anthropic/2"',
      ].join("\n") + "\n",
    );

    const result = await probeProvider(envFile);

    expect(result.configured).toBe(true);
    expect(result.endpointTag).toBe("anthropic/2");
  });

  it("reports null for Auto routing (no pin persisted)", async () => {
    writeEnv([`AGENT_MODEL="${MODEL}"`, 'AGENT_PROVIDER="openrouter"'].join("\n") + "\n");

    const result = await probeProvider(envFile);

    expect(result.endpointTag).toBeNull();
  });

  it("reports the pin on the fallback (no explicit AGENT_PROVIDER) path", async () => {
    writeEnv(
      [`AGENT_MODEL="${MODEL}"`, 'OPENROUTER_ENDPOINT_TAG="azure"'].join("\n") +
        "\n",
    );

    const result = await probeProvider(envFile);

    expect(result.configured).toBe(true);
    expect(result.endpointTag).toBe("azure");
  });

  it("reports no pin when nothing is configured", async () => {
    sessionMocks.getUnlockedSecretPresence.mockReturnValue({
      vaultConfigured: true,
      unlocked: true,
      secrets: {},
    });
    writeEnv('OPENROUTER_ENDPOINT_TAG="stale-pin"\n');

    const result = await probeProvider(envFile);

    expect(result.configured).toBe(false);
    expect(result.endpointTag).toBeNull();
  });

  it("caps a hand-edited pin at 200 characters", async () => {
    writeEnv(
      [`AGENT_MODEL="${MODEL}"`, `OPENROUTER_ENDPOINT_TAG="${"a".repeat(400)}"`].join(
        "\n",
      ) + "\n",
    );

    const result = await probeProvider(envFile);

    expect(result.endpointTag?.length).toBe(200);
  });
});

describe("provider status never carries key material", () => {
  it("exposes presence only - no value, length, prefix or tail", async () => {
    writeEnv(
      [
        `OPENROUTER_API_KEY="${VAULT_KEY}"`,
        `AGENT_MODEL="${MODEL}"`,
        'AGENT_PROVIDER="openrouter"',
        'OPENROUTER_ENDPOINT_TAG="anthropic/2"',
      ].join("\n") + "\n",
    );

    const result = await probeProvider(envFile);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(VAULT_KEY);
    expect(serialized).not.toContain("sk-or");
    expect(serialized).not.toContain(VAULT_KEY.slice(0, 8));
    expect(serialized).not.toContain(VAULT_KEY.slice(-8));
    expect(serialized).not.toContain(String(VAULT_KEY.length));
    // The full renderer-visible surface, pinned: four non-secret fields.
    expect(Object.keys(result).sort()).toEqual([
      "configured",
      "endpointTag",
      "modelLabel",
      "name",
    ]);
  });
});
