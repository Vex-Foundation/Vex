/**
 * System Check's native-runtime facts. The locators, the disk and the model
 * store are injected; `readDiskSpace` itself runs against this machine's
 * real filesystem, and the IPC channel against the production wiring.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localRuntimeCheckSchema } from "@shared/schemas/system.js";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/nonexistent/vex-app" } }));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { checkLocalRuntime, DEV_SYSTEM_CHECK_ENV } = await import("../native/local-runtime-check.js");
const { EMBEDDING_MODEL_SPEC } = await import("../native/model-store.js");
const { readDiskSpace } = await import("../../system/disk-space.js");
type Deps = Parameters<typeof checkLocalRuntime>[0];

const GiB = 1024 ** 3;

function deps(overrides: Partial<NonNullable<Deps>> = {}): NonNullable<Deps> {
  return {
    runtimeDir: "/Users/someone/.vex/runtime",
    platform: "darwin",
    arch: "arm64",
    packaged: false,
    env: {},
    locatePostgres: async () => ({
      kind: "found",
      binaries: { postgres: "/b/postgres", initdb: "/b/initdb", pgCtl: "/b/pg_ctl", pgControldata: "/b/pg_controldata" },
    }),
    locateLlama: async () => ({ kind: "found", binaryPath: "/l/llama-server" }),
    diskSpace: async (target) => ({ measuredPath: target, freeBytes: 100 * GiB, totalBytes: 500 * GiB }),
    modelNeed: async () => ({ verified: false, bytesToWrite: EMBEDDING_MODEL_SPEC.bytes }),
    totalmem: () => 16 * GiB,
    freemem: () => 3 * GiB,
    ...overrides,
  };
}

describe("checkLocalRuntime", () => {
  it("reports the bundle present for this OS and arch, the runtime volume, and memory", async () => {
    const measured: string[] = [];
    const modelDirs: string[] = [];
    const result = await checkLocalRuntime(
      deps({
        diskSpace: async (target) => {
          measured.push(target);
          return { measuredPath: target, freeBytes: 100 * GiB, totalBytes: 500 * GiB };
        },
        modelNeed: async (dir) => {
          modelDirs.push(dir);
          return { verified: true, bytesToWrite: 0 };
        },
      }),
    );
    expect(localRuntimeCheckSchema.parse(result)).toEqual({
      bundle: { kind: "present", platform: "darwin", arch: "arm64" },
      disk: { kind: "measured", freeBytes: 100 * GiB, totalBytes: 500 * GiB, modelVerified: true, modelBytesToWrite: 0 },
      memory: { totalBytes: 16 * GiB, freeBytes: 3 * GiB },
    });
    expect(measured).toEqual(["/Users/someone/.vex/runtime"]);
    expect(modelDirs).toEqual([path.join("/Users/someone/.vex/runtime", "models")]);
  });

  it("names what is missing when a bundled binary cannot be found", async () => {
    const result = await checkLocalRuntime(
      deps({ locateLlama: async () => ({ kind: "unavailable", detail: "The bundled embeddings server is missing or not executable. Reinstall Vex." }) }),
    );
    expect(result.bundle).toEqual({
      kind: "missing",
      detail: "The bundled embeddings server is missing or not executable. Reinstall Vex.",
    });
    const noPg = await checkLocalRuntime(deps({ locatePostgres: async () => ({ kind: "unavailable", detail: "no postgres" }) }));
    expect(noPg.bundle).toEqual({ kind: "missing", detail: "no postgres" });
  });

  it("an unmeasurable disk is unreadable, not zero free", async () => {
    const result = await checkLocalRuntime(
      deps({
        diskSpace: async () => {
          throw Object.assign(new Error("EACCES: permission denied, statfs"), { code: "EACCES" });
        },
      }),
    );
    expect(result.disk).toEqual({ kind: "unreadable", message: "The free space on this disk could not be read." });
  });

  it("applies the development override in an unpackaged app", async () => {
    const env = {
      [DEV_SYSTEM_CHECK_ENV]: JSON.stringify({ diskFreeBytes: 300_000_000, modelVerified: false, memoryTotalBytes: 3 * GiB }),
    };
    const result = await checkLocalRuntime(deps({ env, modelNeed: async () => ({ verified: true, bytesToWrite: 0 }) }));
    expect(result.disk).toEqual({
      kind: "measured",
      freeBytes: 300_000_000,
      totalBytes: 500 * GiB,
      modelVerified: false,
      // A model "not verified" by override is one still to download.
      modelBytesToWrite: EMBEDDING_MODEL_SPEC.bytes,
    });
    expect(result.memory).toEqual({ totalBytes: 3 * GiB, freeBytes: 3 * GiB });
  });

  it("a packaged app ignores the override, and a malformed one is ignored", async () => {
    const env = { [DEV_SYSTEM_CHECK_ENV]: JSON.stringify({ diskFreeBytes: 1 }) };
    const packaged = await checkLocalRuntime(deps({ env, packaged: true }));
    expect(packaged.disk).toMatchObject({ freeBytes: 100 * GiB });
    const malformed = await checkLocalRuntime(deps({ env: { [DEV_SYSTEM_CHECK_ENV]: "{diskFreeBytes:1" } }));
    expect(malformed.disk).toMatchObject({ freeBytes: 100 * GiB });
    const unknownKey = await checkLocalRuntime(deps({ env: { [DEV_SYSTEM_CHECK_ENV]: '{"freeBytes":1}' } }));
    expect(unknownKey.disk).toMatchObject({ freeBytes: 100 * GiB });
  });

  it("runs on the real wiring and starts nothing", async () => {
    const result = await checkLocalRuntime();
    expect(localRuntimeCheckSchema.safeParse(result).success).toBe(true);
    expect(result.memory.totalBytes).toBe(os.totalmem());
  });
});

describe("readDiskSpace (this machine's filesystem)", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("measures an existing directory", async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "vex-disk-"));
    const space = await readDiskSpace(root);
    expect(space.measuredPath).toBe(path.resolve(root));
    expect(space.totalBytes).toBeGreaterThan(0);
    expect(space.freeBytes).toBeGreaterThan(0);
    expect(space.freeBytes).toBeLessThanOrEqual(space.totalBytes);
  });

  it("measures the nearest existing ancestor of a directory not created yet", async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "vex-disk-"));
    const space = await readDiskSpace(path.join(root, "runtime", "models"));
    expect(space.measuredPath).toBe(path.resolve(root));
  });
});
