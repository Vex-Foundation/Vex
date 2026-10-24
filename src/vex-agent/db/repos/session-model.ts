/**
 * The session's chosen model (`sessions.model_provider`, `model_id`,
 * `model_updated_at`, migration 182, F06).
 *
 * Written when an interactive chat turn carries a composer pick; read by
 * every turn of the session, including the ones nobody typed (wake
 * continuations, approval and form resumes), so they run on the operator's
 * model instead of the global default. `null` means the operator never
 * picked.
 *
 * `provider` is the inference backend the pick was made under. The runner
 * compares it with the active backend before using the pick (see
 * `engine/core/runner/session-model.ts`).
 *
 * Mission runs never read this: their model is part of the accepted mission
 * contract.
 */

import { executeWith, getPool, queryOne } from "../client.js";
import type { ProviderType } from "@vex-agent/inference/config.js";

/** A backend a stored pick may name. Validated here, not in SQL (migration 182). */
const SESSION_MODEL_PROVIDERS: ReadonlySet<string> = new Set<ProviderType>(["openrouter", "vexcloud"]);

export interface SessionModelPick {
  readonly provider: ProviderType;
  readonly modelId: string;
  /** ISO timestamp of the operator's last pick. */
  readonly updatedAt: string;
}

function isSessionModelProvider(value: unknown): value is ProviderType {
  return typeof value === "string" && SESSION_MODEL_PROVIDERS.has(value);
}

export async function setSessionModel(
  sessionId: string,
  provider: ProviderType,
  modelId: string,
): Promise<void> {
  await executeWith(
    getPool(),
    `UPDATE sessions
        SET model_provider = $2, model_id = $3, model_updated_at = now()
      WHERE id = $1`,
    [sessionId, provider, modelId],
  );
}

/**
 * Read the persisted pick. A missing row, no pick, or a stored backend this
 * build does not know all read as `null`, so a downgrade can never send a
 * foreign id to a backend that does not serve it.
 */
export async function getSessionModel(sessionId: string): Promise<SessionModelPick | null> {
  const row = await queryOne<{
    model_provider: string | null;
    model_id: string | null;
    model_updated_at: Date | string | null;
  }>(
    "SELECT model_provider, model_id, model_updated_at FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (row === null) return null;
  const { model_provider: provider, model_id: modelId, model_updated_at: updatedAt } = row;
  if (!isSessionModelProvider(provider) || modelId === null || modelId.length === 0) return null;
  if (updatedAt === null) return null;
  return {
    provider,
    modelId,
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : new Date(updatedAt).toISOString(),
  };
}
