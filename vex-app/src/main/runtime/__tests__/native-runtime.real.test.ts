/**
 * The assembled native runtime against the REAL bundled Postgres and
 * llama-server trees, in a throwaway config dir: boot start, publication of
 * the database connection and the engine's embeddings environment, a second
 * start reusing both servers, and stop withdrawing everything.
 *
 * The verified model is hard-linked in from `native-runtime/.work/models/`
 * (the gates' copy), so the test never downloads 333 MB. Skipped, visibly,
 * when the trees or the model are not on this machine.
 */

import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const target = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const pgTree = path.join(repoRoot, "native-runtime/out", target, "postgres");
const llamaTree = path.join(repoRoot, "native-runtime/out", target, "llama");
const gateModel = path.join(repoRoot, "native-runtime/.work/models/embeddinggemma-300M-Q8_0.gguf");
const haveRuntime = existsSync(pgTree) && existsSync(llamaTree) && existsSync(gateModel);

const configDir = mkdtempSync(path.join(os.tmpdir(), "vex native runtime ü-"));
process.env["VEX_CONFIG_DIR"] = configDir;
process.env["VEX_NATIVE_PG_DIR"] = pgTree;
process.env["VEX_NATIVE_LLAMA_DIR"] = llamaTree;
for (const key of ["EMBEDDING_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_DIM", "EMBEDDING_PROVIDER", "EMBEDDING_API_KEY"]) {
  delete process.env[key];
}

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "" },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { startNativeRuntime, stopNativeRuntime } = await import("../native/native-runtime.js");
const { getDbConnection } = await import("../../database/connection-state.js");
const { RUNTIME_DIR, modelsDir } = await import("../runtime-paths.js");

afterAll(async () => {
  await stopNativeRuntime().catch(() => {});
  rmSync(configDir, { recursive: true, force: true });
});

describe.skipIf(!haveRuntime)("native runtime (real binaries)", () => {
  it("starts, publishes the database and the engine's embeddings, reuses, and stops", { timeout: 180_000 }, async () => {
    expect(RUNTIME_DIR.startsWith(configDir)).toBe(true);
    mkdirSync(modelsDir(RUNTIME_DIR), { recursive: true });
    linkSync(gateModel, path.join(modelsDir(RUNTIME_DIR), "embeddinggemma-300M-Q8_0.gguf"));

    const first = await startNativeRuntime();
    expect(first.kind, first.message).toBe("running");

    const connection = getDbConnection();
    expect(connection).toMatchObject({ host: "127.0.0.1" });
    const password = (await import("node:fs")).readFileSync(connection?.pgPasswordPath ?? "", "utf8").trim();
    const client = new pg.Client({ host: "127.0.0.1", port: connection?.pgPort, user: "vex", password, database: "vex" });
    await client.connect();
    expect((await client.query("SELECT current_database() AS db")).rows[0]?.db).toBe("vex");
    await client.end();

    // The engine's environment points at the live server, behind its key.
    expect(process.env["EMBEDDING_PROVIDER"]).toBe("local");
    expect(process.env["EMBEDDING_MODEL"]).toBe("ai/embeddinggemma:300M-Q8_0");
    expect(process.env["EMBEDDING_DIM"]).toBe("768");
    const key = process.env["EMBEDDING_API_KEY"];
    expect(key).toMatch(/^[0-9a-f]{48}$/);
    const res = await fetch(`${process.env["EMBEDDING_BASE_URL"]}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: "vex", model: "ai/embeddinggemma:300M-Q8_0" }),
    });
    expect(res.status).toBe(200);

    // A later start (the migrate handler joining) reuses both servers.
    const again = await startNativeRuntime();
    expect(again.kind).toBe("reused");
    expect(getDbConnection()).toEqual(connection);
    expect(process.env["EMBEDDING_API_KEY"]).toBe(key);

    await stopNativeRuntime();
    expect(getDbConnection()).toBeNull();
    expect(process.env["EMBEDDING_API_KEY"]).toBeUndefined();
  });
});
