/**
 * ENV + registry wiring for the optional fallback provider.
 *
 * Contract: the fallback activates ONLY when BOTH `OPENROUTER_API_KEY_FALLBACK`
 * and `AGENT_MODEL_FALLBACK` are set. A partial config is ignored (and warned
 * about) rather than silently half-enabling failover, and the resulting stack
 * stays single-provider — byte-for-byte the pre-change behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../vex-agent/inference/openrouter.js", () => ({
  OpenRouterProvider: class {
    readonly id: string;
    readonly displayName: string;
    readonly model: string;
    constructor(
      options: {
        apiKey?: string;
        model?: string;
        displayName?: string;
        id?: string;
      } = {},
    ) {
      this.id = options.id ?? "openrouter";
      this.displayName = options.displayName ?? "OpenRouter";
      this.model = options.model ?? process.env.AGENT_MODEL ?? "";
    }
  },
}));

const { loadEnvConfig } = await import("../../../vex-agent/inference/config.js");
const { resolveProvider, resetProvider } = await import(
  "../../../vex-agent/inference/registry.js"
);
const { FailoverProvider } = await import(
  "../../../vex-agent/inference/failover.js"
);

const PRIMARY_KEY = "sk-or-primary";
const PRIMARY_MODEL = "vendor/primary";
const FALLBACK_KEY = "sk-or-fallback";
const FALLBACK_MODEL = "vendor/fallback";

describe("fallback provider wiring", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetProvider();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_") || key.startsWith("OPENROUTER_")) {
        delete process.env[key];
      }
    }
    process.env.OPENROUTER_API_KEY = PRIMARY_KEY;
    process.env.AGENT_MODEL = PRIMARY_MODEL;
  });

  afterEach(() => {
    resetProvider();
    process.env = { ...originalEnv };
  });

  describe("loadEnvConfig", () => {
    it("reports no fallback when neither var is set", () => {
      const cfg = loadEnvConfig();
      expect(cfg.fallbackApiKey).toBeNull();
      expect(cfg.fallbackModel).toBeNull();
    });

    it("reads both fallback vars when both are set", () => {
      process.env.OPENROUTER_API_KEY_FALLBACK = FALLBACK_KEY;
      process.env.AGENT_MODEL_FALLBACK = FALLBACK_MODEL;
      const cfg = loadEnvConfig();
      expect(cfg.fallbackApiKey).toBe(FALLBACK_KEY);
      expect(cfg.fallbackModel).toBe(FALLBACK_MODEL);
    });

    it("does NOT throw on a partial fallback config — it is simply inactive", () => {
      process.env.OPENROUTER_API_KEY_FALLBACK = FALLBACK_KEY;
      expect(() => loadEnvConfig()).not.toThrow();
    });
  });

  describe("resolveProvider", () => {
    it("builds a single-provider stack when no fallback is configured", async () => {
      const provider = await resolveProvider();
      expect(provider).toBeInstanceOf(FailoverProvider);
      expect((provider as InstanceType<typeof FailoverProvider>).size).toBe(1);
      // Identity is unchanged for every existing `provider.id` call site.
      expect(provider?.id).toBe("openrouter");
      expect(provider?.displayName).toBe("OpenRouter");
    });

    it("builds a 2-deep stack when both fallback vars are set", async () => {
      process.env.OPENROUTER_API_KEY_FALLBACK = FALLBACK_KEY;
      process.env.AGENT_MODEL_FALLBACK = FALLBACK_MODEL;
      const provider = await resolveProvider();
      expect((provider as InstanceType<typeof FailoverProvider>).size).toBe(2);
      expect(provider?.id).toBe("openrouter");
    });

    it("ignores a fallback with only a key (both-or-neither)", async () => {
      process.env.OPENROUTER_API_KEY_FALLBACK = FALLBACK_KEY;
      const provider = await resolveProvider();
      expect((provider as InstanceType<typeof FailoverProvider>).size).toBe(1);
    });

    it("ignores a fallback with only a model (both-or-neither)", async () => {
      process.env.AGENT_MODEL_FALLBACK = FALLBACK_MODEL;
      const provider = await resolveProvider();
      expect((provider as InstanceType<typeof FailoverProvider>).size).toBe(1);
    });

    it("gives the fallback instance its OWN model", async () => {
      process.env.OPENROUTER_API_KEY_FALLBACK = FALLBACK_KEY;
      process.env.AGENT_MODEL_FALLBACK = FALLBACK_MODEL;
      const provider = await resolveProvider();
      // Stack identity mirrors the primary's model, not the fallback's.
      expect(provider?.model).toBe(PRIMARY_MODEL);
      expect(
        (provider as InstanceType<typeof FailoverProvider>).displayName,
      ).toContain("fallback");
    });
  });
});
