/**
 * The conflict error every linked-settlement arm throws, and the vocabulary of
 * rows it can name.
 *
 * Extracted from `./linked-transaction-settlement.ts` so a per-state-machine
 * arm (`./linked-wrap-intent.ts`) can throw the SAME class without importing
 * its own coordinator, which would be an import cycle. The coordinator
 * re-exports it, so it remains the public gate and `instanceof` keeps working
 * for every existing caller and test.
 */

/**
 * Which durable row the conflict is about.
 *
 * `wti` = wallet_transaction_intents, `wi` = the transfer-specific
 * wallet_intents, `wwi` = wallet_wrap_intents, `aa` = agent_activity,
 * `pe` = protocol_executions.
 */
export type LinkedSettlementRow = "wti" | "wi" | "wwi" | "aa" | "pe";

export class LinkedTransactionSettlementConflictError extends Error {
  readonly row: LinkedSettlementRow;

  constructor(row: LinkedSettlementRow, detail: string) {
    super(`linked transaction repair settlement conflict on ${row}: ${detail}`);
    this.name = "LinkedTransactionSettlementConflictError";
    this.row = row;
  }
}
