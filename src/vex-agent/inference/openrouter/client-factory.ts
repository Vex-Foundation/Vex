/**
 * THE one place an inference client is built, for both backends the engine
 * speaks the OpenRouter dialect to (owner decision D1):
 *
 * | Mode | `serverURL` | bearer |
 * |---|---|---|
 * | `openrouter` (bring your own key) | `OPENROUTER_API_BASE_URL` | `OPENROUTER_API_KEY` |
 * | `vexcloud` | `vexCloudInferenceServerUrl()` (built-in host, dev override only when main allows it) | `VEX_CLOUD_SESSION_TOKEN` |
 *
 * Both values are ALWAYS passed explicitly. Since `@openrouter/sdk@1.4.x` an
 * omitted `serverURL` falls back to the `OPENROUTER_BASE_URL` environment
 * variable (`esm/lib/config.js` `serverURLFromOptions`) and an omitted
 * `apiKey` to `OPENROUTER_API_KEY` (`esm/lib/security.js`
 * `security?.apiKey ?? env().OPENROUTER_API_KEY`): in Vex Cloud mode that
 * second fallback would send the user's OpenRouter key to our gateway. A
 * missing credential therefore throws here, by name, instead of letting the
 * SDK pick one from the environment.
 */

import { OpenRouter } from "@openrouter/sdk";
import { HTTPClient, type Fetcher } from "@openrouter/sdk/lib/http.js";

import { OPENROUTER_API_BASE_URL } from "../../../lib/openrouter-client.js";
import { vexCloudInferenceServerUrl } from "../../../lib/vex-cloud-endpoint.js";
import {
  OPENROUTER_APP_TITLE,
  OPENROUTER_APP_URL,
  OPENROUTER_SDK_TIMEOUT_MS,
  type EnvConfig,
  type ProviderType,
} from "../config.js";
import { OPENROUTER_5XX_RETRY_BACKOFF, roundFetch } from "./round-fetch.js";

/** Where one client sends, and with which bearer. `apiKey` is a SECRET. */
export interface InferenceConnection {
  readonly mode: ProviderType;
  readonly serverURL: string;
  readonly apiKey: string;
}

/**
 * Resolve the connection for the loaded env. An explicit `AGENT_PROVIDER`
 * decides; without one the engine is in bring-your-own-key mode (the
 * registry's key-presence fallback).
 */
export function resolveInferenceConnection(
  env: Pick<EnvConfig, "agentProvider" | "openrouterApiKey" | "vexCloudSessionToken">,
): InferenceConnection {
  if (env.agentProvider === "vexcloud") {
    if (env.vexCloudSessionToken === null) {
      throw new Error("VEX_CLOUD_SESSION_TOKEN is required for the Vex Cloud provider (sign in to Vex Cloud)");
    }
    return { mode: "vexcloud", serverURL: vexCloudInferenceServerUrl(), apiKey: env.vexCloudSessionToken };
  }
  if (env.openrouterApiKey === null) {
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter provider");
  }
  return { mode: "openrouter", serverURL: OPENROUTER_API_BASE_URL, apiKey: env.openrouterApiKey };
}

/**
 * Build the SDK client for a connection. `fetcher` defaults to `roundFetch`,
 * which tears a signal-carrying body down on abort, runs 5xx retries with
 * abortable waits, and reads the Vex Cloud `x-vex-max-tokens` disclosure.
 */
export function createInferenceClient(
  connection: InferenceConnection,
  fetcher: Fetcher = roundFetch,
): OpenRouter {
  return new OpenRouter({
    apiKey: connection.apiKey,
    serverURL: connection.serverURL,
    httpReferer: OPENROUTER_APP_URL,
    appTitle: OPENROUTER_APP_TITLE,
    timeoutMs: OPENROUTER_SDK_TIMEOUT_MS,
    retryConfig: {
      strategy: "backoff",
      backoff: { ...OPENROUTER_5XX_RETRY_BACKOFF },
    },
    httpClient: new HTTPClient({ fetcher }),
  });
}
