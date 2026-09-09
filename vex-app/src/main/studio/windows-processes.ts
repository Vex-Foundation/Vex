import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
const processSchema = z.object({
  pid: z.number().int().positive(), parentPid: z.number().int().nonnegative(),
  binary: z.string().nullable(), commandLine: z.string().nullable(),
  startedAt: z.number().nonnegative(),
}).strict();
export type ProcessEntry = z.infer<typeof processSchema>;

export async function enumerateWindowsProcesses(signal?: AbortSignal): Promise<ProcessEntry[]> {
  const { stdout } = await run(powershell(), ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
    + "$entries = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object { "
    + "@{pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; binary=$_.ExecutablePath; "
    + "commandLine=$_.CommandLine; startedAt=$(if ($null -ne $_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 })} "
    + "}); ConvertTo-Json -InputObject $entries -Compress"], { windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024, signal });
  return z.array(processSchema).parse(JSON.parse(stdout));
}

function powershell(): string {
  return path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Read only the cwd of an already identified own descendant. Unknown stays unknown.
 * Windows' 64-bit PEB layout is used only after rejecting WOW64 processes.
 */
export async function readWindowsCwd(pid: number, signal?: AbortSignal): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const source = String.raw`
using System;
using System.Runtime.InteropServices;
public static class VexCwd {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr address, byte[] bytes, int size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int kind, byte[] info, int size, out int needed);
  static byte[] Read(IntPtr h, long address, int size) {
    var bytes = new byte[size]; IntPtr read;
    if (!ReadProcessMemory(h, new IntPtr(address), bytes, size, out read) || read.ToInt64() != size) throw new Exception();
    return bytes;
  }
  public static string Get(int pid) {
    if (IntPtr.Size != 8) return null;
    IntPtr h = OpenProcess(0x410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      bool wow; if (!IsWow64Process(h, out wow) || wow) return null;
      var info = new byte[48]; int needed;
      if (NtQueryInformationProcess(h, 0, info, info.Length, out needed) != 0) return null;
      long peb = BitConverter.ToInt64(info, 8);
      long parameters = BitConverter.ToInt64(Read(h, peb + 0x20, 8), 0);
      var cwd = Read(h, parameters + 0x38, 16);
      int length = BitConverter.ToUInt16(cwd, 0);
      if (length == 0 || length % 2 != 0) return null;
      return System.Text.Encoding.Unicode.GetString(Read(h, BitConverter.ToInt64(cwd, 8), length));
    } catch { return null; } finally { CloseHandle(h); }
  }
}`;
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -TypeDefinition @'\n${source}\n'@\n[VexCwd]::Get(${pid}) | ConvertTo-Json -Compress`;
  const { stdout } = await run(powershell(), ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 10000, signal });
  return stdout.trim() === "" ? null : z.string().nullable().parse(JSON.parse(stdout));
}
