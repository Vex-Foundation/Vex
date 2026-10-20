/**
 * Cross-boundary re-export of the OpenRouter SDK so vex-app (Electron
 * main) can construct a client via `@vex-lib/openrouter-client.js`
 * without dragging in the engine's `OpenRouterProvider` class — which
 * pulls `loadEnvConfig` + `@utils/logger.js` + a bunch of transitive
 * engine deps that have no place in vex-app main.
 *
 * Both the SDK class AND the HTTP-client error classes are exported
 * as RUNTIME VALUES (not `export type {}`) because `mapSdkError` in
 * vex-app uses `instanceof` checks — those require a runtime
 * reference (codex turn 4 implementation caveat).
 *
 * `HTTPClient` (runtime value) + `ResponseHook` (type) are exported for the
 * reasoning-capability response hook (S6/D1a) — `provider-model-catalog.ts`
 * attaches a hook to a per-request `HTTPClient` to read the raw `/models`
 * JSON before the SDK's own schema strips the `reasoning` object.
 *
 * Used by:
 *   - `vex-app/src/main/onboarding/openrouter-test-client.ts` (M10)
 *   - `vex-app/src/main/onboarding/provider-model-catalog.ts` (S6)
 *   - `vex-app/src/main/onboarding/provider-model-reasoning-hook.ts` (S6)
 */

export { OpenRouter, HTTPClient } from "@openrouter/sdk";

/**
 * The only OpenRouter API origin Vex talks to. Every `new OpenRouter(...)` in
 * production code passes it as `serverURL`: since `@openrouter/sdk@1.4.x` an
 * omitted server option falls back to the `OPENROUTER_BASE_URL` environment
 * variable (`esm/lib/config.js` `serverURLFromOptions`), so an unpinned keyed
 * client could be redirected to another host by the process environment.
 */
export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
export type { Fetcher, ResponseHook } from "@openrouter/sdk/lib/http.js";
export {
  ConnectionError,
  InvalidRequestError,
  RequestAbortedError,
  RequestTimeoutError,
  UnexpectedClientError,
} from "@openrouter/sdk/models/errors/httpclienterrors.js";
export { OpenRouterError } from "@openrouter/sdk/models/errors/openroutererror.js";
