/**
 * Exact wire-body size of an OpenRouter chat request.
 *
 * WHY THIS EXISTS AND WHY IT LIVES HERE
 *
 * The C8 pre-inference ceiling needs an upper bound on the prompt tokens a
 * request will consume, computed BEFORE the request is issued. Gate-0 §22
 * rejects the naive `{providerMessages, tools}` estimate plus a guessed
 * per-role overhead: the real request also carries model, max output tokens,
 * routing preferences, reasoning effort, tool choice, PROVIDER-NORMALIZED tool
 * schemas and the sticky session id — and the wire form is snake_case, not the
 * SDK's camelCase input shape.
 *
 * So this module does not estimate anything. It builds the request with the
 * SAME `buildOpenRouterParams` the two conversational send paths use, then
 * runs it through the SDK's OWN `ChatRequest$outboundSchema` — the exact
 * transform `funcs/chatSend.ts` applies before `encodeJSON` — and measures the
 * resulting JSON in UTF-8 bytes. The number is the request body itself, which
 * is why the superset property is PROVEN by construction rather than argued.
 * `request-bytes.test.ts` pins it against the SDK's send-path encoder
 * independently (through the operations wrapper), so an SDK upgrade that
 * changes the wire shape fails the test instead of silently invalidating the
 * ceiling.
 *
 * Knowledge of the wire shape belongs beside `params.ts`, not in the engine:
 * the engine states the POLICY (`engine/core/inference-envelope-bytes.ts`),
 * this module answers "how many bytes does this provider actually send".
 */

import { ChatRequest$outboundSchema } from "@openrouter/sdk/models/chatrequest.js";
import type {
  InferenceConfig,
  InferenceRequestContext,
  ProviderMessage,
  ToolDefinition,
} from "../types.js";
import { buildOpenRouterParams } from "./params.js";

/**
 * `stream` is the ONLY field that differs between the two conversational send
 * paths, and the SDK's outbound schema always emits it. `false` (5 characters)
 * serializes one byte LONGER than `true` (4), so measuring the non-streaming
 * shape bounds both paths. Verified by a test asserting the measurement is
 * `>=` the encoded body for `stream: true` AND `stream: false`.
 */
const MEASURE_WITH_STREAM = false;

/**
 * Serialized UTF-8 byte length of the request body OpenRouter would receive
 * for these messages/tools/config, or `null` when the SDK's outbound schema
 * rejects the params.
 *
 * `null` is a fail-closed signal, not an error to swallow into a number: the
 * caller must not proceed as if it had measured anything. Rejection here means
 * the request itself would fail at send time.
 */
export function measureOpenRouterRequestBodyBytes(args: {
  readonly messages: ProviderMessage[];
  readonly tools: ToolDefinition[];
  readonly config: InferenceConfig;
  readonly context?: InferenceRequestContext;
}): number | null {
  const params = buildOpenRouterParams(
    args.messages,
    args.tools,
    args.config,
    MEASURE_WITH_STREAM,
    undefined,
    args.context,
  );

  const parsed = ChatRequest$outboundSchema.safeParse(params);
  if (!parsed.success) return null;

  return Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
}
