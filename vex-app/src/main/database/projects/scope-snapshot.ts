/**
 * The AUTHORITATIVE per-call project scope snapshot for Vex Studio.
 *
 * `runStudioCall` loads this once at the admission of EVERY MCP call, including
 * `vex_ToolSearch`. It is the linearization point of a call against a
 * concurrent scope edit: a call admitted under `scope_version` N runs under N,
 * and the next call sees N+1. Nothing else in the Studio path may load a scope,
 * and no connection may cache one - a connection-scoped scope would be a stale
 * authorization cache, and a connection opened while a project was `full` would
 * keep executing mutations after the user made it `restricted`, leaving no
 * approval row for the A3 gates to protect.
 *
 * ## Why ONE statement and not the two `read.ts` uses
 *
 * `getProject` reads `projects`, then reads `project_wallets`. Two statements
 * on one connection are two snapshots: `updateProjectScope` commits the
 * permission bump and the wallet rewrite in ONE transaction, so a reader can
 * legally observe version N's project row and version N+1's wallets between
 * them. For a DISPLAY read that is a cosmetic skew. For the value that decides
 * whether a call needs an approval card and which key signs it, it is a mixed
 * authorization: permission from before the edit, wallets from after. So this
 * path uses a single `LEFT JOIN` plus `json_agg`, which PostgreSQL evaluates
 * under one statement snapshot and which therefore cannot pair the two
 * versions. A read-only `REPEATABLE READ` transaction would be equally correct
 * and costs a round trip more; the single statement is the cheaper form of the
 * same guarantee.
 *
 * ## Fail closed, by named cause
 *
 * A deleted project, a drifted wallet selection, a corrupt row set and an
 * unreachable database are four different facts with four different remedies,
 * so each gets its own outcome and `runStudioCall` renders its own sentence.
 * None of them executes anything.
 *
 * The statement itself lives in `scope-snapshot-query.ts`, with no imports, so
 * the live two-connection race test in the root integration lane runs the
 * production text rather than a copy of it.
 *
 * The projects-root assertion every read in `read.ts` performs is deliberately
 * NOT repeated here. That check answers "has the user's projects folder moved",
 * which is a filesystem question about opening a workspace; it is not part of
 * the authority a tool call runs under, and failing a money-path call on it
 * would refuse work for a reason the call has nothing to do with.
 */

import type { Client } from "pg";
import { ok } from "@shared/ipc/result.js";
import { projectScopeSchema, type ProjectScope } from "@vex-agent/mcp/project-scope.js";
import { log } from "../../logger/index.js";
import { withClient } from "../sessions/connection.js";
import { projectWallets, type ProjectWalletRow } from "./mappers.js";
import {
  SCOPE_SNAPSHOT_SQL,
  type ScopeSnapshotRow,
} from "./scope-snapshot-query.js";

/** The scope, or the named reason there is none. Exactly one reaches the caller. */
export type ProjectScopeSnapshot =
  | { readonly kind: "ok"; readonly scope: ProjectScope }
  | { readonly kind: "unknown_project" }
  | { readonly kind: "wallet_drift"; readonly family: "evm" | "solana" }
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "unavailable" };

/**
 * Load the scope one Studio call will run under.
 *
 * `correlationId` is carried into the logs only; it never reaches the database
 * and never reaches the agent.
 */
export async function loadProjectScopeSnapshot(
  projectId: string,
  correlationId: string,
): Promise<ProjectScopeSnapshot> {
  const outcome = await withClient(
    async (client: Client) => {
      const rows = await client.query<ScopeSnapshotRow>(SCOPE_SNAPSHOT_SQL, [projectId]);
      return ok(projectSnapshot(rows.rows[0], projectId, correlationId));
    },
  ).catch((cause: unknown) => {
    log.warn(
      `[studio:scope] snapshot query failed projectId=${projectId} `
        + `correlationId=${correlationId}`,
      cause,
    );
    return { ok: false as const };
  });
  if (!outcome.ok) return { kind: "unavailable" };
  return outcome.data;
}

/**
 * Row set -> scope. Wallet drift is verified against the LIVE inventory before
 * the schema parse, in that order: a selection whose id no longer resolves, or
 * resolves to a different address, is a changed signing key and must refuse the
 * call rather than parse cleanly into an authority the user never granted.
 */
function projectSnapshot(
  row: ScopeSnapshotRow | undefined,
  projectId: string,
  correlationId: string,
): ProjectScopeSnapshot {
  if (row === undefined) return { kind: "unknown_project" };

  const walletRows: ProjectWalletRow[] = [];
  for (const raw of row.wallets) {
    if (raw.family !== "evm" && raw.family !== "solana") {
      return { kind: "invalid", detail: "unrecognized wallet family row" };
    }
    walletRows.push({
      project_id: projectId,
      family: raw.family,
      wallet_id: typeof raw.wallet_id === "string" ? raw.wallet_id : null,
      address: typeof raw.address === "string" ? raw.address : null,
    });
  }

  const projection = projectWallets(walletRows);
  if (projection.kind === "drift") {
    return { kind: "wallet_drift", family: projection.family };
  }
  if (projection.kind === "missing_family") {
    log.error(
      `[studio:scope] project is missing its ${projection.family} wallet row `
        + `projectId=${projectId} correlationId=${correlationId}`,
    );
    return {
      kind: "invalid",
      detail: `missing ${projection.family} project_wallets row`,
    };
  }

  const parsed = projectScopeSchema.safeParse({
    projectId: row.id,
    scopeVersion: row.scope_version,
    permission: row.permission,
    backingSessionId: row.backing_session_id,
    wallets: projection.wallets,
  });
  if (!parsed.success) {
    log.error(
      `[studio:scope] scope failed validation projectId=${projectId} `
        + `correlationId=${correlationId} issues=${String(parsed.error.issues.length)}`,
    );
    return { kind: "invalid", detail: "the stored project scope failed validation" };
  }
  return { kind: "ok", scope: parsed.data };
}
