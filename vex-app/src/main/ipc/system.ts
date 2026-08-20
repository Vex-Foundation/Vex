/**
 * vex.system.* — health/osInfo/network probes for splash + system check.
 */

import { app, net } from "electron";
import { promises as fs } from "node:fs";
import os from "node:os";
import { z } from "zod";
import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  healthReportSchema,
  networkProbeSchema,
  osInfoSchema,
  type HealthReport,
  type NetworkProbe,
  type OsInfo,
  type OsPlatform,
} from "@shared/schemas/system.js";
import { SETUP_COMPLETE_FILE } from "../paths/config-dir.js";
import { registerHandler } from "./register-handler.js";
import { registerSystemNotifyTurnCompleteHandler } from "./system/notify-turn-complete.js";
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
