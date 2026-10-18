/**
 * The e2e database door decides who may publish a database connection besides
 * the native runtime host. Every branch is asserted here because each one is a guard
 * on real authority: a wrong `publish` points the whole app at a database
 * nobody chose, and a wrong `inert` makes an e2e run silently prove nothing.
 *
 * The pure decision is driven directly; the wired opener is driven through the
 * real `connection-state.ts` seam (electron, fs and the logger are the only
 * mocked boundaries) so the publication, the loud line and the overwrite
 * watcher are observed as a caller would see them.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PG_PORT } from "../../../shared/local-service-ports.js";
import {
  decideE2eConnectionDoor,
  inspectPasswordFileOnDisk,
  inspectRunningNativeCluster,
  resolveE2eDoorRuntimeDirs,
  runningNativeClustersIn,
  E2E_DB_PASSWORD_FILE_ENV,
  E2E_DB_PORT_ENV,
  type E2eDoorInput,
  type E2ePasswordFileFacts,
  type RunningNativeCluster,
} from "../e2e-connection-door.js";

const GOOD_FILE: E2ePasswordFileFacts = {
  isRegularFile: true,
  mode: 0o100600,
  trimmedLength: 43,
};

const E2E_PORT = 55_433;
const PASSWORD_PATH = "/tmp/vex-e2e-run/local-infra/secrets/pg_password";

function input(overrides: Partial<E2eDoorInput> = {}): E2eDoorInput {
  return {
    packaged: false,
    platform: "linux",
    connectionAlreadyPublished: false,
    env: {
      [E2E_DB_PORT_ENV]: String(E2E_PORT),
      [E2E_DB_PASSWORD_FILE_ENV]: PASSWORD_PATH,
    },
    inspectPasswordFile: () => GOOD_FILE,
    runningNativeClusters: [],
    ...overrides,
  };
}

describe("decideE2eConnectionDoor", () => {
  it("publishes the requested connection when every guard passes", () => {
    expect(decideE2eConnectionDoor(input())).toEqual({
      kind: "publish",
      connection: { host: "127.0.0.1", pgPort: E2E_PORT, pgPasswordPath: PASSWORD_PATH },
    });
  });

  it("is inert in a packaged build even with a complete, valid request", () => {
    expect(decideE2eConnectionDoor(input({ packaged: true }))).toEqual({
      kind: "inert",
      reason: "packaged",
    });
  });

  it("is inert, not refusing, when neither variable is set", () => {
    expect(decideE2eConnectionDoor(input({ env: {} }))).toEqual({
      kind: "inert",
      reason: "not_requested",
    });
  });

  it.each([
    ["port only", { [E2E_DB_PORT_ENV]: String(E2E_PORT) }],
    ["password file only", { [E2E_DB_PASSWORD_FILE_ENV]: PASSWORD_PATH }],
    ["empty port with a password file", {
      [E2E_DB_PORT_ENV]: "",
      [E2E_DB_PASSWORD_FILE_ENV]: PASSWORD_PATH,
    }],
  ])("refuses a partial configuration: %s", (_name, env) => {
    const decision = decideE2eConnectionDoor(input({ env }));
    expect(decision).toMatchObject({ kind: "refused", reason: "partial_configuration" });
  });

  it.each(["0", "65536", "not-a-port", "5432 ", "0x1234", "-1", "55433.0"])(
    "refuses the non-port value %j",
    (rawPort) => {
      const decision = decideE2eConnectionDoor(
        input({ env: { [E2E_DB_PORT_ENV]: rawPort, [E2E_DB_PASSWORD_FILE_ENV]: PASSWORD_PATH } }),
      );
      expect(decision).toMatchObject({ kind: "refused", reason: "invalid_port" });
    },
  );

  const DEVELOPER_RUNTIME = "/home/dev/.config/vex/runtime";
  const developerCluster = (port: number | null): RunningNativeCluster => ({
    owner: "developer_install",
    runtimeDir: DEVELOPER_RUNTIME,
    pid: 4242,
    port,
  });

  it("refuses the port the developer's own native runtime is serving on", () => {
    const decision = decideE2eConnectionDoor(input({ runningNativeClusters: [developerCluster(E2E_PORT)] }));
    expect(decision).toMatchObject({ kind: "refused", reason: "dev_port_collision" });
    expect(decision).toMatchObject({ detail: expect.stringContaining(DEVELOPER_RUNTIME) });
  });

  it("publishes beside a developer runtime that serves on another port", () => {
    const decision = decideE2eConnectionDoor(input({ runningNativeClusters: [developerCluster(E2E_PORT + 1)] }));
    expect(decision).toMatchObject({ kind: "publish" });
  });

  it("refuses while the developer's runtime is alive but has not written its port", () => {
    const decision = decideE2eConnectionDoor(input({ runningNativeClusters: [developerCluster(null)] }));
    expect(decision).toMatchObject({ kind: "refused", reason: "dev_runtime_port_unknown" });
  });

  it("refuses while this run's own config dir has a running native cluster, whatever its port", () => {
    const decision = decideE2eConnectionDoor(
      input({
        runningNativeClusters: [{ owner: "this_run", runtimeDir: "/tmp/run-config/runtime", pid: 77, port: E2E_PORT + 9 }],
      }),
    );
    expect(decision).toMatchObject({ kind: "refused", reason: "config_dir_runtime_running" });
  });

  it("checks the ports before the password file, so a collision is the reported reason", () => {
    const decision = decideE2eConnectionDoor(
      input({ runningNativeClusters: [developerCluster(E2E_PORT)], inspectPasswordFile: () => null }),
    );
    expect(decision).toMatchObject({ kind: "refused", reason: "dev_port_collision" });
  });

  it("refuses the previous release's Docker Postgres port", () => {
    const decision = decideE2eConnectionDoor(
      input({
        env: {
          [E2E_DB_PORT_ENV]: String(DEFAULT_PG_PORT),
          [E2E_DB_PASSWORD_FILE_ENV]: PASSWORD_PATH,
        },
      }),
    );
    expect(decision).toMatchObject({ kind: "refused", reason: "dev_port_collision" });
    // The refusal must name the real constant, not a number this test invented.
    expect(decision).toMatchObject({ detail: expect.stringContaining(String(DEFAULT_PG_PORT)) });
  });

  it("refuses an uninspectable password file", () => {
    expect(decideE2eConnectionDoor(input({ inspectPasswordFile: () => null }))).toMatchObject({
      kind: "refused",
      reason: "password_file_missing",
    });
  });

  it("refuses a password path that is not a regular file", () => {
    const decision = decideE2eConnectionDoor(
      input({ inspectPasswordFile: () => ({ ...GOOD_FILE, isRegularFile: false }) }),
    );
    expect(decision).toMatchObject({ kind: "refused", reason: "password_file_not_regular" });
  });

  it("refuses a group- or world-accessible password file on POSIX", () => {
    for (const mode of [0o100640, 0o100604, 0o100666]) {
      expect(
        decideE2eConnectionDoor(input({ inspectPasswordFile: () => ({ ...GOOD_FILE, mode }) })),
      ).toMatchObject({ kind: "refused", reason: "password_file_mode" });
    }
  });

  it("does not apply the POSIX mode guard on win32, where those bits mean nothing", () => {
    const decision = decideE2eConnectionDoor(
      input({ platform: "win32", inspectPasswordFile: () => ({ ...GOOD_FILE, mode: 0o100666 }) }),
    );
    expect(decision).toMatchObject({ kind: "publish" });
  });

  it("refuses an empty password file", () => {
    expect(
      decideE2eConnectionDoor(input({ inspectPasswordFile: () => ({ ...GOOD_FILE, trimmedLength: 0 }) })),
    ).toMatchObject({ kind: "refused", reason: "password_file_empty" });
  });

  it("never displaces a connection that is already published", () => {
    expect(decideE2eConnectionDoor(input({ connectionAlreadyPublished: true }))).toMatchObject({
      kind: "refused",
      reason: "connection_already_published",
    });
  });
});

describe("inspectPasswordFileOnDisk", () => {
  it("reports null for a path that does not exist", () => {
    expect(inspectPasswordFileOnDisk("/nonexistent/vex-e2e/pg_password")).toBeNull();
  });

  it("reports a directory as a non-regular file rather than as absent", () => {
    const facts = inspectPasswordFileOnDisk(process.cwd());
    expect(facts).toMatchObject({ isRegularFile: false });
  });
});

/** A runtime dir whose cluster's postmaster.pid says `pid` serves on `port` (PG 18 layout). */
function runtimeDirWithPidFile(root: string, pid: number, port: number | null): string {
  const dataDir = path.join(root, "pg18");
  mkdirSync(dataDir, { recursive: true });
  const lines = [String(pid), dataDir, "1760000000", port === null ? "" : String(port), "", "127.0.0.1", "  1234 5678", "ready", ""];
  writeFileSync(path.join(dataDir, "postmaster.pid"), lines.join("\n"));
  return root;
}

