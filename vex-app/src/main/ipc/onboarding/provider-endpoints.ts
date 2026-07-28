/**
 * Read-only OpenRouter ENDPOINT catalogue for the wizard's provider select.
 *
 * Mirrors `provider-models.ts`: keyless public catalogue read, fixed redacted
 * failure copy, no SDK message ever surfaced. The `modelId` arrives from the
 * untrusted renderer and is validated by the zod schema (closed
 * `AUTHOR/SLUG` charset) before main splits it on the FIRST `/` and
 * interpolates the halves into the provider URL path.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  providerListEndpointsInputSchema,
  providerListEndpointsResultSchema,
  type ProviderListEndpointsResult,
} from "@shared/schemas/provider-endpoints.js";
import { loadProviderEndpointCatalog } from "../../onboarding/provider-endpoint-catalog.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";

export function registerProviderEndpointsHandler(): () => void {
  return registerHandler({
    channel: CH.onboarding.providerListEndpoints,
    domain: "onboarding",
    inputSchema: providerListEndpointsInputSchema,
    outputSchema: providerListEndpointsResultSchema,
    handle: async (input, ctx): Promise<Result<ProviderListEndpointsResult>> => {
      try {
        const result = await loadProviderEndpointCatalog(input.modelId, {
          signal: ctx.signal,
        });
        log.info(
          `[ipc:vex:onboarding:providerListEndpoints] ok count=${result.endpoints.length} correlationId=${ctx.requestId}`,
        );
        return ok(result);
      } catch (cause: unknown) {
        const className =
          cause instanceof Error ? cause.constructor.name : typeof cause;
        log.warn(
          `[ipc:vex:onboarding:providerListEndpoints] failed class=${className} correlationId=${ctx.requestId}`,
        );
        return err({
          code: "provider.unavailable",
          domain: "onboarding",
          message:
            "The OpenRouter provider list is temporarily unavailable.",
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }
    },
  });
}
