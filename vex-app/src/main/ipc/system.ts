/**
 * vex.system.* — health/osInfo/network probes for splash + system check.
 */

import { app, net } from "electron";
import { promises as fs } from "node:fs";
import os from "node:os";
import { z } from "zod";
import { CH, EV } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  healthReportSchema,
  nativeRuntimeStatusSchema,
  networkProbeSchema,
  osInfoSchema,
  runtimeInfoSchema,
  type HealthReport,
  type NativeRuntimeStatus,
  type NetworkProbe,
  type OsInfo,
  type OsPlatform,
  type RuntimeInfo,
} from "@shared/schemas/system.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { nativeStartGate } from "../runtime/migration/native-start-gate.js";
import {
  nativeRuntimeProgress,
  nativeRuntimeProgressBus,
} from "../runtime/native/native-runtime-progress.js";
import { getRuntimeMode } from "../runtime/runtime-mode.js";
import { SETUP_COMPLETE_FILE } from "../paths/config-dir.js";
import { registerHandler } from "./register-handler.js";
import { registerSystemLocalRuntimeHandlers } from "./system/local-runtime.js";
import { registerSystemNotifyTurnCompleteHandler } from "./system/notify-turn-complete.js";
import { registerSystemRuntimeMigrationHandlers } from "./system/runtime-migration.js";
import { registerSystemTitleBarOverlayHandler } from "./system/title-bar-overlay.js";
import { isAppTranslocated } from "../system/translocation.js";

const empty = z.object({}).strict();

function platformOrThrow(): OsPlatform {
  const p = process.platform;
  if (p === "darwin" || p === "win32" || p === "linux") return p;
  throw new Error(`Unsupported platform: ${p}`);
}

function archOrThrow(): "x64" | "arm64" {
  const a = process.arch;
  if (a === "x64" || a === "arm64") return a;
  throw new Error(`Unsupported arch: ${a}`);
}

async function readLinuxDistro(): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const content = await fs.readFile("/etc/os-release", "utf8");
    const match = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(content);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function gatherOsInfo(): Promise<OsInfo> {
  const distro = await readLinuxDistro();
  return {
    platform: platformOrThrow(),
    arch: archOrThrow(),
    release: os.release(),
    distro,
    homedir: os.homedir(),
    userDataDir: app.getPath("userData"),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? "",
    nodeVersion: process.versions.node,
  };
}

async function probeNetwork(): Promise<NetworkProbe> {
  const startedAt = Date.now();
  try {
    const res = await net.fetch("https://1.1.1.1", {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      return {
        online: true,
        latencyMs: Date.now() - startedAt,
        probedAt: new Date().toISOString(),
      };
    }
    return { online: false, latencyMs: null, probedAt: new Date().toISOString() };
  } catch {
    return { online: false, latencyMs: null, probedAt: new Date().toISOString() };
  }
}

async function setupCompleteFlag(): Promise<boolean> {
  try {
    await fs.access(SETUP_COMPLETE_FILE);
    return true;
  } catch {
    return false;
  }
}

export function registerSystemHandlers(): Array<() => void> {
  const handlers: Array<() => void> = [];

  handlers.push(registerSystemNotifyTurnCompleteHandler());
  handlers.push(registerSystemTitleBarOverlayHandler());
  handlers.push(...registerSystemLocalRuntimeHandlers());
  handlers.push(...registerSystemRuntimeMigrationHandlers());

  handlers.push(
    registerHandler({
      channel: CH.system.osInfo,
      domain: "system",
      inputSchema: empty,
      outputSchema: osInfoSchema,
      handle: async (): Promise<Result<OsInfo>> => ok(await gatherOsInfo()),
    })
  );

  handlers.push(
    registerHandler({
      channel: CH.system.runtime,
      domain: "system",
      inputSchema: empty,
      outputSchema: runtimeInfoSchema,
      handle: async (): Promise<Result<RuntimeInfo>> => ok({ native: getRuntimeMode() === "native" }),
    })
  );

  handlers.push(
    registerHandler({
      channel: CH.system.runtimeStatus,
      domain: "system",
      inputSchema: empty,
      outputSchema: nativeRuntimeStatusSchema,
      handle: async (): Promise<Result<NativeRuntimeStatus>> => ok(nativeRuntimeProgress.current()),
    })
  );

  // Main owns the start (D8); the renderer may only ask for another attempt
  // once one has failed. Joining a start in flight or re-checking a ready
  // runtime is the migrate handler's, not a button's. The start goes through
  // the migration gate, which starts nothing while data must be moved first.
  handlers.push(
    registerHandler({
      channel: CH.system.runtimeRetry,
      domain: "system",
      inputSchema: empty,
      outputSchema: nativeRuntimeStatusSchema,
      handle: async (): Promise<Result<NativeRuntimeStatus>> => {
        if (getRuntimeMode() === "native" && nativeRuntimeProgress.current().phase === "failed") {
          void nativeStartGate().startNative();
        }
        return ok(nativeRuntimeProgress.current());
      },
    })
  );

  handlers.push(
    nativeRuntimeProgressBus.subscribe((status) =>
      broadcastToAllWindows(EV.system.runtimeProgress, status)
    )
  );

  handlers.push(
    registerHandler({
      channel: CH.system.network,
      domain: "system",
      inputSchema: empty,
      outputSchema: networkProbeSchema,
      handle: async (): Promise<Result<NetworkProbe>> => ok(await probeNetwork()),
    })
  );

  handlers.push(
    registerHandler({
      channel: CH.system.health,
      domain: "system",
      inputSchema: empty,
      outputSchema: healthReportSchema,
      handle: async (): Promise<Result<HealthReport>> => {
        const [osInfo, network, setupComplete] = await Promise.all([
          gatherOsInfo(),
          probeNetwork(),
          setupCompleteFlag(),
        ]);
        const overall: HealthReport["overall"] = network.online
          ? setupComplete
            ? "ok"
            : "degraded"
          : "not_ready";
        return ok({
          os: osInfo,
          network,
          translocated: isAppTranslocated(process.execPath, process.platform),
          setupComplete,
          overall,
        });
      },
    })
  );

  return handlers;
}
