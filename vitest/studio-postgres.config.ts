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
      // The control-state aggregate lives in the desktop main process but its
      // one hand-written statement runs against THIS schema, so its live proof
      // belongs in this lane. Reaching that module means resolving the shared
      // contracts it imports.
      "@shared": resolve(root, "vex-app/src/shared"),
    },
  },
  test: {
    include: [
      "src/__tests__/integration/migrations/idempotency.int.test.ts",
      "src/__tests__/integration/migrations/096-wallet-wrap-intents.int.test.ts",
      "src/__tests__/integration/engine/studio-*.int.test.ts",
      "src/__tests__/integration/repos/money-state-reader.int.test.ts",
      "src/__tests__/integration/repos/session-control-state-wake.int.test.ts",
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
