/**
 * The STRICT MCP projection of a protocol manifest's parameters.
 *
 * ## Why this exists
 *
 * `tools/list` publishes a schema, and under `serveStdio` that schema is not
 * documentation: the SDK compiles it with Ajv2020 and REJECTS a `tools/call`
 * whose arguments fail it before the handler runs
 * (`studio-mcp/sdk-v2-api-pin.md` sections 5 and 7; `validateToolInput` in the
 * installed `@modelcontextprotocol/server`). So the advertised schema is an
 * admission gate, and an admission gate that is LOOSER than the runtime's own
 * boundary is a false contract: the client is told a call is well-formed, spends
 * the round trip, and is refused by `validateProtocolParams` for a rule the
 * schema never stated.
 *
 * The provider-facing compiler (`registry/khalani.ts::paramsToJsonSchema`)
 * emits exactly that looser shape - no `additionalProperties`, no value bounds -
 * and it is right to: it feeds model function-schemas, where extra keywords are
 * narrowed or rejected by provider validators and where the model is steered by
 * the description rather than gated by the schema. Two consumers, two different
 * strictness contracts, one shared source of truth in the manifest. This module
 * is the MCP half; it does not touch the provider half.
 *
 * ## THE CONTRACT THIS MODULE OWES
 *
 * **Anything this projection admits, `validateProtocolParams` admits.**
 * `strict-schema-parity.test.ts` proves it over every exported protocol tool.
 * The converse is deliberately NOT claimed - the projection is allowed to be
 * stricter than the runtime, and on two axes it is:
 *
 *   - a chain-valued param's `enum` is matched case-INSENSITIVELY by the
 *     runtime, and JSON Schema cannot say that, so the projection advertises the
 *     declared spelling only;
 *   - the runtime silently accepts a param whose value is `undefined`, which
 *     cannot appear in a JSON frame at all.
 *
 * ## What is deliberately NOT expressed
 *
 * CROSS-PARAM GROUP RULES (`exclusiveParamGroups`, `atMostOne`,
 * `atLeastOneOf`). JSON Schema states them only as `oneOf`/`anyOf` over required
 * sets, which is exactly the construct `protocol-tool-projection.ts` records as
 * being narrowed or rejected downstream, and which would make this schema and
 * the provider one structurally different rather than merely differently
 * bounded. They stay a RUNTIME rule, and they are already in the published
 * DESCRIPTION: `protocolToolDescription` appends
 * `describeParamGroupConstraints` verbatim, so the client reads the rule before
 * the call and is rejected by the same sentence after it. This is a declared
 * omission, not an oversight (rule 09: name the gap).
 */

import type { JsonSchema, JsonSchemaProperty } from "../../tools/types.js";
import type { ProtocolParamDef, ProtocolToolManifest } from "../../tools/protocols/types.js";
import { CHAIN_VALUE_PARAM_KEYS } from "../../tools/protocols/conventions.js";
import { RESERVED_RUNTIME_PARAM_KEYS } from "../../tools/protocols/runtime/params.js";

/**
 * The runtime's own control key, advertised so the projection does not become
 * STRICTER than the boundary on the one key `validateProtocolParams` accepts
 * without a manifest declaration. A manifest that declares `dryRun` itself wins;
 * this only fills the gap for one that does not.
 */
const DRY_RUN_KEY = "dryRun";

const DRY_RUN_PROPERTY: JsonSchemaProperty = {
  type: "boolean",
  description:
    "Simulate this call instead of executing it. Runtime control parameter: "
    + "when true the call is treated as a preview and nothing is broadcast.",
};

/**
 * One param as the strict projection states it.
 *
 * Every branch here mirrors a specific gate in `validateProtocolParams`, and the
 * comments name which one, because the two must be read together whenever
 * either changes.
 */
function strictProperty(param: ProtocolParamDef): JsonSchemaProperty {
  const values = param.enum && param.enum.length > 0 ? [...param.enum] : undefined;
  const description = param.description;

  // `acceptsStringArray` - the array branch carries `minItems: 1` only where the
  // runtime still refuses an empty array, which after the 2026-08-28 change is
  // REQUIRED params only (`checkStringArrayParam`). On an OPTIONAL param `[]`
  // now means the parameter is absent (`runtime/empty-array-params.ts`).
  //
  // Keeping `minItems: 1` on the optional branch would NOT violate the contract
  // above: a stricter projection is expressly allowed, and this would simply be
  // a third axis of it. It is dropped for a PRODUCT reason, not a contractual
  // one. A schema that says "at least one item" on a parameter which has no
  // other way to express "no filter" recreates the exact friction D1 removed -
  // it is the strict-gateway situation that put a model into seven identical
  // refusals on 2026-08-27. Admitting `[]` is what makes the absent case
  // expressible on this surface too.
  if (param.acceptsStringArray === true) {
    return {
      anyOf: [
        values ? { type: "string", enum: values } : { type: "string" },
        {
          type: "array",
          ...(param.required === true ? { minItems: 1 } : {}),
          items: values ? { type: "string", enum: values } : { type: "string" },
        },
      ],
      description,
    };
  }

  // CHAIN-VALUED string params - `normalizeChainValueParams` rewrites a
  // positive safe integer to its decimal string before the type gate, so an
  // integer really is admitted here and the projection must say so or it would
  // refuse a call the runtime supports. Bounded to `minimum: 1` because that is
  // the exact predicate the normalizer applies; a `0` or a negative would fall
  // through to the string type gate and be rejected.
  if (param.type === "string" && CHAIN_VALUE_PARAM_KEYS.includes(param.key)) {
    return {
      anyOf: [
        values
          ? { type: "string", enum: values }
          : { type: "string", ...(param.required === true ? { minLength: 1 } : {}) },
        { type: "integer", minimum: 1 },
      ],
      description,
    };
  }

  // BASIS POINTS - `checkBpsParam` requires a finite, whole, non-negative
  // number. `0.5` is the measured near-total-loss case that rule exists for, so
  // it must never be admitted by the advertised schema either.
  if (param.type === "number" && param.unit === "bps") {
    return { type: "integer", minimum: 0, description };
  }

  // REQUIRED STRINGS - the runtime's required gate treats `""` as MISSING, so
  // an empty string for a required param is rejected there and must not be
  // admitted here.
  if (param.type === "string" && param.required === true) {
    return values
      ? { type: "string", enum: values, description }
      : { type: "string", minLength: 1, description };
  }

  return values
    ? { type: param.type, enum: values, description }
    : { type: param.type, description };
}

/**
 * The manifest's params as the STRICT schema `tools/list` publishes.
 *
 * `additionalProperties: false` is the half of this that the audit found
 * missing: the runtime rejects every undeclared key with a defined value, and
 * without this keyword the advertised schema promised the opposite.
 */
export function strictProtocolToolInputSchema(manifest: ProtocolToolManifest): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const param of manifest.params) {
    properties[param.key] = strictProperty(param);
    if (param.required === true) required.push(param.key);
  }
  for (const reserved of RESERVED_RUNTIME_PARAM_KEYS) {
    if (reserved === DRY_RUN_KEY && properties[DRY_RUN_KEY] === undefined) {
      properties[DRY_RUN_KEY] = DRY_RUN_PROPERTY;
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
