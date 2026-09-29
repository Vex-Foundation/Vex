import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadEnvConfig } from "../../../vex-agent/inference/config.js";

describe("loadEnvConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all AGENT_* and OPENROUTER_* vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_") || key.startsWith("OPENROUTER_")) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── Provider validation ──────────────────────────────────────────

  it("returns null agentProvider when AGENT_PROVIDER not set", () => {
    const config = loadEnvConfig();
    expect(config.agentProvider).toBeNull();
  });

  it("parses valid AGENT_PROVIDER=openrouter", () => {
    process.env.AGENT_PROVIDER = "openrouter";
    const config = loadEnvConfig();
    expect(config.agentProvider).toBe("openrouter");
  });

  it("is case-insensitive for AGENT_PROVIDER", () => {
    process.env.AGENT_PROVIDER = "OpenRouter";
    const config = loadEnvConfig();
    expect(config.agentProvider).toBe("openrouter");
  });

  it("throws on invalid AGENT_PROVIDER", () => {
    process.env.AGENT_PROVIDER = "local-provider";
    expect(() => loadEnvConfig()).toThrow("AGENT_PROVIDER");
  });

  // ── Context limit ────────────────────────────────────────────────

  it("uses fallback context limit when not set", () => {
    const config = loadEnvConfig();
    expect(config.contextLimit).toBe(256_000);
  });

  it("parses valid AGENT_CONTEXT_LIMIT", () => {
    process.env.AGENT_CONTEXT_LIMIT = "64000";
    const config = loadEnvConfig();
    expect(config.contextLimit).toBe(64_000);
  });

  it("throws on context limit below 1000", () => {
    process.env.AGENT_CONTEXT_LIMIT = "500";
    expect(() => loadEnvConfig()).toThrow("AGENT_CONTEXT_LIMIT");
  });

  it("throws on context limit above 2000000", () => {
    process.env.AGENT_CONTEXT_LIMIT = "3000000";
    expect(() => loadEnvConfig()).toThrow("AGENT_CONTEXT_LIMIT");
  });

  it("throws on non-numeric context limit", () => {
    process.env.AGENT_CONTEXT_LIMIT = "big";
    expect(() => loadEnvConfig()).toThrow("AGENT_CONTEXT_LIMIT");
  });

  // ── Temperature ──────────────────────────────────────────────────

  it("returns null temperature when not set", () => {
    const config = loadEnvConfig();
    expect(config.temperature).toBeNull();
  });

  it("parses valid AGENT_TEMPERATURE", () => {
    process.env.AGENT_TEMPERATURE = "0.7";
    const config = loadEnvConfig();
    expect(config.temperature).toBe(0.7);
  });

  it("accepts temperature 0", () => {
    process.env.AGENT_TEMPERATURE = "0";
    const config = loadEnvConfig();
    expect(config.temperature).toBe(0);
  });

  it("accepts temperature 2.0", () => {
    process.env.AGENT_TEMPERATURE = "2.0";
    const config = loadEnvConfig();
    expect(config.temperature).toBe(2.0);
  });

  it("throws on temperature above 2", () => {
    process.env.AGENT_TEMPERATURE = "2.5";
    expect(() => loadEnvConfig()).toThrow("AGENT_TEMPERATURE");
  });

  it("throws on negative temperature", () => {
    process.env.AGENT_TEMPERATURE = "-0.1";
    expect(() => loadEnvConfig()).toThrow("AGENT_TEMPERATURE");
  });

  // ── Max output tokens ────────────────────────────────────────────

  it("uses fallback max output tokens when not set", () => {
    const config = loadEnvConfig();
    expect(config.maxOutputTokens).toBe(16384);
  });

  it("parses valid AGENT_MAX_OUTPUT_TOKENS", () => {
    process.env.AGENT_MAX_OUTPUT_TOKENS = "8192";
    const config = loadEnvConfig();
    expect(config.maxOutputTokens).toBe(8192);
  });

  it("throws on max output tokens below 256", () => {
    process.env.AGENT_MAX_OUTPUT_TOKENS = "100";
    expect(() => loadEnvConfig()).toThrow("AGENT_MAX_OUTPUT_TOKENS");
  });

  // ── API key and model ────────────────────────────────────────────

  it("returns null openrouterApiKey when not set", () => {
    const config = loadEnvConfig();
    expect(config.openrouterApiKey).toBeNull();
  });

  it("parses OPENROUTER_API_KEY", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test-123";
    const config = loadEnvConfig();
    expect(config.openrouterApiKey).toBe("sk-or-test-123");
  });

  it("returns null agentModel when not set", () => {
    const config = loadEnvConfig();
    expect(config.agentModel).toBeNull();
  });

  it("parses AGENT_MODEL", () => {
    process.env.AGENT_MODEL = "anthropic/claude-sonnet-4";
    const config = loadEnvConfig();
    expect(config.agentModel).toBe("anthropic/claude-sonnet-4");
  });

  // ── Multiple errors ──────────────────────────────────────────────

  it("throws with all validation errors combined", () => {
    process.env.AGENT_PROVIDER = "invalid";
    process.env.AGENT_CONTEXT_LIMIT = "abc";
    process.env.AGENT_TEMPERATURE = "-5";

    expect(() => loadEnvConfig()).toThrow(/AGENT_PROVIDER.*AGENT_CONTEXT_LIMIT.*AGENT_TEMPERATURE/s);
  });

  // ── Kairos stream bounds (Phase 2B) ──────────────────────────────

  it("defaults the stream bounds to the owner's conservative values", () => {
    expect(loadEnvConfig().streamBounds).toEqual({
      firstChunkTimeoutMs: 90_000,
      streamIdleTimeoutMs: 60_000,
      reasoningOnlyTimeoutMs: 150_000,
      inferenceRoundDeadlineMs: 300_000,
    });
  });

  it("accepts 0 for every stream bound (disabled)", () => {
    process.env.AGENT_FIRST_CHUNK_TIMEOUT_MS = "0";
    process.env.AGENT_STREAM_IDLE_TIMEOUT_MS = "0";
    process.env.AGENT_REASONING_ONLY_TIMEOUT_MS = "0";
    process.env.AGENT_INFERENCE_ROUND_DEADLINE_MS = "0";
    expect(loadEnvConfig().streamBounds).toEqual({
      firstChunkTimeoutMs: 0,
      streamIdleTimeoutMs: 0,
      reasoningOnlyTimeoutMs: 0,
      inferenceRoundDeadlineMs: 0,
    });
  });

  it("parses explicit stream bounds and treats blank as the default", () => {
    process.env.AGENT_STREAM_IDLE_TIMEOUT_MS = "30000";
    process.env.AGENT_INFERENCE_ROUND_DEADLINE_MS = "  ";
    const bounds = loadEnvConfig().streamBounds;
    expect(bounds.streamIdleTimeoutMs).toBe(30_000);
    expect(bounds.inferenceRoundDeadlineMs).toBe(300_000);
  });

  it("rejects negative, fractional, non-numeric and over-ceiling stream bounds", () => {
    for (const raw of ["-1", "1500.5", "soon", "3600001"]) {
      process.env.AGENT_REASONING_ONLY_TIMEOUT_MS = raw;
      expect(() => loadEnvConfig()).toThrow("AGENT_REASONING_ONLY_TIMEOUT_MS");
    }
  });

  it("aggregates a stream-bound error with the other AGENT_ errors", () => {
    process.env.AGENT_CONTEXT_LIMIT = "5";
    process.env.AGENT_FIRST_CHUNK_TIMEOUT_MS = "-5";
    expect(() => loadEnvConfig()).toThrow(/AGENT_CONTEXT_LIMIT.*AGENT_FIRST_CHUNK_TIMEOUT_MS/s);
  });

  it("fails startup on an invalid read-dispatch bound", () => {
    for (const raw of ["0", "9", "many"]) {
      process.env.AGENT_TOOL_READ_CONCURRENCY = raw;
      expect(() => loadEnvConfig()).toThrow("AGENT_TOOL_READ_CONCURRENCY");
    }
    process.env.AGENT_TOOL_READ_CONCURRENCY = "1";
    process.env.AGENT_TOOL_READ_TIMEOUT_MS = "-1";
    expect(() => loadEnvConfig()).toThrow("AGENT_TOOL_READ_TIMEOUT_MS");
    process.env.AGENT_TOOL_READ_TIMEOUT_MS = "0";
    expect(() => loadEnvConfig()).not.toThrow();
  });

  it("fails startup on an invalid DB bound, including an attempt to disable one", () => {
    for (const raw of ["0", "soon", "3600001"]) {
      process.env.AGENT_DB_STATEMENT_TIMEOUT_MS = raw;
      expect(() => loadEnvConfig()).toThrow("AGENT_DB_STATEMENT_TIMEOUT_MS");
    }
    process.env.AGENT_DB_STATEMENT_TIMEOUT_MS = "45000";
    expect(() => loadEnvConfig()).not.toThrow();
  });
});
