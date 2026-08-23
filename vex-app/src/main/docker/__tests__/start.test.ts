/**
 * Windows Docker Desktop launch tests (harness-vexup-docker-ports).
 *
 * Covers the tiered `startWindows` strategy via `performStart` with
 * `process.platform` forced to win32, plus the two pure helpers:
 *   - Tier 1 `docker desktop start` success (uses --timeout, no fallback)
 *   - Tier 1 unsupported (old Docker Desktop) → Tier 2 detached launch
 *   - Tier 1 genuine failure / timeout → failed, NO GUI fallback
 *   - Tier 2 exe resolution precedence (per-user before Program Files)
 *   - PowerShell single-quote escaping
 *
 * `runSpawn` and the locator's `isExistingFile` are mocked so nothing spawns
 * and no real filesystem is touched. Exe resolution now delegates to
 * `locate.ts`, which joins Windows paths with `path.win32` rather than the
 * host's separator, so the expected paths use backslashes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnRunnerResult } from "../spawn-runner.js";

const { runSpawnMock, existsSyncMock } = vi.hoisted(() => ({
  runSpawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock("../spawn-runner.js", () => ({ runSpawn: runSpawnMock }));
vi.mock("../locate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../locate.js")>();
  return { ...actual, isExistingFile: existsSyncMock };
});

const { performStart, escapePowershellSingleQuoted, resolveDockerDesktopExe } =
  await import("../start.js");

function spawnResult(partial: Partial<SpawnRunnerResult>): SpawnRunnerResult {
  return {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    aborted: false,
    timedOut: false,
    ...partial,
  };
}

const realPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
  runSpawnMock.mockReset();
  existsSyncMock.mockReset();
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllEnvs();
});

describe("escapePowershellSingleQuoted", () => {
  it("leaves a normal path untouched", () => {
    const p = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
    expect(escapePowershellSingleQuoted(p)).toBe(p);
  });

  it("doubles embedded single quotes", () => {
    expect(escapePowershellSingleQuoted("C:\\O'Brien\\app.exe")).toBe(
      "C:\\O''Brien\\app.exe"
    );
  });
});

describe("resolveDockerDesktopExe", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
  } as NodeJS.ProcessEnv;

  it("prefers the per-user LocalAppData install over Program Files", () => {
    existsSyncMock.mockReturnValue(true); // both present
    expect(resolveDockerDesktopExe(env)).toBe(
      "C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe"
    );
  });

  it("falls back to Program Files when the per-user exe is absent", () => {
    existsSyncMock.mockImplementation((p: unknown) =>
      String(p).includes("Program Files")
    );
    expect(resolveDockerDesktopExe(env)).toBe(
      "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"
    );
  });

  it("returns null when neither candidate exists", () => {
    existsSyncMock.mockReturnValue(false);
    expect(resolveDockerDesktopExe(env)).toBeNull();
  });
});

describe("performStart on Windows", () => {
  beforeEach(() => setPlatform("win32"));

  it("Tier 1: `docker desktop start` success → started, bounded by --timeout, no fallback", async () => {
    runSpawnMock.mockResolvedValueOnce(spawnResult({ code: 0 }));

    const result = await performStart();

    expect(result.kind).toBe("started");
    expect(runSpawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = runSpawnMock.mock.calls[0] as [
      string,
      string[],
      { timeoutMs?: number },
    ];
    expect(cmd).toBe("docker");
    // `--timeout` is numeric seconds (no `s` suffix), and runSpawn is
    // independently bounded so the start flow can never hang.
    expect(args).toEqual(["desktop", "start", "--timeout", "120"]);
    expect(options.timeoutMs).toBe(135_000);
  });

  it("Tier 1 unsupported (old Docker Desktop) → Tier 2 detached Start-Process of the resolved exe", async () => {
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local");
    runSpawnMock
      .mockResolvedValueOnce(
        spawnResult({ code: 1, stderr: "unknown command: desktop" })
      )
      .mockResolvedValueOnce(spawnResult({ code: 0 }));
    existsSyncMock.mockReturnValue(true);

    const result = await performStart();

    expect(result.kind).toBe("started");
    expect(runSpawnMock).toHaveBeenCalledTimes(2);
    const [cmd2, args2] = runSpawnMock.mock.calls[1] as [string, string[]];
    expect(cmd2).toBe("powershell.exe");
    const joined = args2.join(" ");
    expect(joined).toContain("Start-Process -FilePath '");
    expect(joined).toContain("Docker Desktop.exe");
  });

  it("Tier 1 genuine failure (not unsupported) → failed, NO GUI fallback", async () => {
    runSpawnMock.mockResolvedValueOnce(
      spawnResult({ code: 1, stderr: "Cannot connect to the Docker daemon" })
    );

    const result = await performStart();

    expect(result.kind).toBe("failed");
    expect(runSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("Tier 1 timeout → failed, NO GUI fallback", async () => {
    runSpawnMock.mockResolvedValueOnce(
      spawnResult({ code: null, timedOut: true })
    );

    const result = await performStart();

    expect(result.kind).toBe("failed");
    expect(runSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("Tier 2 with no Docker Desktop.exe found → failed with an actionable message", async () => {
    runSpawnMock.mockResolvedValueOnce(
      spawnResult({ code: 1, stderr: "unknown command" })
    );
    existsSyncMock.mockReturnValue(false); // exe not found

    const result = await performStart();

    expect(result.kind).toBe("failed");
    expect(result.message).toMatch(/Docker Desktop\.exe/i);
    // Only the Tier-1 CLI probe ran; no GUI launch was attempted.
    expect(runSpawnMock).toHaveBeenCalledTimes(1);
  });
});
