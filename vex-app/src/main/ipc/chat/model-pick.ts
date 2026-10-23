/**
 * `chat.submit` model pick check (F06): a pick reaches the engine only when
 * it names the backend the engine talks to NOW and a model that backend's
 * catalogue lists (tool-capable rows only, the list the picker offers).
 *
 * Main is the authority, the renderer's menu only a convenience: a stale
 * menu after a backend switch, or a hand-built IPC call, is refused here
 * with copy that names the model, before the engine writes anything.
 *
 * NO NEW `VexErrorCode` (same rule as `engine-failure-copy.ts`): a refused
 * pick is `validation.invalid_input` with an actionable message; an
 * unreadable catalogue is the retryable `provider.unavailable`.
 */

import type { VexError } from "@shared/ipc/result.js";
import type { SessionModelPick } from "@shared/schemas/models.js";
import { log } from "../../logger/index.js";
import { activeInferenceProviderMode } from "../../vex-cloud/active-mode.js";

const BACKEND_NAME: Readonly<Record<SessionModelPick["provider"], string>> = {
  openrouter: "OpenRouter",
  vexcloud: "Vex Inference",
};

function refusedPick(correlationId: string, message: string): VexError {
  return {
    code: "validation.invalid_input",
    domain: "chat",
    message,
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

/** `null` when the pick may run; otherwise the error to return. */
export async function checkModelPick(
  pick: SessionModelPick,
  correlationId: string,
  signal: AbortSignal,
): Promise<VexError | null> {
  const backend = activeInferenceProviderMode();
  if (pick.provider !== backend) {
    return refusedPick(
      correlationId,
      `${pick.modelId} was picked for ${BACKEND_NAME[pick.provider]}, but Vex now runs on ${BACKEND_NAME[backend]}. Pick a model again, then send.`,
    );
  }
  try {
    const { loadProviderModelCatalog } = await import("../../onboarding/provider-model-catalog.js");
    const catalog = await loadProviderModelCatalog({ source: backend, signal });
    if (catalog.models.some((row) => row.modelId === pick.modelId)) return null;
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    log.warn(`[ipc:vex:chat:submit] model catalogue unavailable correlationId=${correlationId}`);
    return {
      code: "provider.unavailable",
      domain: "chat",
      message: `Couldn't check the ${BACKEND_NAME[backend]} model list. Try again shortly.`,
      retryable: true,
      userActionable: true,
      redacted: true,
      correlationId,
    };
  }
  return refusedPick(
    correlationId,
    `${BACKEND_NAME[backend]} does not offer ${pick.modelId}. Pick another model, then send.`,
  );
}
