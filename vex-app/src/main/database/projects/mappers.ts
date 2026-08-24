/**
 * Row shapes and DTO projection for the `projects` repository.
 *
 * `project_wallets` is authoritative for the wallet selection; the backing
 * session's wallet columns are a mirror. Every read therefore joins
 * `project_wallets` and never reads the session's columns.
 *
 * The projection is where a stored selection is VERIFIED against the live
 * wallet inventory. A stored `(wallet_id, address)` pair whose id no longer
 * resolves, or resolves to a different address, is drift: the wallet was
 * removed, or force re-imported over a different key. The read fails closed
 * with `projects.wallet_drift` rather than handing a consumer a selection that
 * a later signing path would treat as the user's choice. Applied uniformly to
 * `get` AND `list` on purpose - one policy, no surface where drift is visible
 * and another where it is quietly hidden.
 */

import { getWalletById } from "@vex-lib/wallet.js";
import type { ProjectDto, ProjectWallets, StudioAgentId } from "@shared/schemas/projects.js";
import { studioAgentIdSchema } from "@shared/schemas/projects.js";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import type { WalletRef } from "../../ipc/_wallet-refs.js";

/**
 * A project's wallet selection AFTER main resolved every id against the
 * inventory. `null` for a family means "no selection". Write paths accept only
 * this shape, never a renderer-supplied address.
 */
export interface ProjectWalletRefs {
  readonly evm: WalletRef | null;
  readonly solana: WalletRef | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  root_path: string;
  permission: SessionPermission;
  backing_session_id: string;
  agents: string[] | null;
  scope_version: number;
  generator_version: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ProjectWalletRow {
  project_id: string;
  family: "evm" | "solana";
  wallet_id: string | null;
  address: string | null;
}

export const PROJECT_ROW_COLUMNS =
  "id, name, slug, root_path, permission, backing_session_id, agents, " +
  "scope_version, generator_version, created_at, updated_at";

export const PROJECT_WALLET_ROW_COLUMNS =
  "project_id, family, wallet_id, address";

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Keep only ids still in the closed roster. An id that was valid when the
 * project was created but has since been retired from `STUDIO_AGENT_IDS` is
 * dropped rather than escaping the DTO's own schema - the DTO is output
 * validated, so an unknown id would otherwise turn a read into a contract
 * violation the user cannot act on.
 */
function toAgents(raw: string[] | null): StudioAgentId[] {
  if (raw === null) return [];
  const out: StudioAgentId[] = [];
  for (const id of raw) {
    const parsed = studioAgentIdSchema.safeParse(id);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export type WalletProjectionOutcome =
  | { readonly kind: "ok"; readonly wallets: ProjectWallets }
  | { readonly kind: "drift"; readonly family: "evm" | "solana" }
  | { readonly kind: "missing_family"; readonly family: "evm" | "solana" };

/**
 * Project the two `project_wallets` rows for one project into the DTO shape,
 * verifying each stored selection against the wallet inventory.
 *
 * A missing family row is a corrupt project, NOT an unselected wallet: the
 * create path always writes both families, so absence means something wrote
 * around the repository. It is reported as its own outcome rather than
 * silently rendered as "no selection".
 */
export function projectWallets(
  rows: ReadonlyArray<ProjectWalletRow>,
): WalletProjectionOutcome {
  const wallets: { evm: ProjectWallets["evm"]; solana: ProjectWallets["solana"] } = {
    evm: null,
    solana: null,
  };
  for (const family of ["evm", "solana"] as const) {
    const row = rows.find((r) => r.family === family);
    if (row === undefined) return { kind: "missing_family", family };
    if (row.wallet_id === null || row.address === null) continue;
    const entry = getWalletById(family, row.wallet_id);
    if (entry === null || entry.address !== row.address) {
      return { kind: "drift", family };
    }
    wallets[family] = { id: row.wallet_id, address: row.address };
  }
  return { kind: "ok", wallets };
}

export function toProjectDto(
  row: ProjectRow,
  wallets: ProjectWallets,
  displayPath: string,
): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    rootPath: row.root_path,
    displayPath,
    permission: row.permission,
    agents: toAgents(row.agents),
    wallets,
    scopeVersion: row.scope_version,
    backingSessionId: row.backing_session_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}
