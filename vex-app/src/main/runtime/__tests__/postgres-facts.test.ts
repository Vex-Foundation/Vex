import { describe, expect, it } from "vitest";
import {
  classifyStartFailure,
  firstFatalLine,
  isDiskFullText,
  isReadyFor,
  logLinesForPid,
  logLinesForPostmaster,
  parseControldataSystemIdentifier,
  parsePostmasterPid,
} from "../native/postgres-facts.js";
import {
  INITDB_DISK_FULL_OUTPUT,
  RESTART_DISK_FULL_LOG,
  RESTART_DISK_FULL_STDERR,
  RESTART_POSTMASTER_PID,
  RESTART_STARTUP_PID,
  RUNNING_DISK_FULL_LOG,
  SEMGET_ENOSPC,
  SHMGET_ENOSPC,
} from "./pg-disk-full-logs.js";

/** A postmaster.pid as PG 18 writes it (status padded to its fixed width). */
function pidFile(pid: number, status: string): string {
  return [String(pid), "/data/pg18", "1792231608", "45999", "", "127.0.0.1", "246755175   8847363", `${status.padEnd(8)}`, ""].join("\n");
}

describe("postmaster.pid readiness", () => {
  it("parses the PG 18 layout", () => {
    expect(parsePostmasterPid(pidFile(77391, "ready"))).toEqual({
      pid: 77391,
      dataDir: "/data/pg18",
      port: 45999,
      status: "ready",
    });
  });

  it("is ready only when line 1 is the PID we spawned and line 8 says ready", () => {
    expect(isReadyFor(pidFile(500, "ready"), 500)).toBe(true);
    expect(isReadyFor(pidFile(500, "starting"), 500)).toBe(false);
    expect(isReadyFor(null, 500)).toBe(false);
  });

  it("does NOT count a stale file a SIGKILLed postmaster left saying ready", () => {
    // The killed postmaster was 400; we just spawned 500, which has not yet
    // rewritten the file.
    expect(isReadyFor(pidFile(400, "ready"), 500)).toBe(false);
  });

  it("does not count a file still being written (fewer than 8 lines)", () => {
    expect(isReadyFor("500\n/data/pg18\n", 500)).toBe(false);
    expect(parsePostmasterPid("")).toBeNull();
    expect(parsePostmasterPid("garbage\n")).toBeNull();
  });

  it("tolerates CRLF line endings", () => {
    expect(isReadyFor(pidFile(500, "ready").replaceAll("\n", "\r\n"), 500)).toBe(true);
  });
});