describe("the developer's native runtime, as the door reads it", () => {
  const roots: string[] = [];
  const tempRuntimeDir = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), "vex-e2e-door-runtime-"));
    roots.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reports a live postmaster's pid and port", () => {
    const dir = runtimeDirWithPidFile(tempRuntimeDir(), process.pid, 61_234);
    expect(inspectRunningNativeCluster(dir)).toEqual({ pid: process.pid, port: 61_234 });
  });

  it("reports a live postmaster whose port line is not written yet with a null port", () => {
    const dir = runtimeDirWithPidFile(tempRuntimeDir(), process.pid, null);
    expect(inspectRunningNativeCluster(dir)).toEqual({ pid: process.pid, port: null });
  });

  it("ignores a pid file left by a postmaster that is gone, a missing one and garbage", () => {
    const stale = runtimeDirWithPidFile(tempRuntimeDir(), 4242, 61_234);
    expect(inspectRunningNativeCluster(stale, () => false)).toBeNull();
    expect(inspectRunningNativeCluster(tempRuntimeDir())).toBeNull();
    const garbage = tempRuntimeDir();
    mkdirSync(path.join(garbage, "pg18"));
    writeFileSync(path.join(garbage, "pg18", "postmaster.pid"), "not a pid file\n");
    expect(inspectRunningNativeCluster(garbage)).toBeNull();
  });

  it("names both dirs, and one running cluster once when they are the same dir", () => {
    const developerInstall = runtimeDirWithPidFile(tempRuntimeDir(), process.pid, 61_234);
    const thisRun = runtimeDirWithPidFile(tempRuntimeDir(), process.pid, 61_235);
    expect(runningNativeClustersIn({ developerInstall, thisRun })).toEqual([
      { owner: "this_run", runtimeDir: thisRun, pid: process.pid, port: 61_235 },
      { owner: "developer_install", runtimeDir: developerInstall, pid: process.pid, port: 61_234 },
    ]);
    expect(runningNativeClustersIn({ developerInstall, thisRun: developerInstall })).toEqual([
      { owner: "this_run", runtimeDir: developerInstall, pid: process.pid, port: 61_234 },
    ]);
  });

  it("resolves the developer's runtime dir without VEX_CONFIG_DIR and this run's with it", () => {
    expect(
      resolveE2eDoorRuntimeDirs({ platform: "darwin", homedir: "/Users/dev", env: { VEX_CONFIG_DIR: "/tmp/vex-e2e-x-config" } }),
    ).toEqual({
      developerInstall: "/Users/dev/Library/Application Support/vex/runtime",
      thisRun: "/tmp/vex-e2e-x-config/runtime",
    });
    expect(resolveE2eDoorRuntimeDirs({ platform: "linux", homedir: "/home/dev", env: {} })).toEqual({
      developerInstall: "/home/dev/.config/vex/runtime",
      thisRun: "/home/dev/.config/vex/runtime",
    });
    expect(
      resolveE2eDoorRuntimeDirs({
        platform: "win32",
        homedir: "C:\\Users\\dev",
        env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local", VEX_CONFIG_DIR: "C:\\Temp\\vex-e2e-config" },
      }),
    ).toEqual({
      developerInstall: "C:\\Users\\dev\\AppData\\Local\\vex\\runtime",
      thisRun: "C:\\Temp\\vex-e2e-config\\runtime",
    });
  });
});

