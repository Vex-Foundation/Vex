/**
 * The facts System Check shows for the native runtime: is the bundled
 * runtime here for this OS and arch, how much room is on the volume that will
 * hold it, and how much memory the machine has. Read-only: it locates the
 * binaries the way the start does (`runtime-paths.ts`) and runs none of them;
 * main already starts the runtime at boot.
 *
 * DEVELOPMENT OVERRIDE. `VEX_DEV_SYSTEM_CHECK` (JSON, any subset of
 * `diskFreeBytes`, `diskTotalBytes`, `modelVerified`, `memoryTotalBytes`,
 * `memoryFreeBytes`) replaces the measured numbers, so the low-disk and
 * low-memory rows can be seen without filling a disk. A packaged app ignores
 * it, like every other development override in `runtime-paths.ts`.
 */

import os from "node:os";
import { app } from "electron";
import { z } from "zod";
import type { LocalRuntimeCheck } from "@shared/schemas/system.js";
import { log } from "../../logger/index.js";
import { readDiskSpace, type DiskSpace } from "../../system/disk-space.js";
import {
  locateLlamaBinary,
  locatePostgresBinaries,
  modelsDir,
  RUNTIME_DIR,
  type LlamaBinaryLocation,
  type PostgresBinariesLocation,
} from "../runtime-paths.js";
import { EMBEDDING_MODEL_SPEC, modelDiskNeed, type ModelDiskNeed } from "./model-store.js";

export const DEV_SYSTEM_CHECK_ENV = "VEX_DEV_SYSTEM_CHECK";

const byteCount = z.number().int().nonnegative();
const overrideSchema = z
  .object({
    diskFreeBytes: byteCount.optional(),
    diskTotalBytes: byteCount.optional(),
    modelVerified: z.boolean().optional(),
    memoryTotalBytes: byteCount.optional(),
    memoryFreeBytes: byteCount.optional(),
  })
  .strict();
type Override = z.infer<typeof overrideSchema>;

export interface LocalRuntimeCheckDeps {
  readonly runtimeDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly packaged: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly locatePostgres: () => Promise<PostgresBinariesLocation>;
  readonly locateLlama: () => Promise<LlamaBinaryLocation>;
  readonly diskSpace: (target: string) => Promise<DiskSpace>;
  readonly modelNeed: (dir: string) => Promise<ModelDiskNeed>;
  readonly totalmem: () => number;
  readonly freemem: () => number;
}

function productionDeps(): LocalRuntimeCheckDeps {
  return {
    runtimeDir: RUNTIME_DIR,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    env: process.env,
    locatePostgres: () => locatePostgresBinaries(),
    locateLlama: () => locateLlamaBinary(),
    diskSpace: readDiskSpace,
    modelNeed: (dir) => modelDiskNeed(dir),
    totalmem: os.totalmem,
    freemem: os.freemem,
  };
}

function readOverride(deps: LocalRuntimeCheckDeps): Override {
  const raw = deps.env[DEV_SYSTEM_CHECK_ENV];
  if (deps.packaged || raw === undefined || raw === "") return {};
  let parsed: ReturnType<typeof overrideSchema.safeParse>;
  try {
    parsed = overrideSchema.safeParse(JSON.parse(raw));
  } catch {
    log.warn(`[system-check] ${DEV_SYSTEM_CHECK_ENV} is not JSON; ignored`);
    return {};
  }
  if (!parsed.success) {
    log.warn(`[system-check] ${DEV_SYSTEM_CHECK_ENV} is not a valid override; ignored`);
    return {};
  }
  log.warn(`[system-check] development override applied: ${JSON.stringify(parsed.data)}`);
  return parsed.data;
}

async function bundleFacts(deps: LocalRuntimeCheckDeps): Promise<LocalRuntimeCheck["bundle"]> {
  const [postgres, llama] = await Promise.all([deps.locatePostgres(), deps.locateLlama()]);
  if (postgres.kind === "unavailable") return { kind: "missing", detail: postgres.detail };
  if (llama.kind === "unavailable") return { kind: "missing", detail: llama.detail };
  const { platform, arch } = deps;
  if ((platform !== "darwin" && platform !== "win32" && platform !== "linux") || (arch !== "x64" && arch !== "arm64")) {
    return { kind: "missing", detail: `Vex ships no local runtime for ${platform}/${arch}.` };
  }
  return { kind: "present", platform, arch };
}

async function diskFacts(deps: LocalRuntimeCheckDeps, override: Override): Promise<LocalRuntimeCheck["disk"]> {
  let space: DiskSpace;
  try {
    space = await deps.diskSpace(deps.runtimeDir);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[system-check] could not measure the disk at ${deps.runtimeDir}: ${message}`);
    return { kind: "unreadable", message: "The free space on this disk could not be read." };
  }
  const measured = await deps.modelNeed(modelsDir(deps.runtimeDir));
  // An override of `modelVerified: false` stands for a model not yet downloaded.
  const need: ModelDiskNeed =
    override.modelVerified === undefined || override.modelVerified === measured.verified
      ? measured
      : override.modelVerified
        ? { verified: true, bytesToWrite: 0 }
        : { verified: false, bytesToWrite: EMBEDDING_MODEL_SPEC.bytes };
  return {
    kind: "measured",
    freeBytes: override.diskFreeBytes ?? space.freeBytes,
    totalBytes: override.diskTotalBytes ?? space.totalBytes,
    modelVerified: need.verified,
    modelBytesToWrite: need.bytesToWrite,
  };
}

export async function checkLocalRuntime(deps: LocalRuntimeCheckDeps = productionDeps()): Promise<LocalRuntimeCheck> {
  const override = readOverride(deps);
  const [bundle, disk] = await Promise.all([bundleFacts(deps), diskFacts(deps, override)]);
  return {
    bundle,
    disk,
    memory: {
      totalBytes: override.memoryTotalBytes ?? deps.totalmem(),
      freeBytes: override.memoryFreeBytes ?? deps.freemem(),
    },
  };
}
