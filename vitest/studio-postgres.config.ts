import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

const root = resolve(__dirname, "..");

export default defineConfig({
  root,
  resolve: {
    alias: {
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
      // ONE module identity for `electron`. The package is installed only under
      // `vex-app/node_modules`, so a bare `electron` specifier resolves
      // differently depending on whether the importer sits under `vex-app/` or
      // under `src/`. `vi.mock("electron")` keys on the RESOLVED id, so without
      // this the desktop-runtime double applied to the test file and NOT to the
      // main-process module under test - silently: `shell` was then `undefined`,
      // every `shell.trashItem` call threw inside a `try`, and a test asserting
      // "the trash failed" passed for entirely the wrong reason.
      electron: resolve(root, "vex-app/node_modules/electron"),
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
