import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadEmbeddingConfig,
  MIN_EMBEDDING_DIM,
  MAX_EMBEDDING_DIM,
} from "@vex-agent/embeddings/config.js";

const ENV_KEYS = [
  "EMBEDDING_BASE_URL",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIM",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_API_KEY",
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) {
    delete process.env[k];
  }
}

function setValid(): void {
  process.env.EMBEDDING_BASE_URL = "http://localhost:12434/engines/llama.cpp/v1";
  process.env.EMBEDDING_MODEL = "ai/embeddinggemma:300M-Q8_0";
  process.env.EMBEDDING_DIM = "768";
  process.env.EMBEDDING_PROVIDER = "local";
}

describe("loadEmbeddingConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── Happy path ───────────────────────────────────────────────

  it("returns parsed config when all env vars are set", () => {
    setValid();
    const config = loadEmbeddingConfig();
    expect(config.baseUrl).toBe("http://localhost:12434/engines/llama.cpp/v1");
    expect(config.model).toBe("ai/embeddinggemma:300M-Q8_0");
    expect(config.dim).toBe(768);
    expect(config.provider).toBe("local");
  });

  it("carries no apiKey when EMBEDDING_API_KEY is unset or blank", () => {
    setValid();
    expect(loadEmbeddingConfig()).not.toHaveProperty("apiKey");
    process.env.EMBEDDING_API_KEY = "   ";
    expect(loadEmbeddingConfig()).not.toHaveProperty("apiKey");
  });

  it("loads EMBEDDING_API_KEY, trimmed", () => {
    setValid();
    process.env.EMBEDDING_API_KEY = "  per-launch-key  ";
    expect(loadEmbeddingConfig().apiKey).toBe("per-launch-key");
  });

  it("strips trailing slash from baseUrl", () => {
    setValid();
    process.env.EMBEDDING_BASE_URL = "http://localhost:12434/engines/llama.cpp/v1/";
    const config = loadEmbeddingConfig();
    expect(config.baseUrl).toBe("http://localhost:12434/engines/llama.cpp/v1");
  });

  // ── Missing values ───────────────────────────────────────────

  it("throws when EMBEDDING_BASE_URL is missing", () => {
    setValid();
    delete process.env.EMBEDDING_BASE_URL;
    expect(() => loadEmbeddingConfig()).toThrow(/EMBEDDING_BASE_URL is required/);
  });

  it("throws when EMBEDDING_MODEL is missing", () => {
    setValid();
    delete process.env.EMBEDDING_MODEL;
    expect(() => loadEmbeddingConfig()).toThrow(/EMBEDDING_MODEL is required/);
  });

  it("throws when EMBEDDING_DIM is missing", () => {
    setValid();
    delete process.env.EMBEDDING_DIM;
    expect(() => loadEmbeddingConfig()).toThrow(/EMBEDDING_DIM is required/);
  });

  it("throws when EMBEDDING_PROVIDER is missing", () => {
    setValid();
    delete process.env.EMBEDDING_PROVIDER;
    expect(() => loadEmbeddingConfig()).toThrow(/EMBEDDING_PROVIDER is required/);
  });

  // ── Validation ───────────────────────────────────────────────

  it("rejects baseUrl without http:// or https://", () => {
    setValid();
    process.env.EMBEDDING_BASE_URL = "localhost:12434";
    expect(() => loadEmbeddingConfig()).toThrow(/must start with http/);
  });

  // ── EMBEDDING_DIM range (was: schema-locked at 768) ──────────

  it("accepts the EmbeddingGemma default (768)", () => {
    setValid();
    process.env.EMBEDDING_DIM = "768";
    expect(loadEmbeddingConfig().dim).toBe(768);
  });

  it("accepts a different positive integer (1024 — Qwen3-Embedding 0.6B)", () => {
    setValid();
    process.env.EMBEDDING_DIM = "1024";
    expect(loadEmbeddingConfig().dim).toBe(1024);
  });

  it("accepts the maximum allowed dim", () => {
    setValid();
    process.env.EMBEDDING_DIM = String(MAX_EMBEDDING_DIM);
    expect(loadEmbeddingConfig().dim).toBe(MAX_EMBEDDING_DIM);
  });

  it("accepts the minimum allowed dim", () => {
    setValid();
    process.env.EMBEDDING_DIM = String(MIN_EMBEDDING_DIM);
    expect(loadEmbeddingConfig().dim).toBe(MIN_EMBEDDING_DIM);
  });

  it("rejects 0", () => {
    setValid();
    process.env.EMBEDDING_DIM = "0";
    expect(() => loadEmbeddingConfig()).toThrow(/out of range/);
  });

  it("rejects negative", () => {
    setValid();
    process.env.EMBEDDING_DIM = "-1";
    expect(() => loadEmbeddingConfig()).toThrow(/out of range/);
  });

  it("rejects values above the cap", () => {
    setValid();
    process.env.EMBEDDING_DIM = String(MAX_EMBEDDING_DIM + 1);
    expect(() => loadEmbeddingConfig()).toThrow(/out of range/);
  });

  it("rejects non-integer numeric (1.5)", () => {
    setValid();
    process.env.EMBEDDING_DIM = "1.5";
    expect(() => loadEmbeddingConfig()).toThrow(/must be a positive integer/);
  });

  it("rejects non-numeric EMBEDDING_DIM", () => {
    setValid();
    process.env.EMBEDDING_DIM = "abc";
    expect(() => loadEmbeddingConfig()).toThrow(/must be a positive integer/);
  });

  it("aggregates multiple errors into a single throw", () => {
    clearEnv();
    expect(() => loadEmbeddingConfig()).toThrow(/EMBEDDING_BASE_URL[\s\S]*EMBEDDING_MODEL[\s\S]*EMBEDDING_DIM[\s\S]*EMBEDDING_PROVIDER/);
  });
});
