import { describe, expect, it } from "vitest";
import {
  DARWIN_WAL_SYNC_METHOD,
  renderVexConfBlock,
  VEX_CONF_BEGIN,
  VEX_CONF_END,
  VEX_PG_HBA,
  withVexConfBlock,
} from "../native/postgres-conf.js";

const INITDB_CONF = "max_connections = 100\nshared_buffers = 128MB\n#port = 5432\n";

function settings(block: string): string[] {
  return block.split("\n").filter((line) => line.length > 0 && !line.startsWith("#"));
}

describe("the Vex postgresql.conf block", () => {
  it("carries the 6.3 settings, the TCP-only listener and never a port", () => {
    const lines = settings(renderVexConfBlock("linux"));
    expect(lines).toContain("listen_addresses = '127.0.0.1'");
    expect(lines).toContain("unix_socket_directories = ''");
    expect(lines).toContain("max_connections = 40");
    expect(lines).toContain("wal_level = minimal");
    expect(lines).toContain("logging_collector = on");
    expect(lines).toContain("log_line_prefix = '%m [%p] '");
    expect(lines.some((line) => /^port\s*=/.test(line))).toBe(false);
  });

  it("sets wal_sync_method on macOS only", () => {
    expect(settings(renderVexConfBlock("darwin"))).toContain(`wal_sync_method = ${DARWIN_WAL_SYNC_METHOD}`);
    expect(DARWIN_WAL_SYNC_METHOD).toBe("fsync_writethrough");
    for (const platform of ["linux", "win32"] as const) {
      expect(renderVexConfBlock(platform)).not.toMatch(/wal_sync_method/);
    }
  });

  it("appends after initdb's lines, so the block's values win", () => {
    const out = withVexConfBlock(INITDB_CONF, "linux");
    expect(out.startsWith(INITDB_CONF)).toBe(true);
    expect(out.lastIndexOf("max_connections = 40")).toBeGreaterThan(out.indexOf("max_connections = 100"));
  });

  it("is idempotent: re-running replaces the block and never stacks a second one", () => {
    const once = withVexConfBlock(INITDB_CONF, "darwin");
    const twice = withVexConfBlock(once, "darwin");
    expect(twice).toBe(once);
    expect(twice.split(VEX_CONF_BEGIN)).toHaveLength(2);
  });

  it("replaces an outdated block in place and keeps what follows it", () => {
    const stale = `${INITDB_CONF}\n${VEX_CONF_BEGIN}\nmax_connections = 7\n${VEX_CONF_END}\nuser_tail = 1\n`;
    const out = withVexConfBlock(stale, "linux");
    expect(out).not.toMatch(/max_connections = 7/);
    expect(out).toMatch(/user_tail = 1\n$/);
    expect(out.split(VEX_CONF_BEGIN)).toHaveLength(2);
  });

  it("treats a begin marker with no end (a torn write) as a block running to the end", () => {
    const torn = `${INITDB_CONF}\n${VEX_CONF_BEGIN}\nmax_conn`;
    const out = withVexConfBlock(torn, "linux");
    expect(out).toBe(`${INITDB_CONF}\n${renderVexConfBlock("linux")}`);
  });

  it("appends to a file with no trailing newline without gluing lines together", () => {
    const out = withVexConfBlock("a = 1", "linux");
    expect(out.startsWith("a = 1\n\n" + VEX_CONF_BEGIN)).toBe(true);
  });
});

describe("pg_hba.conf", () => {
  it("is exactly the two 6.4 rules: vex over loopback TCP with SCRAM", () => {
    expect(settings(VEX_PG_HBA)).toEqual([
      "host  all  vex  127.0.0.1/32  scram-sha-256",
      "host  all  vex  ::1/128       scram-sha-256",
    ]);
  });
});
