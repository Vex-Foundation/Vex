/**
 * Server-side wallet resolution for the projects handlers.
 *
 * Same rule as `main/ipc/sessions/create.ts`: the renderer sends inventory IDs
 * only, main resolves each id to its on-chain address, and an id main does not
 * own fails the whole request closed BEFORE anything is created or edited. A
 * renderer-supplied address is never trusted and is never accepted as input.
 */

import type { VexError } from "@shared/ipc/result.js";
import type { ProjectWalletSelection } from "@shared/schemas/projects.js";
import type { ProjectWalletRefs } from "../../database/projects/mappers.js";
import { resolveWalletRef } from "../_wallet-refs.js";
import { projectInvalidWalletError } from "../../studio/project-errors.js";

export type ProjectWalletResolution =
  | { readonly kind: "resolved"; readonly refs: ProjectWalletRefs }
  | { readonly kind: "invalid"; readonly error: VexError };

export function resolveProjectWallets(
  selection: ProjectWalletSelection,
  correlationId: string,
): ProjectWalletResolution {
  const evm = resolveWalletRef("evm", selection.evm);
  const solana = resolveWalletRef("solana", selection.solana);
  if (evm === "invalid" || solana === "invalid") {
    return { kind: "invalid", error: projectInvalidWalletError(correlationId) };
  }
  return { kind: "resolved", refs: { evm, solana } };
}
