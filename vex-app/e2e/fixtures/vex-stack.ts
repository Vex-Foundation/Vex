/**
 * An ISOLATED Vex stack for one end-to-end run: a throwaway Postgres, a
 * throwaway config dir with the password file the app expects, a throwaway
 * projects root, and the environment that points a launched Electron main
 * process at all three.
 *
 * ## Why this exists rather than `composeUp`
 *
 * `vex.docker.composeUp` renders a stack keyed by the config dir's install id
 * and refuses ports another stack already holds, and its `running` result also
 * requires the embeddings runtime on a hard-coded port. A per-run `composeUp`
 * therefore either collides with the developer's live Vex stack or leaves a
 * second Postgres plus a second embeddings runtime behind after every run. So
 * this module starts ONLY a Postgres, under an identity nothing else uses, and
 * hands it to main through the e2e door
 * (`vex-app/src/main/database/e2e-connection-door.ts`).
 *
 * ## What it owns, and what happens on every exit path
 *
 * Ownership is established at ACQUISITION, not after success: each acquired
 * resource is pushed onto a teardown list the moment it exists, so a failure
 * halfway through setup tears down exactly what was acquired. Teardown runs
 * every removal even when an earlier one rejects and reports the failures
 * together (`Promise.allSettled` + `AggregateError`), because a leaked
 * container and a failed run are orthogonal outcomes and neither may hide the
 * other. Pattern adopted from `deepseek-harness`'s ACP snapshot harness
 * (`packages/test-support/acp-snapshot/src/harness.ts`).
 *
 * Testcontainers' Ryuk reaper is the BACKSTOP, not the plan: it removes what
 * this module failed to remove after the process dies, which is what makes an
 * abrupt kill survivable.
 *
 * ## Guards
 *
 * The stack refuses to exist if its Postgres port is the developer's own
 * compose port, or if its identity could be mistaken for a real Vex install's
 * compose project. Both are asserted before anything is published, because the
 * whole point of an isolated stack is that it cannot touch the real one.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DEFAULT_PG_PORT } from "../../src/shared/local-service-ports.js";

/**
 * Same image the repository's integration suite pins
 * (`src/__tests__/integration/setup/globalSetup.ts`). One pin, so an e2e run
 * and an integration run cannot disagree about what "the database" is.
 */
export const E2E_PGVECTOR_IMAGE = "pgvector/pgvector:0.8.2-pg18-trixie";

/**
 * Database and role the app hardcodes in `main/database/db-config.ts`. The
 * container must offer exactly these, because the door supplies only a port
 * and a password file.
 */
export const E2E_DB_NAME = "vex";
export const E2E_DB_USER = "vex";

/** Prefix every resource this module owns carries, so a leak is identifiable. */
export const E2E_IDENTITY_PREFIX = "vex-e2e-";

/**
 * The exact shape {@link makeStackIdentity} mints.
 *
 * This is also what makes the identity provably disjoint from a real install's
 * compose project, which is `vex-` followed by an install UUID
 * (`vex-724bb237-5a0d-4862-ab36-6c4a9d39852e` in this developer's environment).
 * A UUID's first group is EIGHT hex characters, so character 8 of a real
 * project name is always `-` while ours is `e`: no install id, however
 * unlucky, can ever produce a name starting `vex-e2e-`.
 */
const STACK_IDENTITY_PATTERN = /^vex-e2e-[0-9a-f]{12}$/;

/** Relative location of the Postgres password inside a config dir. */
export const PG_PASSWORD_RELATIVE_PATH = path.join("local-infra", "secrets", "pg_password");

/** How long the container may take to accept connections. */
const CONTAINER_START_TIMEOUT_MS = 180_000;

