/**
 * `ProjectScope` - the ONLY thing the engine learns about a Vex Studio project.
 *
 * The privileged main process owns project persistence (`projects` +
 * `project_wallets`, migration 085) and is authoritative for the selection. It
 * builds this value from those rows and PARSES it through the schema below
 * before calling the executor, so the engine never reads a project table and
 * never has to trust an unvalidated object across the process boundary
 * (rule 04: validate once at the real boundary, then operate on trusted types).
 *
 * The schema lives in the engine package rather than in `vex-app/src/shared`
 * because the root `tsconfig.json` has no `@shared` alias: the engine cannot
 * import the app's shared contracts, and duplicating the parse on both sides
 * would create a second source of truth for what a scope IS.
 *
 * Strict everywhere: an unknown key is a rejected value, not a silently dropped
 * field. A wallet family that is `null` means NO SELECTION, and every wallet
 * resolver fails closed on it - there is deliberately no fall-through to the
 * primary wallet (`src/tools/wallet/multi-auth.ts`).
 */

import { z } from "zod";

/** Inventory wallet id plus the address snapshot it was selected with. */
export const projectScopeWalletSchema = z
  .object({
    id: z.string().min(1).max(128),
    address: z.string().min(1).max(128),
  })
  .strict();

export type ProjectScopeWallet = z.infer<typeof projectScopeWalletSchema>;

export const projectScopeSchema = z
  .object({
    projectId: z.string().uuid(),
    /**
     * Monotonic optimistic-concurrency token for scope edits, starting at 1. An
     * in-flight approval carries the version it was enqueued under and is
     * refused at commit when the scope has moved (stage A3).
     */
    scopeVersion: z.number().int().min(1),
    /** Mirrors the backing session's permission. Drives the approval gate. */
    permission: z.enum(["restricted", "full"]),
    /** The `mode = 'agent'`, `scope = 'vex_studio'` session that backs this project. */
    backingSessionId: z.string().uuid(),
    wallets: z
      .object({
        evm: projectScopeWalletSchema.nullable(),
        solana: projectScopeWalletSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export type ProjectScope = z.infer<typeof projectScopeSchema>;
