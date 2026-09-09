import { execFileSync } from "node:child_process";
import path from "node:path";

/** Permission failures are not evidence that a process died. */
export function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (cause) { return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH"); }
}

/** Synchronous so a disposing utility process cannot exit before taskkill finishes. */
export function killWindowsTree(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process id");
  execFileSync(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 3000 });
}

export function terminateTerminal(
  pty: { readonly pid: number; kill(): void },
  platform: NodeJS.Platform,
  killTree: (pid: number) => void = killWindowsTree,
): void {
  try { if (platform === "win32" && pty.pid > 0) killTree(pty.pid); }
  finally { pty.kill(); }
}
