/**
 * The isolated-stack guards, asserted without Docker.
 *
 * These are the checks that stand between an e2e run and the developer's real
 * Vex install. They are pure decisions on purpose: a guard that only runs when
 * a container happens to start is a guard nobody can trust, so each one is
 * exercised here directly, in the same lane the stack itself runs in.
 *
 * The container path, the password file layout and teardown are proven by the
 * runs that actually use the fixture (`./vex-app-with-database.ts`).
 */

import path from "node:path";
import { test, expect } from "@playwright/test";
import { DEFAULT_PG_PORT } from "../../src/shared/local-service-ports.js";
import {
  assertIsolatedIdentity,
  assertIsolatedPgPort,
  isolatedConfigJson,
  makeStackIdentity,
  pgPasswordPathFor,
  stackEnv,
  E2E_IDENTITY_PREFIX,
  PG_PASSWORD_RELATIVE_PATH,
} from "./vex-stack.js";

test.describe("isolated stack guards", () => {
  test("refuses the developer's own compose Postgres port", () => {
    expect(() => assertIsolatedPgPort(DEFAULT_PG_PORT)).toThrow(/refusing port/);
  });

  test("accepts an ordinary ephemeral port", () => {
    expect(() => assertIsolatedPgPort(49_501)).not.toThrow();
  });

  test("refuses values that are not TCP ports", () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(() => assertIsolatedPgPort(port), `port ${port}`).toThrow(/not a TCP port/);
    }
  });

  test("refuses anything that is not exactly an e2e identity", () => {
    // The first is the REAL compose project name of the developer stack this
    // worktree runs beside; the rest are near misses.
    for (const identity of [
      "vex-724bb237-5a0d-4862-ab36-6c4a9d39852e",
      "vex",
      "vex-e2e-",
      "vex-e2e-notthexatall",
      "vex-e2e-f3a7ce6ba1db-db",
      " vex-e2e-f3a7ce6ba1db",
    ]) {
      expect(() => assertIsolatedIdentity(identity), identity).toThrow(/not an isolated e2e identity/);
    }
  });

  test("mints identities that are prefixed, unique, and never dev-shaped", () => {
    const first = makeStackIdentity();
    const second = makeStackIdentity();
    expect(first).not.toBe(second);
    for (const identity of [first, second]) {
      expect(identity.startsWith(E2E_IDENTITY_PREFIX)).toBe(true);
      expect(() => assertIsolatedIdentity(identity)).not.toThrow();
    }
  });
});

test.describe("isolated stack layout", () => {
  test("puts the password where the compose stack would have put it", () => {
    expect(pgPasswordPathFor("/tmp/run-config")).toBe(
      path.join("/tmp/run-config", PG_PASSWORD_RELATIVE_PATH),
    );
    // The layout the app reads is `<configDir>/local-infra/secrets/pg_password`
    // (`main/compose/render.ts`); a drift here silently un-isolates a run.
    expect(PG_PASSWORD_RELATIVE_PATH).toBe(path.join("local-infra", "secrets", "pg_password"));
  });

  test("writes a document the app's config owner accepts, carrying the override", () => {
    const parsed = JSON.parse(isolatedConfigJson("/tmp/run-projects")) as Record<string, unknown>;
    // `version: 1` is not decoration. `loadConfig` (`src/config/store.ts`)
    // DISCARDS a document whose version is anything else and returns the
    // shipped defaults, which is how an "isolated" run ended up creating
    // projects in the developer's `~/Vex/projects`. The override and the
    // version travel together or the override does not exist.
    expect(parsed).toEqual({ version: 1, projectsRoot: "/tmp/run-projects" });
  });

  test("hands main all three door values together, and nothing else", () => {
    const env = stackEnv({
      configDir: "/tmp/run-config",
      pgPasswordPath: "/tmp/run-config/local-infra/secrets/pg_password",
      pgPort: 49_501,
    });
    expect(env).toEqual({
      VEX_CONFIG_DIR: "/tmp/run-config",
      VEX_E2E_DB_PORT: "49501",
      VEX_E2E_DB_PASSWORD_FILE: "/tmp/run-config/local-infra/secrets/pg_password",
    });
  });
});
