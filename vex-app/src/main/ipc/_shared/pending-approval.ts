import { err, ok, type Result } from "@shared/ipc/result.js";
import { listPendingForSession } from "../../database/approvals-db.js";
import { log } from "../../logger/index.js";
import { controlFailedError } from "../runtime/_errors.js";

/** Resolve the durable approval identity represented by paused_approval. */
export async function resolvePendingApprovalId(
  sessionId: string,
  correlationId: string,
): Promise<Result<string>> {
  const pending = await listPendingForSession(sessionId);
  if (!pending.ok) return pending;

  const approval = pending.data[0];
  if (approval === undefined) {
    log.warn(
      `[runtime-control] paused_approval without pending queue row correlationId=${correlationId}`,
      { sessionId },
    );
    return err(controlFailedError(correlationId));
  }

  return ok(approval.id);
}
