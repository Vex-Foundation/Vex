import { describe, expect, it } from "vitest";
import {
  classifyStartFailure,
  firstFatalLine,
  isReadyFor,
  logLinesForPid,
  parseControldataSystemIdentifier,
  parsePostmasterPid,
} from "../native/postgres-facts.js";

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