describe("failed-start classification", () => {
  // Verbatim from a real failed start on a taken port (darwin-arm64, PG 18.6).
  const portTaken = [
    "2026-10-17 11:12:16.932 WAT [84792] LOG:  could not bind IPv4 address \"127.0.0.1\": Address already in use",
    "2026-10-17 11:12:16.932 WAT [84792] HINT:  Is another postmaster already running on port 45998? If not, wait a few seconds and retry.",
    "2026-10-17 11:12:16.932 WAT [84792] WARNING:  could not create listen socket for \"127.0.0.1\"",
    "2026-10-17 11:12:16.932 WAT [84792] FATAL:  could not create any TCP/IP sockets",
  ].join("\n");

  it("port in use", () => {
    expect(classifyStartFailure(portTaken)).toBe("port_in_use");
    expect(firstFatalLine(portTaken)).toBe("could not create any TCP/IP sockets");
  });

  it("disk full", () => {
    expect(
      classifyStartFailure("[9] FATAL:  could not write to file \"pg_wal/xlogtemp.9\": No space left on device"),
    ).toBe("disk_full");
  });

  describe("disk full, from what PG 18.6 printed on a full volume", () => {
    it("initdb's own output", () => {
      expect(classifyStartFailure(INITDB_DISK_FULL_OUTPUT)).toBe("disk_full");
      expect(firstFatalLine(INITDB_DISK_FULL_OUTPUT)).toBe('could not write to file "base/4/2615_fsm": No space left on device');
    });

    it("a restart on a full disk: the reason is the startup process's line, which the postmaster's lines alone miss", () => {
      const postmasterOnly = logLinesForPid(RESTART_DISK_FULL_LOG, RESTART_POSTMASTER_PID).join("\n");
      expect(classifyStartFailure(postmasterOnly)).toBe("other");
      expect(firstFatalLine(postmasterOnly)).toBeNull();

      const withChildren = logLinesForPostmaster(RESTART_DISK_FULL_LOG, RESTART_POSTMASTER_PID);
      expect(withChildren.some((line) => line.includes(`[${String(RESTART_STARTUP_PID)}]`))).toBe(true);
      const text = [RESTART_DISK_FULL_STDERR, ...withChildren].join("\n");
      expect(classifyStartFailure(text)).toBe("disk_full");
      expect(firstFatalLine(text)).toBe('could not write to file "pg_wal/xlogtemp.56100": No space left on device');
    });

    it("a running server that fills its disk: the backend's PANIC and recovery's FATAL", () => {
      const lines = logLinesForPostmaster(RUNNING_DISK_FULL_LOG, 55388);
      // The backend (55629) and the startup process (55639) are both named.
      expect(lines.filter((l) => l.includes("[55629]"))).toHaveLength(2);
      expect(lines.filter((l) => l.includes("[55639]"))).toHaveLength(5);
      // 55397 is the first boot's startup process, never named by the postmaster.
      expect(lines.some((l) => l.includes("[55397]"))).toBe(false);
      expect(classifyStartFailure(lines.join("\n"))).toBe("disk_full");
    });

    it("a short write that carries no errno", () => {
      // md.c's message and hint (PG 18.6 src/backend/storage/smgr/md.c).
      const text = [
        '2026-10-17 19:52:30.010 UTC [55629] ERROR:  could not extend file "base/16384/16385": wrote only 4096 of 8192 bytes at block 120',
        "2026-10-17 19:52:30.010 UTC [55629] HINT:  Check free disk space.",
      ].join("\n");
      expect(classifyStartFailure(text)).toBe("disk_full");
    });

    it("Node's errno code and the Windows system message", () => {
      expect(isDiskFullText("ENOSPC: no space left on device, write")).toBe(true);
      expect(isDiskFullText("There is not enough space on the disk.")).toBe(true);
    });
  });

  it("ENOSPC from SysV shared memory or semaphores is a kernel limit, not a full disk", () => {
    expect(isDiskFullText(SHMGET_ENOSPC)).toBe(false);
    expect(isDiskFullText(SEMGET_ENOSPC)).toBe(false);
    expect(classifyStartFailure(SHMGET_ENOSPC)).toBe("other");
    expect(classifyStartFailure(SEMGET_ENOSPC)).toBe("other");
  });

  it("a write that failed for another reason is not a full disk", () => {
    expect(
      classifyStartFailure('2026-10-17 19:52:30.010 UTC [55629] PANIC:  could not write to file "pg_wal/xlogtemp.55629": Input/output error'),
    ).toBe("other");
  });

  it("a lock or shared memory still held by a crashed postmaster's children", () => {
    // Verbatim stderr of a second postmaster on a live data dir.
    expect(
      classifyStartFailure('2026-10-17 11:06:50.295 WAT [77427] FATAL:  lock file "postmaster.pid" already exists'),
    ).toBe("data_dir_busy");
    expect(
      classifyStartFailure("FATAL:  pre-existing shared memory block (key 246755175, ID 8847363) is still in use"),
    ).toBe("data_dir_busy");
  });

  it("anything else", () => {
    expect(classifyStartFailure("FATAL:  data directory has invalid permissions")).toBe("other");
  });

  it("attributes log lines to a PID by its [pid] field only", () => {
    const log = `${portTaken}\n2026-10-17 11:00:00.000 WAT [84790] FATAL:  an older postmaster\n`;
    const ours = logLinesForPid(log, 84792);
    expect(ours).toHaveLength(4);
    expect(logLinesForPid(log, 8479)).toHaveLength(0);
  });
});

describe("pg_controldata", () => {
  it("reads the system identifier", () => {
    const out = "pg_control version number:            1800\nDatabase system identifier:           7697576143254888004\n";
    expect(parseControldataSystemIdentifier(out)).toBe("7697576143254888004");
    expect(parseControldataSystemIdentifier("nothing here")).toBeNull();
  });
});
