/**
 * D2 live probe (rule 10): does the OpenRouter path promote a zero-required
 * tool schema's properties to `required` before the model sees it?
 *
 * The 2026-08-27 loop INFERRED promotion from the model's own reasoning
 * ("the schema tool needs to have all keys listed"). Inference is not
 * measurement. This sends the schema production actually sends and archives the
 * transformed upstream body the provider reports receiving.
 *
 *   pnpm exec tsx scripts/probe-openrouter-required-promotion.ts <out-dir>
 *
 * Requires `OPENROUTER_API_KEY`. Optional `PROBE_MODEL` (default
 * `z-ai/glm-5.3`, the incident model). The credential is never printed and
 * never archived.
 *
 * THE SCHEMA IS BUILT BY THE PRODUCTION CODE, NOT BY HAND. A hand-written
 * approximation would answer a question nobody asked: the whole point is what
 * happens to OUR bytes. It runs the real projection
 * (`protocolToolInputSchema`, which is what `buildInjectedProtocolTools` uses)
 * through the real provider normalizer (`normalizeToolSchemaForProvider`, the
 * OpenRouter boundary at `inference/openrouter/params.ts`) and wraps it in the
 * same `{type:"function", function:{name, description, parameters}}` envelope
 * that module emits. If `dexscreener__pairs_new_list` ever gains a required
 * param, this probe stops being about a zero-required schema and says so rather
 * than silently testing something else.
 *
 * FAIL CLOSED. If the echoed body does not contain a locatable `parameters`
 * object for our tool, the probe reports NOT MEASURED and archives the echo for
 * inspection. It must never report "no required list found" when what actually
 * happened is "we could not find the schema".
 *
 * Politeness: one request per model, no retries, a bounded token budget.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import { protocolToolInputSchema } from "@vex-agent/tools/registry/protocol-tool-projection.js";
import { normalizeToolSchemaForProvider } from "@vex-agent/inference/schema-normalizer.js";

const OUT_DIR = process.argv[2];
if (OUT_DIR === undefined || OUT_DIR === "") {
  console.error("Usage: pnpm exec tsx scripts/probe-openrouter-required-promotion.ts <out-dir>");
  process.exit(2);
}

const KEY = process.env.OPENROUTER_API_KEY;
if (KEY === undefined || KEY === "") {
  console.error("OPENROUTER_API_KEY is not set - probe not run, nothing archived.");
  process.exit(2);
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.PROBE_MODEL ?? "z-ai/glm-5.3";
const TOOL_ID = "dexscreener.pairs.new";

const manifest = getProtocolManifest(TOOL_ID);
if (manifest === undefined) {
  console.error(`${TOOL_ID} is not in the catalog - the probe's subject no longer exists.`);
  process.exit(3);
}

// Bound after the guard above: the narrowing does not survive into the closure
// that reads the name when the echo comes back.
const PUBLIC_NAME = manifest.publicName;

const parameters = normalizeToolSchemaForProvider(protocolToolInputSchema(manifest));
const TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: PUBLIC_NAME,
    description: manifest.description,
    parameters,
  },
};

/** The premise the probe rests on, checked rather than assumed. */
const sentRequired = (parameters as { required?: unknown }).required;
const premiseHolds = sentRequired === undefined;

const body = {
  model: MODEL,
  stream: true,
  debug: { echo_upstream_body: true },
  max_tokens: 128,
  messages: [
    {
      role: "user",
      content:
        "Show me the 3 freshest tokens on Solana. Call the tool with only the "
        + "parameters you actually need.",
    },
  ],
  tools: [TOOL_SCHEMA],
};

const started = new Date().toISOString();
const response = await fetch(ENDPOINT, {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

if (!response.ok || response.body === null) {
  const text = await response.text();
  console.error(`Probe HTTP ${response.status}. Body: ${text.slice(0, 2000)}`);
  process.exit(1);
}

const requestId = response.headers.get("x-request-id");
const decoder = new TextDecoder();
let buffered = "";
let echo: unknown = null;
let providerName: string | null = null;

/**
 * Streaming tool-call arguments arrive as FRAGMENTS: each delta carries a slice
 * of the JSON string for a given call index. Concatenating per index is the
 * only way to end up with the arguments the model actually emitted; collecting
 * the deltas and calling that "the arguments" (the first draft of this probe)
 * reports a truncated first chunk as if it were the whole call.
 */
const argumentFragments = new Map<number, string>();

for await (const chunk of response.body) {
  buffered += decoder.decode(chunk as Uint8Array, { stream: true });
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    // THE ECHO'S CARRIER IS NOT WHAT THE SDK TYPES SUGGEST. `DebugEvent`
    // declares a typed `{type: "response.debug"}` SSE event, but the live
    // stream (measured 2026-08-28, glm-5.3 via Friendli and gpt-5.6-sol) rides
    // the debug payload on an ORDINARY `chat.completion.chunk` whose `choices`
    // are empty. Keying off `type` found nothing and would have reported "no
    // required" for a body we never read. Read `debug` off ANY event, and keep
    // accepting the typed one in case a provider does emit it.
    const debug = event["debug"] as Record<string, unknown> | undefined;
    if (debug !== undefined && debug !== null) {
      const echoed = debug["echo_upstream_body"] ?? debug["echoUpstreamBody"];
      if (echoed !== undefined && echoed !== null) echo = echoed;
    }
    if (typeof event["provider"] === "string") providerName = event["provider"];
    const choices = event["choices"] as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
    const calls = delta?.["tool_calls"] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(calls)) continue;
    for (const [position, call] of calls.entries()) {
      const index = typeof call["index"] === "number" ? call["index"] : position;
      const fn = call["function"] as Record<string, unknown> | undefined;
      const fragment = fn?.["arguments"];
      if (typeof fragment !== "string") continue;
      argumentFragments.set(index, (argumentFragments.get(index) ?? "") + fragment);
    }
  }
}

