/**
 * `vex.sessions.getModel` — the model a session's next turn runs on (F06).
 *
 * The session's own pick (`sessions.model_*`, written by the engine when a
 * chat turn carries one) when it was made under the ACTIVE backend:
 * `source: "session"`. Otherwise the global default from `AGENT_PROVIDER` +
 * `AGENT_MODEL` in `process.env` (loaded after vault unlock by the
 * onboarding flow): `source: "global_default"`. A pick made under the other
 * backend reads as the default here, because that is what the next turn
 * runs (and says so in a notice). When the env values are absent:
 * `source: "unconfigured"`. The composer reads this to show and pick the
 * model.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  sessionGetModelInputSchema,
  sessionModelDtoSchema,
  type SessionModelDto,
} from "@shared/schemas/sessions.js";
import { getSessionModelPick, type SessionModelPickRow } from "../../database/sessions-db.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { resolveReasoningCapability } from "../reasoning-capability-resolver.js";
import { activeInferenceProviderMode } from "../../vex-cloud/active-mode.js";

const MODEL_ID_MAX = 200;
const PROVIDER_ID_MAX = 64;

function readEnvDefault(): {
  readonly provider: string | null;
  readonly model: string | null;
} {
  const rawProvider = process.env["AGENT_PROVIDER"];
  const rawModel = process.env["AGENT_MODEL"];
  const provider =
    typeof rawProvider === "string" && rawProvider.trim().length > 0
      ? rawProvider.trim()
      : null;
  const model =
    typeof rawModel === "string" && rawModel.trim().length > 0
      ? rawModel.trim()
      : null;
  if (provider !== null && provider.length > PROVIDER_ID_MAX) {
    return { provider: null, model };
  }
  if (model !== null && model.length > MODEL_ID_MAX) {
    return { provider, model: null };
  }
  return { provider, model };
}

/**
 * The session's pick when it was made under the backend the engine talks to
 * now, else `null`. Best-effort: a failed read shows the default, which is
 * also what the engine runs when its own read fails.
 */
async function readActivePick(sessionId: string): Promise<SessionModelPickRow | null> {
  const outcome = await getSessionModelPick(sessionId);
  if (!outcome.ok) {
    log.warn(`[ipc:vex:sessions:getModel] pick read failed sessionId=${sessionId}`);
    return null;
  }
  const pick = outcome.data;
  return pick !== null && pick.provider === activeInferenceProviderMode() ? pick : null;
}

export function registerSessionsGetModelHandler(): () => void {
  return registerHandler({
    channel: CH.sessions.getModel,
    domain: "sessions",
    inputSchema: sessionGetModelInputSchema,
    outputSchema: sessionModelDtoSchema,
    handle: async (input, ctx): Promise<Result<SessionModelDto>> => {
      const { provider, model } = readEnvDefault();
      const pick = provider !== null && model !== null ? await readActivePick(input.sessionId) : null;
      const dto: SessionModelDto =
        pick !== null
          ? {
              sessionId: input.sessionId,
              provider: pick.provider,
              modelId: pick.modelId,
              source: "session",
              updatedAt: pick.updatedAt,
              ...(await resolveReasoningCapability(pick.modelId, ctx.signal)),
            }
          : provider !== null && model !== null
          ? {
              sessionId: input.sessionId,
              provider,
              modelId: model,
              source: "global_default",
              updatedAt: null,
              ...(await resolveReasoningCapability(model, ctx.signal)),
            }
          : {
              sessionId: input.sessionId,
              provider: null,
              modelId: null,
              source: "unconfigured",
              updatedAt: null,
              // No configured model — capability is unknowable.
              reasoning: null,
              supportsReasoning: null,
            };
      log.info(
        `[ipc:vex:sessions:getModel] ok sessionId=${input.sessionId} ` +
          `source=${dto.source} supportsReasoning=${String(dto.supportsReasoning)} ` +
          `correlationId=${ctx.requestId}`,
      );
      return ok(dto);
    },
  });
}
