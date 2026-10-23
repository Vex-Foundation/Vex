/**
 * The production {@link WithdrawalOriginStore}: the engine database
 * (`src/vex-agent/db/repos/vex-inference-withdrawal-origins.ts`, migration
 * 181), beside the funding policy's own tables for the same reason they live
 * there: durable, transactional, one owner. Tests inject an in-memory store.
 */

import * as repo from "@vex-agent/db/repos/vex-inference-withdrawal-origins.js";
import type { WithdrawalOriginStore } from "./withdrawal-origins.js";

export function productionWithdrawalOriginStore(): WithdrawalOriginStore {
  return {
    recordCreatedHere: (accountId, withdrawalId) => repo.recordWithdrawalCreatedHere(accountId, withdrawalId),
    readOrigins: async (accountId, withdrawalIds) => {
      const rows = await repo.readWithdrawalOrigins(accountId, withdrawalIds);
      return new Map([...rows].map(([id, row]) => [id, { origin: row.origin, dismissedAt: row.dismissedAt }]));
    },
    flagForeign: (accountId, withdrawalId) => repo.flagForeignWithdrawal(accountId, withdrawalId),
    dismissForeign: (accountId, withdrawalId) => repo.dismissForeignWithdrawal(accountId, withdrawalId),
  };
}
