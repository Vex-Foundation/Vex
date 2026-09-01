/**
 * The Playwright fixture for a Studio journey that needs a DATABASE: an
 * isolated Postgres (`./vex-stack.ts`), the built Electron app launched
 * against it through the e2e door, and the schema migrated by the app itself.
 *
 * Two deliberate choices:
 *
 *   - MIGRATIONS RUN THROUGH THE APP (`window.vex.database.migrate()`), not
 *     through a test-side migration runner. What a Studio spec then reads is
 *     the schema the product's own migration path produces; a second runner
 *     here would be a second source of truth and could pass while the shipped
 *     one is broken.
 *   - THE STACK OUTLIVES NO TEST. Setup and teardown are one fixture, so an
 *     assertion failure, a timeout and an interrupt all reach the same
 *     teardown. Container removal is attempted first and its failure is
 *     reported, never swallowed; testcontainers' Ryuk reaper remains the
 *     backstop for a process that dies before teardown runs.
 */

import { test as base, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { MAIN_BUNDLE, selectShellWindow } from "./electron-app.js";
import { startVexIsolatedStack, type StartedVexIsolatedStack } from "./vex-stack.js";

/** Migration of a fresh database is minutes-scale work in the worst case. */
const MIGRATE_TIMEOUT_MS = 300_000;

/** The result shape `vex.database.migrate` answers with. */
type MigrateOutcome =
  | { ok: true; value: { kind: "applied" | "noop" } }
  | { ok: false; error: { code: string; message: string } };

export interface VexDatabaseFixture {
  readonly app: ElectronApplication;
  readonly shell: Page;
  readonly stack: StartedVexIsolatedStack;
  /** The migration result the app reported, proving the schema is real. */
  readonly migrated: MigrateOutcome;
}

/**
 * Drive the app's own migration handler and return its Result verbatim.
 *
 * Exported because a spec may want to re-run it (the handler is single-flight
 * and idempotent) after a reload.
 */
export async function migrateThroughApp(shell: Page): Promise<MigrateOutcome> {
  return shell.evaluate(
    async () =>
      (await (window as unknown as {
        vex: { database: { migrate(): Promise<MigrateOutcome> } };
      }).vex.database.migrate()) as MigrateOutcome,
  );
}

/**
 * Pulling an image, starting Postgres, launching Electron and migrating a
 * fresh schema does not fit the suite's 30s per-test budget. A fixture-scoped
 * timeout is the right instrument: Playwright budgets it separately from the
 * test body, so a spec still fails fast on its OWN assertions while setup and
 * teardown get the wall clock they genuinely need.
 */
const FIXTURE_TIMEOUT_MS = 600_000;

export const test = base.extend<{ vexDb: VexDatabaseFixture }>({
  vexDb: [async ({}, use) => {
    const stack = await startVexIsolatedStack();
    let app: ElectronApplication | undefined;
    try {
      app = await _electron.launch({
        args: [MAIN_BUNDLE],
        env: {
          ...process.env,
          ...stack.env,
          // Same reason as `electron-app.ts`: `app.isPackaged` is false when
          // main is launched from `dist/`, and CI runs no Vite dev server.
          VEX_E2E_LOAD_BUILT: "1",
        },
      });
      const shell = await selectShellWindow(app);
      const migrated = await Promise.race([
        migrateThroughApp(shell),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`vex.database.migrate did not settle within ${MIGRATE_TIMEOUT_MS}ms`)),
            MIGRATE_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
      if (!migrated.ok) {
        throw new Error(
          `vex.database.migrate failed against the isolated stack: ` +
            `${migrated.error.code}: ${migrated.error.message}`,
        );
      }
      await use({ app, shell, stack, migrated });
    } finally {
      // Both removals are attempted; the stack's own teardown aggregates its
      // failures, and a wedged Electron must not stop the container from going.
      const results = await Promise.allSettled([
        app === undefined ? Promise.resolve() : app.close(),
        stack.stop(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason as unknown);
      // A closing Electron main that has already exited rejects `close()`; that
      // is not a leak, so it is reported rather than thrown only when the
      // stack teardown also failed.
      if (results[1]?.status === "rejected") {
        throw new AggregateError(failures, "vex-app-with-database: teardown failed");
      }
    }
  }, { timeout: FIXTURE_TIMEOUT_MS }],
});

export const expect = test.expect;
