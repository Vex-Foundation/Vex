/**
 * vex.onboarding.providerPersist — Wizard Step 6 IPC handler (M10).
 *
 * Verify-then-persist atomically (codex turn 2 RED #1):
 *   0. Resolve the key to verify with. `apiKey` is OPTIONAL on the input:
 *      absent ⇒ the operator is changing only the model/endpoint from the
 *      configured screen, so main loads the stored key from the encrypted
 *      vault (`readUnlockedSecret`) and verifies with THAT. The stored key
 *      never crosses IPC in either direction — the renderer sends nothing
 *      and receives nothing. No stored key and none supplied ⇒
 *      `provider.api_key_required`, nothing written.
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
import { err, type Result } from "@shared/ipc/result.js";
import {
  providerPersistInputSchema,
  providerPersistResultSchema,
  type ProviderPersistResult,
} from "@shared/schemas/provider.js";
import { writeProvider } from "../../onboarding/provider-writer.js";
import { isKnownToolCapableEndpoint } from "../../onboarding/provider-endpoint-catalog.js";
import { verifyOpenRouterConnection } from "../../onboarding/openrouter-test-client.js";
import { withEnvWriteLock } from "../../onboarding/env-write-mutex.js";
import { readUnlockedSecret } from "../../secrets/session.js";
import { loadProviderDotenv } from "@vex-lib/runtime-env.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";

/**
 * Which OpenRouter key should this persist be verified against?
 *
 * Supplied ⇒ that one (a rotation). Absent ⇒ the one already in the encrypted
 * vault. Never returns a key to the caller's caller: the value is consumed
 * main-side by `verifyOpenRouterConnection` only, and the failure paths carry
 * codes/messages that contain no key material.
 */
function resolveApiKeyToVerify(
  suppliedApiKey: string | undefined,
  correlationId: string,
): Result<string> {
  if (suppliedApiKey !== undefined) return { ok: true, data: suppliedApiKey };

  const stored = readUnlockedSecret("OPENROUTER_API_KEY");
  if (!stored.ok) return stored;
  if (stored.data !== null) return { ok: true, data: stored.data };

  return err({
    code: "provider.api_key_required",
    domain: "onboarding",
    message:
      "No OpenRouter API key is stored yet, so there is nothing to keep. Enter your key to save this configuration.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

export function registerProviderHandler(): () => void {
  return registerHandler({
    channel: CH.onboarding.providerPersist,
    domain: "onboarding",
    inputSchema: providerPersistInputSchema,
    outputSchema: providerPersistResultSchema,
    handle: async (input, ctx): Promise<Result<ProviderPersistResult>> => {
      // Step 0: resolve the key to verify with. The renderer may OMIT
      // `apiKey` to mean "keep the stored one" (delta save from the
      // configured screen), because the stored key never travels to the
      // renderer and so cannot be echoed back. Main loads it from the
      // encrypted vault instead. If nothing is stored either, refuse BY NAME
      // — a silent skip would persist a selection nothing ever verified.
      const keyResolution = resolveApiKeyToVerify(input.apiKey, ctx.requestId);
      if (!keyResolution.ok) {
        log.info(
          `[ipc:vex:onboarding:providerPersist] ` +
            `errCode=${keyResolution.error.code} correlationId=${ctx.requestId}`,
        );
        return keyResolution;
      }

      // Step 1: verify connection BEFORE any disk write. Same 16-token
      // completion on BOTH paths — a keep-key save is verified exactly as
      // strictly as a first-run save.
      const verifyResult = await verifyOpenRouterConnection(
        { apiKey: keyResolution.data, model: input.model },
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

      // Step 1b: authorise the optional endpoint pin. The renderer is
      // untrusted, so a tag is written only after it is proven to be one of
      // the tool-capable endpoints main itself projected for THIS model. An
      // unknown (or unverifiable) tag is rejected BY NAME rather than
      // silently dropped — a silent drop would tell the operator their
      // provider choice was saved while requests kept routing elsewhere.
      const endpointTag = input.endpointTag?.trim();
      if (endpointTag !== undefined && endpointTag.length > 0) {
        const known = await isKnownToolCapableEndpoint(
          input.model.trim(),
          endpointTag,
          { signal: ctx.signal },
        );
        if (!known) {
          log.info(
            `[ipc:vex:onboarding:providerPersist] ` +
              `errCode=provider.endpoint_unavailable correlationId=${ctx.requestId}`,
          );
          return err({
            code: "provider.endpoint_unavailable",
            domain: "onboarding",
            message: `"${endpointTag}" is not an available tool-capable provider for this model. Pick another provider or choose Auto.`,
            retryable: true,
            userActionable: true,
            redacted: true,
            correlationId: ctx.requestId,
          });
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