/** One isolated stack's identity and the paths it owns. */
export interface VexIsolatedStack {
  /** `vex-e2e-<hex>`; every owned resource derives from it. */
  readonly identity: string;
  /** Throwaway `VEX_CONFIG_DIR` for this run. */
  readonly configDir: string;
  /** Throwaway projects root, pointed at by `config.json`. */
  readonly projectsRoot: string;
  /** Absolute path of the 0600 password file inside {@link configDir}. */
  readonly pgPasswordPath: string;
  /** Host port the container publishes Postgres on. */
  readonly pgPort: number;
  /**
   * Environment additions for `_electron.launch`. Contains `VEX_CONFIG_DIR`
   * and the two door variables, and nothing else: the door refuses a partial
   * request, so these three travel together or not at all.
   */
  readonly env: Readonly<Record<string, string>>;
}

/** A started stack plus its disposer. */
export interface StartedVexIsolatedStack extends VexIsolatedStack {
  /** Idempotent teardown; safe after a partial start and after a prior call. */
  stop(): Promise<void>;
}

/** Options for one isolated stack. */
export interface StartVexIsolatedStackOptions {
  /** Aborts a start in progress; whatever was acquired is torn down. */
  readonly signal?: AbortSignal;
  /** Parent directory for the generated config dir and projects root. */
  readonly parentDir?: string;
}

/** Mint one run identity. Prefix-stable so a leaked resource names its owner. */
export function makeStackIdentity(): string {
  return `${E2E_IDENTITY_PREFIX}${randomBytes(6).toString("hex")}`;
}

/**
 * Refuse a port that is not an isolated one.
 *
 * The developer's compose Postgres is the specific thing this run must never
 * reach: it holds their real projects. The constant is imported from the
 * product's own source, so a change there moves this guard with it.
 *
 * @throws when the port is the compose default or is not a usable TCP port.
 */
export function assertIsolatedPgPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`vex-stack: ${String(port)} is not a TCP port`);
  }
  if (port === DEFAULT_PG_PORT) {
    throw new Error(
      `vex-stack: refusing port ${port} - that is the developer's own compose Postgres ` +
        "(DEFAULT_PG_PORT). An isolated e2e stack must never bind or address it.",
    );
  }
}

/**
 * Refuse any identity a real Vex install could also carry.
 *
 * Checked rather than assumed: the identity is what every owned resource is
 * named after, so a name a real install's compose project could also produce
 * would make an e2e leak indistinguishable from the developer's own stack -
 * and would make a cleanup sweep dangerous.
 *
 * @throws when the identity is not exactly the shape this module mints.
 */
export function assertIsolatedIdentity(identity: string): void {
  if (!STACK_IDENTITY_PATTERN.test(identity)) {
    throw new Error(
      `vex-stack: identity ${JSON.stringify(identity)} is not an isolated e2e identity ` +
        `(${E2E_IDENTITY_PREFIX}<12 hex>). A real Vex install's compose project is ` +
        "`vex-<install uuid>`, which must never be mistaken for one of ours.",
    );
  }
}

/** Where the password file lives inside a config dir. */
export function pgPasswordPathFor(configDir: string): string {
  return path.join(configDir, PG_PASSWORD_RELATIVE_PATH);
}

/**
 * The config-document version this fixture writes, and the ONLY value the app's
 * config owner accepts.
 *
 * `loadConfig` (`src/config/store.ts`) reads `config.json`, and its FIRST
 * decision is `if (parsed.version !== 1) return defaults` - a document without
 * this key is not merged field by field, it is DISCARDED WHOLE. That is why it
 * is spelled here with this comment rather than left out: the fixture used to
 * write `{ "projectsRoot": "/tmp/vex-e2e-<id>-projects" }` and no more, so every
 * "isolated" run fell back to `DEFAULT_PROJECTS_ROOT` and created real project
 * folders in the developer's `~/Vex/projects`. The run was isolated in its
 * database, its config dir and its ports, and not in the one directory a user
 * would notice.
 */
const ISOLATED_CONFIG_VERSION = 1;

/**
 * The `config.json` an isolated run writes: the version the app's config owner
 * requires plus the projects-root override, and nothing else, so the run
 * exercises the real resolver (`main/paths/config-dir.ts` ->
 * `resolveProjectsRootPath`) instead of a product code path added for tests.
 */
export function isolatedConfigJson(projectsRoot: string): string {
  return `${JSON.stringify({ version: ISOLATED_CONFIG_VERSION, projectsRoot }, null, 2)}\n`;
}

