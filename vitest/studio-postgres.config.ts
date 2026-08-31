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
      // vex-app's own aliases, shared by two consumers of this lane:
      // vex-app's END-TO-END tests (the real `deleteProject` composition -
      // lifecycle gate, tombstone transaction, installer teardown,
      // filesystem) and the control-state aggregate, whose one hand-written
      // statement runs against THIS schema. Both import through `@shared`.
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
      "src/__tests__/integration/repos/session-control-state-wake.int.test.ts",
      "src/__tests__/integration/repos/recovery-money-gate-race.int.test.ts",
      "src/__tests__/integration/repos/recovery-reverse-lock-order.int.test.ts",
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
