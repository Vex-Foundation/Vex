/**
 * The e2e database door decides who may publish a database connection outside
 * the compose path. Every branch is asserted here because each one is a guard
 * on real authority: a wrong `publish` points the whole app at a database
 * nobody chose, and a wrong `inert` makes an e2e run silently prove nothing.
 *
 * The pure decision is driven directly; the wired opener is driven through the
 * real `connection-state.ts` seam (electron, fs and the logger are the only
 * mocked boundaries) so the publication, the loud line and the overwrite
 * watcher are observed as a caller would see them.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PG_PORT } from "../../../shared/local-service-ports.js";
import {
  decideE2eConnectionDoor,
  inspectPasswordFileOnDisk,
  E2E_DB_PASSWORD_FILE_ENV,
  E2E_DB_PORT_ENV,
  type E2eDoorInput,
  type E2ePasswordFileFacts,
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
    ...overrides,
  };
}

describe("decideE2eConnectionDoor", () => {
  it("publishes the requested connection when every guard passes", () => {
    expect(decideE2eConnectionDoor(input())).toEqual({
      kind: "publish",
      connection: { pgPort: E2E_PORT, pgPasswordPath: PASSWORD_PATH },
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

  it("refuses the developer's own compose Postgres port", () => {
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
    return { open: door.openE2eConnectionDoor, state };
  }

  it("publishes through setDbConnection and says so loudly, once", async () => {
    const passwordPath = writeSecretFile("s3cret-value");
    process.env[E2E_DB_PORT_ENV] = String(E2E_PORT);
    process.env[E2E_DB_PASSWORD_FILE_ENV] = passwordPath;

    const { open, state } = await load();
    const dispose = open();

    expect(state.getDbConnection()).toEqual({ pgPort: E2E_PORT, pgPasswordPath: passwordPath });
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
    state.setDbConnection({ pgPort: DEFAULT_PG_PORT, pgPasswordPath: "/elsewhere/pg_password" });

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

  it("refuses a real group-readable password file on disk", async () => {
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

  it("refuses the developer's compose port through the wired path too", async () => {
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
});
