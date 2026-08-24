/**
 * The PROJECT SCOPE a Studio dispatch runs under, loaded from the
 * AUTHORITATIVE tables.
 *
 * Split out of `studio.ts` because it has its own reason to change: this is
 * the only place that knows how a project's permission and wallet selection
 * become the value a dispatch signs with, and it changes when those tables
 * change, not when the dispatch ordering does.
 *
 * ## Why not the session's wallet columns
 *
 * A project's rows on `sessions` are a compatibility MIRROR. `project_wallets`
 * is authoritative, and resuming from the mirror would let a drifted mirror
 * decide which key signs. `buildResumedApprovalToolContext`, which hydrates
 * from the session, must never be used on this path for exactly that reason.
 *
 * ## Fails closed on every missing piece
 *
 * A missing project, a backing-session mismatch, or an unparseable scope
 * THROWS. The caller turns that into a durable pre-dispatch refusal; there is
 * deliberately no fall-through to a primary wallet, and a wallet family with no
 * selection stays `null` so every downstream resolver fails closed on it.
 *
 * The returned `scopeVersion` builds the CONTEXT. It is never the value the
 * gate compares against: that comparison belongs to the version recorded AT
 * ENQUEUE, checked inside the transaction that takes the dispatch slot.
 * Comparing the version just read with itself would prove nothing.
 */

import {
  projectScopeSchema,
  type ProjectScope,
} from "@vex-agent/mcp/project-scope.js";

export async function loadProjectScope(
  projectId: string | null,
  backingSessionId: string,
): Promise<ProjectScope> {
  if (projectId === null) throw new Error("studio intent has no project");
  const { query } = await import("../../../../../db/client.js");
  const projectRows = await query<{
    id: string;
    scope_version: number;
    permission: string;
    backing_session_id: string;
  }>(
    "SELECT id, scope_version, permission, backing_session_id FROM projects WHERE id = $1",
    [projectId],
  );
  const project = projectRows[0];
  if (project === undefined) throw new Error("project missing");
  if (project.backing_session_id !== backingSessionId) {
    throw new Error("project backing session mismatch");
  }
  const walletRows = await query<{
    family: string;
    wallet_id: string | null;
    address: string | null;
  }>(
    "SELECT family, wallet_id, address FROM project_wallets WHERE project_id = $1",
    [projectId],
  );
  const wallet = (family: string): { id: string; address: string } | null => {
    const found = walletRows.find((r) => r.family === family);
    if (!found || found.wallet_id === null || found.address === null) return null;
    return { id: found.wallet_id, address: found.address };
  };
  return projectScopeSchema.parse({
    projectId: project.id,
    scopeVersion: Number(project.scope_version),
    permission: project.permission,
    backingSessionId: project.backing_session_id,
    wallets: { evm: wallet("evm"), solana: wallet("solana") },
  });
}