/** The three environment values a launched main process needs. */
export function stackEnv(stack: {
  readonly configDir: string;
  readonly pgPasswordPath: string;
  readonly pgPort: number;
}): Record<string, string> {
  return {
    VEX_CONFIG_DIR: stack.configDir,
    VEX_E2E_DB_PORT: String(stack.pgPort),
    VEX_E2E_DB_PASSWORD_FILE: stack.pgPasswordPath,
  };
}

/**
 * Start one isolated stack.
 *
 * Every acquisition registers its own removal before the next step runs, so an
 * abort or a throw at any point leaves nothing behind. On failure the caller
 * gets the original error; teardown failures are aggregated with it.
 */
export async function startVexIsolatedStack(
  options: StartVexIsolatedStackOptions = {},
): Promise<StartedVexIsolatedStack> {
  const identity = makeStackIdentity();
  assertIsolatedIdentity(identity);

  const parent = options.parentDir ?? tmpdir();
  const configDir = path.join(parent, `${identity}-config`);
  const projectsRoot = path.join(parent, `${identity}-projects`);
  const pgPasswordPath = pgPasswordPathFor(configDir);

  const teardowns: Array<{ what: string; run: () => Promise<unknown> }> = [];
  let container: StartedPostgreSqlContainer | undefined;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const results = await Promise.allSettled(
      // Reverse acquisition order: the container first, then the directories
      // whose contents it was reading.
      [...teardowns].reverse().map(async (teardown) => {
        try {
          await teardown.run();
        } catch (cause) {
          throw new Error(`vex-stack: failed to remove ${teardown.what}`, { cause });
        }
      }),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(failures, "vex-stack: teardown failed");
    }
  };

  /** Abort as a first-class exit: check between acquisitions, not only at the end. */
  const checkAborted = (): void => {
    options.signal?.throwIfAborted();
  };

  try {
    checkAborted();

    await mkdir(path.dirname(pgPasswordPath), { recursive: true });
    teardowns.push({ what: configDir, run: () => rm(configDir, { recursive: true, force: true }) });
    await mkdir(projectsRoot, { recursive: true });
    teardowns.push({
      what: projectsRoot,
      run: () => rm(projectsRoot, { recursive: true, force: true }),
    });
    checkAborted();

    const password = randomBytes(32).toString("base64url");
    // 0600 because the door refuses a group- or world-accessible secret, which
    // is the same standard `main/compose/render.ts` holds the real one to.
    await writeFile(pgPasswordPath, password, { encoding: "utf8", mode: 0o600 });
    await writeFile(path.join(configDir, "config.json"), isolatedConfigJson(projectsRoot), "utf8");
    checkAborted();

    container = await new PostgreSqlContainer(E2E_PGVECTOR_IMAGE)
      .withDatabase(E2E_DB_NAME)
      .withUsername(E2E_DB_USER)
      .withPassword(password)
      // Name AND label the container after the run. Without a name docker
      // assigns a random one, and a container that leaks past both this
      // teardown and Ryuk would then be unattributable.
      .withName(`${identity}-db`)
      .withLabels({ "ai.projectvex.e2e": identity })
      .withStartupTimeout(CONTAINER_START_TIMEOUT_MS)
      .start();
    const started = container;
    teardowns.push({ what: `container ${started.getId()}`, run: () => started.stop() });
    checkAborted();

    const pgPort = started.getMappedPort(5432);
    // The guard runs on the port the container ACTUALLY published, not on a
    // request: a mapped port is assigned by the daemon, so this is the only
    // moment the real value is knowable.
    assertIsolatedPgPort(pgPort);

    return {
      identity,
      configDir,
      projectsRoot,
      pgPasswordPath,
      pgPort,
      env: stackEnv({ configDir, pgPasswordPath, pgPort }),
      stop,
    };
  } catch (cause) {
    try {
      await stop();
    } catch (teardownFailure) {
      throw new AggregateError(
        [cause, teardownFailure],
        "vex-stack: start failed and teardown failed",
      );
    }
    throw cause;
  }
}
