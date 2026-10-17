/**
 * Tests for the M9 embeddings probe — the data feeding
 * `envState.embeddings.{configured, reachable, baseUrlRedacted,
 * allFieldsConfigured, dbReachable}`.
 *
 * Mocks fetch + dim-lock helper. Uses real fs against tmp dir for
 * the .env reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const mockProbeDbReachable = vi.fn();

vi.mock("../../database/dim-lock.js", () => ({
  probeDbReachable: () => mockProbeDbReachable(),
  countRowsWithDimNotMatching: vi.fn(),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { probeEmbeddings } = await import("../embedding-state.js");

let tmpDir = "";
let envFile = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vex-embed-state-"));
  envFile = path.join(tmpDir, ".env");
  fetchMock.mockReset();
  mockProbeDbReachable.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("probeEmbeddings", () => {
  it("returns allFieldsConfigured=false when .env missing", async () => {
    mockProbeDbReachable.mockResolvedValue(true);
    const r = await probeEmbeddings(envFile);
    expect(r.allFieldsConfigured).toBe(false);
    expect(r.configured).toBe(false);
    expect(r.reachable).toBe(false);
    expect(r.baseUrlRedacted).toBeNull();
    expect(r.dbReachable).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled(); // no probe when not configured
  });

  it("returns allFieldsConfigured=false when one key missing", async () => {
    await fs.writeFile(
      envFile,
      'EMBEDDING_BASE_URL="http://x"\nEMBEDDING_MODEL="m"\nEMBEDDING_DIM="768"\n',
      "utf8",
    );
    mockProbeDbReachable.mockResolvedValue(false);
    const r = await probeEmbeddings(envFile);
    expect(r.allFieldsConfigured).toBe(false);
  });

  it("happy: 4 fields valid, fetch ok → reachable=true + redacted url", async () => {
    await fs.writeFile(
      envFile,
      [
        'EMBEDDING_BASE_URL="http://127.0.0.1:12434/engines/llama.cpp/v1"',
        'EMBEDDING_MODEL="ai/embeddinggemma:300M-Q8_0"',
        'EMBEDDING_DIM="768"',
        'EMBEDDING_PROVIDER="local"',
      ].join("\n"),
      "utf8",
    );
    mockProbeDbReachable.mockResolvedValue(true);
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const r = await probeEmbeddings(envFile);
    expect(r.allFieldsConfigured).toBe(true);
    expect(r.configured).toBe(true);
    expect(r.reachable).toBe(true);
    expect(r.baseUrlRedacted).toBe("http://127.0.0.1:12434");
    expect(r.dbReachable).toBe(true);
  });

  it("invalid baseUrl rejects allFieldsConfigured even when all 4 keys present", async () => {
    await fs.writeFile(
      envFile,
      [
        'EMBEDDING_BASE_URL="not-a-url"',
        'EMBEDDING_MODEL="m"',
        'EMBEDDING_DIM="768"',
        'EMBEDDING_PROVIDER="local"',
      ].join("\n"),
      "utf8",
    );
    mockProbeDbReachable.mockResolvedValue(null);
    const r = await probeEmbeddings(envFile);
    expect(r.allFieldsConfigured).toBe(false);
    expect(r.dbReachable).toBeNull();
  });

  it("dbReachable surfaces null when probe throws", async () => {
    mockProbeDbReachable.mockRejectedValue(new Error("kaboom"));
    const r = await probeEmbeddings(envFile);
    expect(r.dbReachable).toBeNull();
  });

  it("invalid dim (out of range) → not configured", async () => {
    await fs.writeFile(
      envFile,
      [
        'EMBEDDING_BASE_URL="http://x"',
        'EMBEDDING_MODEL="m"',
        'EMBEDDING_DIM="99999"',
        'EMBEDDING_PROVIDER="local"',
      ].join("\n"),
      "utf8",
    );
    mockProbeDbReachable.mockResolvedValue(true);
    const r = await probeEmbeddings(envFile);
    expect(r.allFieldsConfigured).toBe(false);
  });

  it("fetch failure → reachable=false but allFieldsConfigured stays true", async () => {
    await fs.writeFile(
      envFile,
      [
        'EMBEDDING_BASE_URL="http://127.0.0.1:1/v1"',
        'EMBEDDING_MODEL="m"',
        'EMBEDDING_DIM="768"',
        'EMBEDDING_PROVIDER="local"',
      ].join("\n"),
      "utf8",
    );
    mockProbeDbReachable.mockResolvedValue(true);
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await probeEmbeddings(envFile);
    expect(r.allFieldsConfigured).toBe(true);
    expect(r.reachable).toBe(false);
  });
});

const { setRuntimeMode } = await import("../../runtime/runtime-mode.js");
const { publishNativeEmbeddings } = await import("../../runtime/native/embedding-env.js");

describe("probeEmbeddings on the native runtime", () => {
  const LIVE = { baseUrl: "http://127.0.0.1:54321/v1", apiKey: "a".repeat(48) };
  const BUNDLED_FILE =
    'EMBEDDING_BASE_URL="http://127.0.0.1:27134/v1"\nEMBEDDING_MODEL="ai/embeddinggemma:300M-Q8_0"\nEMBEDDING_DIM="768"\nEMBEDDING_PROVIDER="local"\n';

  beforeEach(() => {
    setRuntimeMode("native");
    mockProbeDbReachable.mockResolvedValue(true);
    fetchMock.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    publishNativeEmbeddings(null, {});
    setRuntimeMode("docker");
  });

  it("probes and names the live server the runtime published, with its key, not the file's default port", async () => {
    await fs.writeFile(envFile, BUNDLED_FILE);
    publishNativeEmbeddings(LIVE, {});
    const r = await probeEmbeddings(envFile);
    expect(r).toMatchObject({ configured: true, reachable: true, baseUrlRedacted: "http://127.0.0.1:54321" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:54321/v1/models");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Accept: "application/json", Authorization: `Bearer ${LIVE.apiKey}` },
    });
    // The file still names the bundled default; nothing was written to it.
    expect(await fs.readFile(envFile, "utf8")).toBe(BUNDLED_FILE);
  });

  it("is not reachable while the server is down, without probing the file's port", async () => {
    await fs.writeFile(envFile, BUNDLED_FILE);
    const r = await probeEmbeddings(envFile);
    expect(r).toMatchObject({ configured: true, reachable: false, baseUrlRedacted: "http://127.0.0.1:27134" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes a remote provider the user configured exactly as before", async () => {
    await fs.writeFile(
      envFile,
      'EMBEDDING_BASE_URL="https://api.example.com/v1"\nEMBEDDING_MODEL="text-embedding-3-small"\nEMBEDDING_DIM="768"\nEMBEDDING_PROVIDER="openai"\n',
    );
    publishNativeEmbeddings(LIVE, {});
    const r = await probeEmbeddings(envFile);
    expect(r).toMatchObject({ reachable: true, baseUrlRedacted: "https://api.example.com" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.com/v1/models");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { Accept: "application/json" } });
    expect(JSON.stringify(fetchMock.mock.calls[0]?.[1])).not.toContain("Bearer");
  });

  it("leaves the container runtime's probe of the file's URL unchanged", async () => {
    setRuntimeMode("docker");
    await fs.writeFile(envFile, BUNDLED_FILE);
    publishNativeEmbeddings(LIVE, {});
    const r = await probeEmbeddings(envFile);
    expect(r).toMatchObject({ reachable: true, baseUrlRedacted: "http://127.0.0.1:27134" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:27134/v1/models");
  });
});
