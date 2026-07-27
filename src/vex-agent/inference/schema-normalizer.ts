/**
 * Tool-schema normalizer — provider strict-mode bridge.
 *
 * Mutates a JsonSchema into a shape acceptable by OpenAI/Azure/OpenRouter
 * strict validators by injecting the two field-level requirements that
 * regularly trip our hand-written schemas:
 *
 *   1. `items: { type: "string" }` on every bare `{type: "array"}` — Azure
 *      (via OpenRouter) and OpenAI strict reject arrays without an item
 *      schema. We default to `string` because every array param in our
 *      internal tool registry today is `string[]` (tags, namespaces,
 *      allowList). When a tool genuinely needs a non-string array, the
 *      author MUST declare `items` explicitly; the fallback is a safety
 *      net, not a substitute for accurate authoring.
 *   2. `additionalProperties: false` on every object that has `properties`
 *      defined — required by OpenAI strict; non-strict providers ignore.
 *
 * This is the **first slice of the per-provider projection layer** described
 * in `agents_dm/vex-tool-surface-longterm-architecture.md` Phase 1. The full
 * layer (six emitters keyed on `(provider, apiVersion)`) builds on this
 * baseline. OpenRouter calls this same function as the single source of truth
 * for tool-schema strict normalization.
 *
 * The function is idempotent and pure: passing the same schema twice yields
 * the same output and does not mutate the input. Tests in
 * `src/__tests__/vex-agent/inference/schema-normalizer.test.ts`.
 */

import type {
  JsonSchema,
  JsonSchemaProperty,
  JsonSchemaTypedProperty,
} from "@vex-agent/tools/types.js";

/**
 * Return a strict-mode-compliant copy of `schema` with:
 *   - bare arrays gaining `items: { type: "string" }`,
 *   - objects with `properties` gaining `additionalProperties: false` (when
 *     not already set).
 *
 * The original `schema` is not mutated.
 */
export function normalizeToolSchemaForProvider(schema: JsonSchema): JsonSchema {
  const normalizedProperties: Record<string, JsonSchemaProperty> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    normalizedProperties[key] = normalizeProperty(value);
  }

  return {
    type: "object",
    properties: normalizedProperties,
    ...(schema.required !== undefined && { required: schema.required }),
    additionalProperties: schema.additionalProperties ?? false,
  };
}

function normalizeProperty(property: JsonSchemaProperty): JsonSchemaProperty {
  // A union property (what a param declared `acceptsStringArray` compiles to)
  // carries its real shapes in the BRANCHES. Walking only `items`/`properties`
  // left a bare `{type:"array"}` branch without an item schema — precisely what
  // OpenAI strict and Azure reject, so the normalizer would have waved through
  // the very shape it exists to fix. It gains no `type` here either: `type`
  // beside `anyOf` conjoins and would make the array branch unsatisfiable.
  if (property.anyOf !== undefined) {
    return { ...property, anyOf: property.anyOf.map(normalizeProperty) };
  }

  const result: JsonSchemaTypedProperty = { ...property };

  if (property.type === "array") {
    // Inject default items schema only when missing — never overwrite an
    // explicit author-supplied `items` (even if it's narrower than string).
    if (property.items === undefined) {
      result.items = { type: "string" };
    } else {
      result.items = normalizeProperty(property.items);
    }
  }

  if (property.type === "object" && property.properties !== undefined) {
    const nested: Record<string, JsonSchemaProperty> = {};
    for (const [key, value] of Object.entries(property.properties)) {
      nested[key] = normalizeProperty(value);
    }
    result.properties = nested;
    result.additionalProperties = property.additionalProperties ?? false;
  }

  return result;
}
