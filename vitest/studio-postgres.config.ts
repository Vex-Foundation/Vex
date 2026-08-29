import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

const root = resolve(__dirname, "..");

/**
 * The ONE `electron` module identity for this lane.
 *
 * MEASURED, not assumed (Stage B1): `electron` is a devDependency of `vex-app`
 * only, so with this lane's `root` at the repository root, resolution of the
 * bare specifier `electron` gives two different answers depending on who asks -
 *
 *   from ./src/__tests__/...     -> UNRESOLVED (MODULE_NOT_FOUND)
 *   from ./vex-app/src/main/...  -> vex-app/node_modules/electron/index.js
 *
 * This is the only lane that includes test files from BOTH trees, so it is the
 * only place that split can bite - and it bites SILENTLY: `vi.mock("electron")`
 * in a root-side test registers under the unresolved specifier while the
 * vex-app module under test imports the resolved path. The ids differ, the mock
 * never applies, and the test either passes for the wrong reason or the module
 * reaches for a real Electron runtime that is not there.
 *
 * `resolve.dedupe` was evaluated and REJECTED on that measurement: dedupe
 * collapses several COPIES of a package into one, and there is exactly one copy
 * here - the root side simply cannot reach it. An exact-match alias is what
 * gives every importer in this lane one identical module id.
 *
 * Regression guard:
 * src/__tests__/integration/engine/studio-electron-module-identity.int.test.ts
 */
const ELECTRON_MODULE = resolve(root, "vex-app/node_modules/electron");

export default defineConfig({
  root,
  resolve: {
    alias: {
      // Vite's object-form alias is PREFIX matching: this rewrites `electron`
      // and would also rewrite `electron/<subpath>`. Nothing in either tree
      // imports an electron subpath (verified), so the prefix form is safe and
      // keeps this map in one style. If a subpath import ever appears, convert
      // this map to the array form and pin `find: /^electron$/`.
      electron: ELECTRON_MODULE,
      "@tools": resolve(root, "src/tools"),
      "@utils": resolve(root, "src/utils"),
      "@config": resolve(root, "src/config"),
      "@vex-agent": resolve(root, "src/vex-agent"),
      // vex-app's own aliases. The Studio lane runs vex-app's END-TO-END test
      // for the real `deleteProject` composition (lifecycle gate, tombstone
      // transaction, installer teardown, filesystem) rather than its parts;
      // that test and the modules it drives import through `@shared`.
      "@shared": resolve(root, "vex-app/src/shared"),
      "@vex-lib": resolve(root, "src/lib"),
    },
  },
  test: {
    include: [
      "src/__tests__/integration/migrations/idempotency.int.test.ts",
      "src/__tests__/integration/migrations/096-wallet-wrap-intents.int.test.ts",
      "src/__tests__/integration/engine/studio-*.int.test.ts",
      // vex-app's live-Postgres tests. They live with the composition they
      // drive; only this lane starts a database for them.
      "vex-app/src/main/**/__tests__/*.int.test.ts",
      "src/__tests__/integration/repos/money-state-reader.int.test.ts",
      "src/__tests__/integration/repos/wallet-transaction-*.int.test.ts",
      "src/__tests__/integration/repos/wallet-wrap-*.int.test.ts",
      "src/__tests__/integration/repos/swap-prequotes-claim.int.test.ts",
      "src/__tests__/integration/repos/wallet-transfer-unconfirmed-repair.int.test.ts",
      "src/__tests__/integration/repos/wallet-transfer-execution-first-writer.int.test.ts",
      "src/__tests__/integration/wallet/transaction-authority-fence.int.test.ts",
      "src/__tests__/integration/agent-scan/agent-activity-staged-broadcast.int.test.ts",
      "src/__tests__/integration/agent-scan/evm-nonce-reservations.int.test.ts",
      "src/__tests__/integration/agent-scan/repair-sweep.int.test.ts",
      "src/__tests__/integration/agent-scan/vex-fee-projection.int.test.ts",
    ],
    globals: false,
    environment: "node",
    globalSetup: ["src/__tests__/integration/setup/studioPostgresGlobalSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: "threads",
    maxWorkers: 1,
    minWorkers: 1,
  },
});