/**
 * The emitted `parameters` for our tool, wherever the gateway put them.
 *
 * OpenRouter echoes an upstream body in the UPSTREAM provider's dialect, and
 * those differ: the OpenAI-style shape nests under `function`, while other
 * dialects put `name`/`parameters` (or `input_schema`) flat on the tool object.
 * Looking only in the nested place and reporting `null` otherwise would print
 * "no required" for a body we simply failed to read.
 */
function locateEmittedParameters(echoed: unknown): {
  readonly parameters: Record<string, unknown> | null;
  readonly shape: string;
} {
  if (echoed === null || typeof echoed !== "object") return { parameters: null, shape: "no-echo" };
  const tools = (echoed as Record<string, unknown>)["tools"];
  if (!Array.isArray(tools)) return { parameters: null, shape: "no-tools-array" };

  for (const [index, tool] of tools.entries()) {
    if (tool === null || typeof tool !== "object") continue;
    const entry = tool as Record<string, unknown>;
    const fn = entry["function"] as Record<string, unknown> | undefined;
    const nestedName = fn?.["name"];
    const flatName = entry["name"];
    const isOurs =
      nestedName === PUBLIC_NAME
      || flatName === PUBLIC_NAME
      || tools.length === 1;
    if (!isOurs) continue;

    const nested = fn?.["parameters"];
    if (nested !== null && typeof nested === "object") {
      return { parameters: nested as Record<string, unknown>, shape: `tools[${index}].function.parameters` };
    }
    for (const key of ["parameters", "input_schema", "inputSchema"] as const) {
      const flat = entry[key];
      if (flat !== null && typeof flat === "object") {
        return { parameters: flat as Record<string, unknown>, shape: `tools[${index}].${key}` };
      }
    }
  }
  return { parameters: null, shape: "tool-found-but-no-parameters" };
}

const located = locateEmittedParameters(echo);
const emittedRequired = located.parameters === null ? null : located.parameters["required"] ?? null;

const verdict = echo === null
  ? "NOT MEASURED: no response.debug chunk arrived"
  : located.parameters === null
    ? `NOT MEASURED: could not locate the emitted parameters (${located.shape})`
    : !premiseHolds
      ? "PREMISE BROKEN: the compiled schema already carries `required`, so this tool no longer tests promotion"
      : Array.isArray(emittedRequired) && emittedRequired.length > 0
        ? "PROMOTION CONFIRMED"
        : "PROMOTION REFUTED";

const emittedArguments = [...argumentFragments.entries()]
  .sort(([a], [b]) => a - b)
  .map(([index, raw]) => {
    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    return { index, raw, parsed, parseError, reassembledFromFragments: true };
  });

const artifact = {
  probe: "openrouter-required-promotion",
  question:
    "Does the OpenRouter path add a `required` list to a tool schema that was sent without one?",
  verdict,
  provenance: {
    startedIso: started,
    finishedIso: new Date().toISOString(),
    endpoint: ENDPOINT,
    model: MODEL,
    provider: providerName,
    openRouterRequestId: requestId,
    method: "streaming debug.echo_upstream_body (carried on an ordinary chunk with empty choices)",
    schemaSource:
      "protocolToolInputSchema(getProtocolManifest('dexscreener.pairs.new')) "
      + "-> normalizeToolSchemaForProvider, i.e. the production projection and the "
      + "OpenRouter-boundary normalizer, wrapped as inference/openrouter/params.ts wraps it",
  },
  sentTool: TOOL_SCHEMA,
  sentRequired: sentRequired ?? null,
  zeroRequiredPremiseHolds: premiseHolds,
  emittedParametersLocation: located.shape,
  emittedParameters: located.parameters,
  emittedRequired,
  emittedArguments,
  echoedUpstreamBody: echo,
};

await mkdir(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, `openrouter-required-promotion-${MODEL.replace(/\W+/g, "-")}.json`);
await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(`${verdict}. emitted required = ${JSON.stringify(emittedRequired)}`);
console.log(`Archived: ${file}`);
if (verdict.startsWith("NOT MEASURED") || verdict.startsWith("PREMISE BROKEN")) process.exit(1);
