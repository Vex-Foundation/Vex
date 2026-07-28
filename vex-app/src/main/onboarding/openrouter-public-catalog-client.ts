/**
 * Keyless OpenRouter client for PUBLIC catalogue reads (`/models`,
 * `/models/{author}/{slug}/endpoints`).
 *
 * Owns one security invariant so it cannot drift between the two catalogue
 * modules that depend on it. Extracted from `provider-model-catalog.ts` when
 * the endpoint catalogue became a second caller; the invariant below is that
 * module's original comment, unchanged.
 */

import {
  HTTPClient,
  OpenRouter,
  type Fetcher,
  type ResponseHook,
} from "@vex-lib/openrouter-client.js";
import {
  OPENROUTER_APP_TITLE,
  OPENROUTER_APP_URL,
  OPENROUTER_NOOP_LOGGER,
} from "./openrouter-app-identity.js";

export interface PublicCatalogClientOptions {
  readonly timeoutMs: number;
  /**
   * Test-only override of the underlying `fetch`, so tests can drive the REAL
   * production wiring (default client + `HTTPClient`) with a controlled
   * network layer instead of a real fetch.
   */
  readonly fetcher?: Fetcher | undefined;
  /** Optional response hook (the `/models` reasoning-capability sniffer). */
  readonly responseHook?: ResponseHook | undefined;
}

export function createPublicOpenRouterClient(
  options: PublicCatalogClientOptions,
): OpenRouter {
  const httpClient = new HTTPClient({ fetcher: options.fetcher });
  return new OpenRouter({
    httpReferer: OPENROUTER_APP_URL,
    appTitle: OPENROUTER_APP_TITLE,
    timeoutMs: options.timeoutMs,
    retryConfig: { strategy: "none" },
    debugLogger: OPENROUTER_NOOP_LOGGER,
    httpClient:
      options.responseHook === undefined
        ? httpClient
        : httpClient.addHook("response", options.responseHook),
    // SECURITY: this client fetches PUBLIC catalogue data and must NEVER
    // carry the user's OpenRouter key, even after vault unlock has populated
    // `process.env.OPENROUTER_API_KEY` for the privileged engine client.
    // Omitting `apiKey` here does NOT achieve that: the SDK's
    // `resolveGlobalSecurity` (node_modules/@openrouter/sdk/esm/lib/security.js)
    // reads `security?.apiKey ?? env().OPENROUTER_API_KEY` — a nullish
    // (omitted/undefined) `apiKey` silently falls back to the env var and
    // attaches it as `Authorization: Bearer <key>` (confirmed with an
    // intercepted fetcher). An explicit empty string is NOT nullish, so it
    // defeats that `??` fallback; `resolveSecurity`'s own value check then
    // treats an empty string as "no security provided" (`!!"" === false`)
    // and skips the Authorization header entirely — verify both steps
    // against the installed SDK before changing this.
    apiKey: "",
  });
}
