import path from "node:path";
import { PTY_HOST_MARKER, ptyParentPid } from "@shared/schemas/pty-lifetime.js";
import { killWindowsTree, processExists } from "../../platform/process-lifetime.js";
import { enumerateWindowsProcesses, type ProcessEntry } from "./windows-processes.js";
import { log } from "../logger/index.js";

/** Exact unquoted marker token, never a substring in another argument or a binary name. */
function argumentsOf(command: string): string[] {
  return (command.match(/"[^"]*"|[^\s]+/g) ?? []).map((arg) => arg.replace(/^"|"$/g, ""));
}

export function selectOrphanedHosts(processes: readonly ProcessEntry[], binary: string): ProcessEntry[] {
  const live = new Set(processes.map((entry) => entry.pid));
  const normalized = path.win32.normalize(binary).toLowerCase();
  return processes.filter((entry) => {
    if (entry.startedAt <= 0 || entry.binary === null || path.win32.normalize(entry.binary).toLowerCase() !== normalized) return false;
    const args = argumentsOf(entry.commandLine ?? "");
    const parentPid = ptyParentPid(args);
    return args.includes("--type=utility") && args.includes(PTY_HOST_MARKER) && parentPid !== null && parentPid === entry.parentPid
      && !live.has(parentPid);
  });
}

export async function orphanedHosts(signal?: AbortSignal): Promise<{ processes: ProcessEntry[]; hosts: ProcessEntry[] }> {
  if (process.platform !== "win32") return { processes: [], hosts: [] };
  const processes = await enumerateWindowsProcesses(signal);
  return { processes, hosts: selectOrphanedHosts(processes, process.execPath).filter((host) => !processExists(host.parentPid)) };
}

/** Re-enumerate just before termination, including creation time to reject reused PIDs. */
export async function reapHost(host: ProcessEntry, signal?: AbortSignal): Promise<boolean> {
  const current = await orphanedHosts(signal);
  signal?.throwIfAborted();
  if (!current.hosts.some((entry) => entry.pid === host.pid && entry.startedAt === host.startedAt)) return false;
  killWindowsTree(host.pid);
  return true;
}

export async function reapOrphanedPtyHosts(): Promise<void> {
  if (process.platform !== "win32") return;
  const reaped: ProcessEntry[] = [];
  try {
    const { hosts } = await orphanedHosts();
    for (const host of hosts) {
      try { if (await reapHost(host)) reaped.push(host); }
      catch { log.warn("[studio:pty-reaper] an identified orphan could not be terminated", { pid: host.pid }); }
    }
  } catch { log.warn("[studio:pty-reaper] process enumeration failed"); }
  log.info("[studio:pty-reaper] completed", {
    count: reaped.length, pids: reaped.map((host) => host.pid),
    agesMs: reaped.map((host) => Math.max(0, Date.now() - host.startedAt)),
  });
}