/**
 * The wired opener, driven against the real connection-state seam. Modules are
 * re-imported per case because `connection-state.ts` holds process-wide state
 * and `app.isPackaged` is read at open time.
 */
describe("openE2eConnectionDoor", () => {
  const packaged = { value: false };
  const logged: Array<{ level: string; message: string }> = [];
  const secretDirs: string[] = [];

  /** Write a password file the door will accept (or, with `mode`, reject). */
  function writeSecretFile(content: string, mode = 0o600): string {
    const dir = mkdtemp();
    const file = path.join(dir, "pg_password");
    writeFileSync(file, content, { mode });
    return file;
  }

  function mkdtemp(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "vex-e2e-door-"));
    secretDirs.push(dir);
    return dir;
  }

  afterAll(() => {
    for (const dir of secretDirs) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.resetModules();
    packaged.value = false;
    logged.length = 0;
    delete process.env[E2E_DB_PORT_ENV];
    delete process.env[E2E_DB_PASSWORD_FILE_ENV];
    vi.doMock("electron", () => ({ app: { get isPackaged() { return packaged.value; } } }));
    vi.doMock("../../logger/index.js", () => ({
      log: {
        error: (...a: unknown[]) => logged.push({ level: "error", message: a.join(" ") }),
        warn: (...a: unknown[]) => logged.push({ level: "warn", message: a.join(" ") }),
        info: (...a: unknown[]) => logged.push({ level: "info", message: a.join(" ") }),
        debug: (...a: unknown[]) => logged.push({ level: "debug", message: a.join(" ") }),
      },
    }));
  });

  afterEach(() => {
    delete process.env[E2E_DB_PORT_ENV];
    delete process.env[E2E_DB_PASSWORD_FILE_ENV];
    vi.doUnmock("electron");
    vi.doUnmock("../../logger/index.js");
  });

  async function load(): Promise<{
    open: typeof import("../e2e-connection-door.js").openE2eConnectionDoor;
    state: typeof import("../connection-state.js");
  }> {
    const state = await import("../connection-state.js");
    const door = await import("../e2e-connection-door.js");
    // Hermetic by default: two empty runtime dirs, never this machine's real
    // ones, where a developer's running Vex would change the outcome.
    const empty = { developerInstall: mkdtemp(), thisRun: mkdtemp() };
    return { open: (options) => door.openE2eConnectionDoor(options ?? { runtimeDirs: empty }), state };
  }

  it("publishes through setDbConnection and says so loudly, once", async () => {
    const passwordPath = writeSecretFile("s3cret-value");
    process.env[E2E_DB_PORT_ENV] = String(E2E_PORT);
    process.env[E2E_DB_PASSWORD_FILE_ENV] = passwordPath;

    const { open, state } = await load();
    const dispose = open();

    expect(state.getDbConnection()).toEqual({ host: "127.0.0.1", pgPort: E2E_PORT, pgPasswordPath: passwordPath });
    const loud = logged.filter((entry) => entry.message.includes("[db:e2e-door] OPEN"));
    expect(loud).toHaveLength(1);
    expect(loud[0]?.message).toContain(String(E2E_PORT));
    // The secret itself never reaches the log.
    expect(logged.some((entry) => entry.message.includes("s3cret-value"))).toBe(false);

    dispose();
    state.setDbConnection(null);
  });

  it("warns loudly when a later writer replaces the e2e connection", async () => {
    const passwordPath = writeSecretFile("s3cret-value");
    process.env[E2E_DB_PORT_ENV] = String(E2E_PORT);
    process.env[E2E_DB_PASSWORD_FILE_ENV] = passwordPath;

    const { open, state } = await load();
    const dispose = open();
    state.setDbConnection({ host: "127.0.0.1", pgPort: DEFAULT_PG_PORT, pgPasswordPath: "/elsewhere/pg_password" });

    expect(
      logged.some((entry) => entry.level === "warn" && entry.message.includes("was replaced by")),
    ).toBe(true);

    // Disposal is the caller's; after it, a further write is not reported.
    dispose();
    logged.length = 0;
    state.setDbConnection(null);
    expect(logged).toEqual([]);
  });

  it("publishes nothing and logs an error when the request is partial", async () => {
    process.env[E2E_DB_PORT_ENV] = String(E2E_PORT);

    const { open, state } = await load();
    const dispose = open();

    expect(state.getDbConnection()).toBeNull();
    expect(
      logged.some(
        (entry) => entry.level === "error" && entry.message.includes("REFUSED (partial_configuration)"),
      ),
    ).toBe(true);
    dispose();
  });

  it("publishes nothing in a packaged build", async () => {
    process.env[E2E_DB_PORT_ENV] = String(E2E_PORT);
    process.env[E2E_DB_PASSWORD_FILE_ENV] = writeSecretFile("s3cret-value");
    packaged.value = true;

    const { open, state } = await load();
    const dispose = open();

    expect(state.getDbConnection()).toBeNull();
    expect(logged.some((entry) => entry.message.includes("OPEN"))).toBe(false);
    dispose();
  });

  /**
   * The premise is a REAL group-readable file, and only a POSIX kernel can
   * create one: `chmod 0o644` on Windows leaves 0o666 and the door
   * deliberately skips the mode guard there (`e2e-connection-door.ts`, the
   * `input.platform !== "win32"` branch), so on win32 this would assert that
   * a documented no-op refuses - which it must not.
   *
   * The win32 row of that policy is proved deterministically by "does not
   * apply the POSIX mode guard on win32, where those bits mean nothing"
   * above, which injects the platform instead of reading the runner's.
   *
   * `it.skipIf` rather than a bare early return: a skipped test is visible in
   * the reporter, an early return reports as PASSING.
   */
  it.skipIf(process.platform === "win32")("refuses a real group-readable password file on disk", async () => {
    process.env[E2E_DB_PORT_ENV] = String(E2E_PORT);
    process.env[E2E_DB_PASSWORD_FILE_ENV] = writeSecretFile("s3cret-value", 0o644);

    const { open, state } = await load();
    const dispose = open();

    expect(state.getDbConnection()).toBeNull();
    expect(logged.some((entry) => entry.message.includes("REFUSED (password_file_mode)"))).toBe(true);
    dispose();
  });

  it("refuses a password file that is not there", async () => {
    process.env[E2E_DB_PORT_ENV] = String(E2E_PORT);
    process.env[E2E_DB_PASSWORD_FILE_ENV] = path.join(mkdtemp(), "absent", "pg_password");

    const { open, state } = await load();
    const dispose = open();

    expect(state.getDbConnection()).toBeNull();
    expect(logged.some((entry) => entry.message.includes("REFUSED (password_file_missing)"))).toBe(true);
    dispose();
  });

  it("refuses the previous release's Docker port through the wired path too", async () => {
    process.env[E2E_DB_PORT_ENV] = String(DEFAULT_PG_PORT);
    process.env[E2E_DB_PASSWORD_FILE_ENV] = writeSecretFile("s3cret-value");

    const { open, state } = await load();
    const dispose = open();

    expect(state.getDbConnection()).toBeNull();
    expect(
      logged.some((entry) => entry.message.includes("REFUSED (dev_port_collision)")),
    ).toBe(true);
    dispose();
  });

  it("refuses the port a running developer runtime serves on, read from its postmaster.pid", async () => {
    process.env[E2E_DB_PORT_ENV] = String(E2E_PORT);
    process.env[E2E_DB_PASSWORD_FILE_ENV] = writeSecretFile("s3cret-value");
    const developerInstall = runtimeDirWithPidFile(mkdtemp(), process.pid, E2E_PORT);

    const { open, state } = await load();
    const dispose = open({ runtimeDirs: { developerInstall, thisRun: mkdtemp() } });

    expect(state.getDbConnection()).toBeNull();
    expect(logged.some((entry) => entry.message.includes("REFUSED (dev_port_collision)"))).toBe(true);
    dispose();
  });

  it("reads no runtime dir in a packaged build", async () => {
    process.env[E2E_DB_PORT_ENV] = String(E2E_PORT);
    process.env[E2E_DB_PASSWORD_FILE_ENV] = writeSecretFile("s3cret-value");
    packaged.value = true;
    // A dir that would refuse if it were read: the packaged guard comes first.
    const thisRun = runtimeDirWithPidFile(mkdtemp(), process.pid, E2E_PORT);

    const { open, state } = await load();
    const dispose = open({ runtimeDirs: { developerInstall: mkdtemp(), thisRun } });

    expect(state.getDbConnection()).toBeNull();
    expect(logged.some((entry) => entry.message.includes("REFUSED"))).toBe(false);
    dispose();
  });
});
