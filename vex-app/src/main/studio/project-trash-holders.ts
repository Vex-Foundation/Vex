import path from "node:path";
import type { ProjectTrashHolder } from "@shared/schemas/project-cleanup.js";
import { killWindowsTree } from "../../platform/process-lifetime.js";
import { terminalDomain } from "./terminal-domain.js";
import { orphanedHosts } from "./pty-host-reaper.js";
import { readWindowsCwd, type ProcessEntry } from "./windows-processes.js";

export type ResolveTrashHolders = (directory: string, close: boolean, signal?: AbortSignal) => Promise<ProjectTrashHolder[]>;

function descendsFrom(entry: ProcessEntry, host: ProcessEntry, processes: readonly ProcessEntry[]): boolean {
  const seen = new Set<number>();
  let current = entry;
  while (!seen.has(current.pid)) {
    seen.add(current.pid);
    if (current.parentPid === host.pid) return current.startedAt >= host.startedAt;
    const parent = processes.find((item) => item.pid === current.parentPid);
    if (!parent || parent.startedAt > current.startedAt) return false;
    current = parent;
  }
  return false;
}

function within(directory: string, cwd: string): boolean {
  const relative = path.win32.relative(directory, cwd);
  return relative === "" || (!path.win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"));
}

/** Main derives the directory from the tombstone. Renderer never supplies a PID or path. */
export const resolveTrashHolders: ResolveTrashHolders = async (directory, close, signal) => {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 15000);
  const combined = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
  try { return await inspectHolders(directory, close, combined); }
  finally { clearTimeout(timer); }
};

const inspectHolders: ResolveTrashHolders = async (directory, close, signal) => {
  signal?.throwIfAborted();
  const holders: ProjectTrashHolder[] = await terminalDomain().folderHolders(directory, close);
  const snapshot = await orphanedHosts(signal);
  for (const host of snapshot.hosts) {
    for (const entry of snapshot.processes) {
      if (!descendsFrom(entry, host, snapshot.processes)) continue;
      const cwd = await readWindowsCwd(entry.pid, signal);
      if (cwd === null || !within(directory, cwd)) continue;
      holders.push({ kind: "vex_orphaned_terminal", pid: entry.pid });
      if (!close) continue;
      // PID, ancestry, creation time and cwd must all still match at the action boundary.
      const current = await orphanedHosts(signal);
      const sameHost = current.hosts.find((item) => item.pid === host.pid && item.startedAt === host.startedAt);
      const same = current.processes.find((item) => item.pid === entry.pid && item.startedAt === entry.startedAt);
      if (!sameHost || !same || !descendsFrom(same, sameHost, current.processes)) continue;
      const currentCwd = await readWindowsCwd(same.pid, signal);
      signal?.throwIfAborted();
      if (currentCwd !== null && within(directory, currentCwd)) killWindowsTree(same.pid);
    }
  }
  return holders.length === 0 ? [{ kind: "external" }] : holders;
};
