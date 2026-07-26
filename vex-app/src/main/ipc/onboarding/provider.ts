/**
 * vex.onboarding.providerPersist — Wizard Step 6 IPC handler (M10).
 *
 * Verify-then-persist atomically (codex turn 2 RED #1):
 *   1. Call `verifyOpenRouterConnection({apiKey, model})` — 16-token
 *      chat completion with hard 15s timeout + SDK retries disabled.
 *      If verify fails → return the mapped `provider.*` VexError
 *      immediately. NO .env write.
 *   2. If verify ok → wrap `writeProvider(input)` in `withEnvWriteLock`
 *      so it cannot interleave with keystoreSet / apiKeysSet /
 *      embeddingConfigure / agentCoreConfigure on the same `.env`.
 *      The writer stores the API key in the encrypted vault and writes
 *      only non-secret provider selection to `.env`.
 *   3. Persist failure → `onboarding.env_persist_failed` with
 *      `details: {verified: true}` so the renderer can render the
 *      verify-but-save-failed UX.
 *
 * Logging contract (codex turn 1 RED #6 inherited from M9):
 *   - log `provider=openrouter modelSet=true latencyMs=N correlationId=X`
 *   - NEVER apiKey value, length, prefix, model value
 *   - on failure log `errCode=X correlationId=Y`
 */

import { CH } from "@shared/ipc/channels.js";
import type { Result } from "@shared/ipc/result.js";
import {
  providerPersistInputSchema,
  providerPersistResultSchema,
  type ProviderPersistResult,
} from "@shared/schemas/provider.js";
import { writeProvider } from "../../onboarding/provider-writer.js";
import { verifyOpenRouterConnection } from "../../onboarding/openrouter-test-client.js";
import { withEnvWriteLock } from "../../onboarding/env-write-mutex.js";
import { loadProviderDotenv } from "@vex-lib/runtime-env.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";

export function registerProviderHandler(): () => void {
  return registerHandler({
    channel: CH.onboarding.providerPersist,
    domain: "onboarding",
    inputSchema: providerPersistInputSchema,
    outputSchema: providerPersistResultSchema,
    handle: async (input, ctx): Promise<Result<ProviderPersistResult>> => {
      // Step 1: verify connection BEFORE any disk write.
      const verifyResult = await verifyOpenRouterConnection(
        { apiKey: input.apiKey, model: input.model },
        { correlationId: ctx.requestId },
      );
      if (!verifyResult.ok) {
        log.info(
          `[ipc:vex:onboarding:providerPersist] ` +
            `errCode=${verifyResult.error.code} correlationId=${ctx.requestId}`,
        );
        return verifyResult;
      }

      const latencyMs = verifyResult.data.latencyMs;

      // Step 1b: verify the OPTIONAL fallback the same way, still BEFORE any
      // disk write, so the atomic guarantee covers both providers. A fallback
      // that only fails at 3am mid-mission — exactly when it is needed — is
      // worse than no fallback, so an unverifiable one blocks the save rather
      // than being persisted with a warning.
      if (input.fallbackApiKey !== undefined && input.fallbackModel !== undefined) {
        const fallbackVerify = await verifyOpenRouterConnection(
          { apiKey: input.fallbackApiKey, model: input.fallbackModel },
          { correlationId: ctx.requestId },
        );
        if (!fallbackVerify.ok) {
          log.info(
            `[ipc:vex:onboarding:providerPersist] fallback ` +
              `errCode=${fallbackVerify.error.code} correlationId=${ctx.requestId}`,
          );
          return {
            ok: false,
            error: {
              ...fallbackVerify.error,
              details: {
                ...(fallbackVerify.error.details ?? {}),
                // Lets the renderer point the error at the fallback fields
                // instead of the primary ones.
                scope: "fallback",
              },
            },
          };
        }
      }

      // Step 2: persist vault secret + non-secret env values inside the env-write mutex.
      // On success, reload the non-secret .env into process.env (overwrite — the
      // user just rewrote it) and reset the engine's cached inference provider so
      // the next resolveProvider() rebuilds with the new model. Both run inside
      // the lock so the handler cannot report success before env + provider cache
      // are coherent.
      const persistResult = await withEnvWriteLock(async () => {
        const result = await writeProvider(input);
        if (result.ok) {
          loadProviderDotenv({ overwrite: true });
          const { resetProvider } = await import(
            "@vex-agent/inference/registry.js"
          );
          resetProvider();
        }
        return result;
      });
      if (!persistResult.ok) {
        log.info(
          `[ipc:vex:onboarding:providerPersist] ` +
            `errCode=${persistResult.error.code} correlationId=${ctx.requestId}`,
        );
        return persistResult;
      }

      log.info(
        `[ipc:vex:onboarding:providerPersist] ` +
          `provider=openrouter modelSet=true latencyMs=${latencyMs} ` +
          `fallbackSet=${input.fallbackApiKey !== undefined} ` +
          `correlationId=${ctx.requestId}`,
      );

      return {
        ok: true,
        data: {
          fieldsWritten: persistResult.data.fieldsWritten,
          verifiedLatencyMs: latencyMs,
        },
      };
    },
  });
}
