/**
 * Read-only model catalogue for provider setup: the OpenRouter public
 * catalogue, or the Vex Cloud allowlist when `provider: "vexcloud"`.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  providerListModelsInputSchema,
  providerListModelsResultSchema,
  type ProviderListModelsResult,
} from "@shared/schemas/provider.js";
import { loadProviderModelCatalog } from "../../onboarding/provider-model-catalog.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";

export function registerProviderModelsHandler(): () => void {
  return registerHandler({
    channel: CH.onboarding.providerListModels,
    domain: "onboarding",
    inputSchema: providerListModelsInputSchema,
    outputSchema: providerListModelsResultSchema,
    handle: async (input, ctx): Promise<Result<ProviderListModelsResult>> => {
      const source = input.provider ?? "openrouter";
      try {
        const result = await loadProviderModelCatalog({ source, signal: ctx.signal });
        log.info(
          `[ipc:vex:onboarding:providerListModels] ok source=${source} count=${result.models.length} correlationId=${ctx.requestId}`,
        );
        return ok(result);
      } catch (cause: unknown) {
        const className =
          cause instanceof Error ? cause.constructor.name : typeof cause;
        log.warn(
          `[ipc:vex:onboarding:providerListModels] failed source=${source} class=${className} correlationId=${ctx.requestId}`,
        );
        return err({
          code: "provider.unavailable",
          domain: "onboarding",
          message:
            source === "vexcloud"
              ? "The Vex Inference model list is temporarily unavailable. Try again in a moment."
              : "The OpenRouter model catalogue is temporarily unavailable.",
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }
    },
  });
}
