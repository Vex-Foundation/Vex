/**
 * The strict subset converter for a user MCP tool's input schema (F12).
 *
 * A server's `inputSchema` is third-party JSON Schema. One walk over it returns
 * BOTH the Zod validator every call is checked against and the JSON Schema the
 * model is shown, rebuilt from what was accepted, so the model never sees a
 * key or a shape the validator would refuse.
 *
 * WHAT IS REFUSED, with a reason stored on the tool row (the tool is then
 * `unsupported` and never callable): `$ref`, `oneOf`, `anyOf`, `allOf`, `not`,
 * conditionals, pattern properties, free-form objects (an object with no
 * declared properties that admits extra keys), tuples, a type list with more
 * than one non-null type, numeric enums, nesting deeper than
 * `MAX_OBJECT_DEPTH`, more than `MAX_FIELDS` fields, and any unknown type.
 *
 * WHAT IS TIGHTENED: every object is strict, so an undeclared key is refused
 * even when the server allowed extra keys; every string is capped at
 * `MAX_STRING_CHARS` and every array at `MAX_ARRAY_ITEMS`, whatever the
 * server declared. A server's `pattern` is never compiled (a regular
 * expression from a third party is a denial-of-service surface), and is not
 * shown to the model either.
 */

import { z } from "zod";
import type { JsonSchema, JsonSchemaProperty } from "@vex-agent/tools/types.js";

const REFUSED_KEYS = [
  "$ref",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
] as const;

/** Object levels below the root. */
export const MAX_OBJECT_DEPTH = 3;
/** Declared fields across the whole schema. */
export const MAX_FIELDS = 30;
export const MAX_STRING_CHARS = 4_000;
export const MAX_ARRAY_ITEMS = 100;
const MAX_ENUM_VALUES = 100;
const MAX_FIELD_DESCRIPTION_CHARS = 200;

export type ConvertedInputSchema =
  | {
      readonly ok: true;
      readonly validator: z.ZodType<Record<string, unknown>>;
      readonly modelSchema: JsonSchema;
    }
  | { readonly ok: false; readonly reason: string };

class Unsupported extends Error {}

interface Walk {
  fields: number;
}

interface Converted {
  readonly zod: z.ZodType;
  readonly model: JsonSchemaProperty;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fieldDescription(node: Record<string, unknown>): { description?: string } {
  const raw = node.description;
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  return { description: raw.trim().slice(0, MAX_FIELD_DESCRIPTION_CHARS) };
}

function boundedInt(node: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = node[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Unsupported(`${path}: "${key}" must be a whole number`);
  }
  return value;
}

function finiteNumber(node: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = node[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Unsupported(`${path}: "${key}" must be a number`);
  }
  return value;
}

/** The node's one type and whether `null` is also admitted. */
function typeOf(node: Record<string, unknown>, path: string): { type: string; nullable: boolean } {
  const raw = node.type;
  if (typeof raw === "string") return { type: raw, nullable: false };
  if (Array.isArray(raw)) {
    const named = raw.filter((t): t is string => typeof t === "string");
    if (named.length !== raw.length) throw new Unsupported(`${path}: "type" is not a list of names`);
    const nonNull = named.filter((t) => t !== "null");
    if (nonNull.length !== 1) throw new Unsupported(`${path}: more than one type is not supported`);
    return { type: nonNull[0]!, nullable: nonNull.length !== named.length };
  }
  if (raw === undefined && Array.isArray(node.enum)) return { type: "string", nullable: false };
  if (raw === undefined && typeof node.const === "string") return { type: "string", nullable: false };
  throw new Unsupported(`${path}: no "type"`);
}

function convertString(node: Record<string, unknown>, path: string): Converted {
  const description = fieldDescription(node);
  const values: unknown[] | undefined = Array.isArray(node.enum)
    ? node.enum
    : typeof node.const === "string"
      ? [node.const]
      : undefined;
  if (values !== undefined) {
    if (values.length === 0 || values.length > MAX_ENUM_VALUES) {
      throw new Unsupported(`${path}: "enum" must list 1 to ${MAX_ENUM_VALUES} values`);
    }
    if (!values.every((v): v is string => typeof v === "string" && v.length <= MAX_STRING_CHARS)) {
      throw new Unsupported(`${path}: only text values are supported in "enum"`);
    }
    const strings = [...new Set(values as string[])];
    return {
      zod: z.enum(strings as [string, ...string[]]),
      model: { type: "string", enum: strings, ...description },
    };
  }
  const minLength = boundedInt(node, "minLength", path);
  const declaredMax = boundedInt(node, "maxLength", path);
  const maxLength = Math.min(declaredMax ?? MAX_STRING_CHARS, MAX_STRING_CHARS);
  if (minLength !== undefined && minLength > maxLength) {
    throw new Unsupported(`${path}: "minLength" is above the length Vex accepts`);
  }
  let zod = z.string().max(maxLength);
  if (minLength !== undefined) zod = zod.min(minLength);
  return {
    zod,
    model: { type: "string", ...(minLength !== undefined && minLength > 0 ? { minLength } : {}), ...description },
  };
}

function convertNumber(node: Record<string, unknown>, type: "number" | "integer", path: string): Converted {
  if (node.enum !== undefined || node.const !== undefined) {
    throw new Unsupported(`${path}: number values in "enum" are not supported`);
  }
  const minimum = finiteNumber(node, "minimum", path);
  const maximum = finiteNumber(node, "maximum", path);
  const exclusiveMinimum = finiteNumber(node, "exclusiveMinimum", path);
  const exclusiveMaximum = finiteNumber(node, "exclusiveMaximum", path);
  let zod = type === "integer" ? z.number().int() : z.number();
  if (minimum !== undefined) zod = zod.min(minimum);
  if (maximum !== undefined) zod = zod.max(maximum);
  if (exclusiveMinimum !== undefined) zod = zod.gt(exclusiveMinimum);
  if (exclusiveMaximum !== undefined) zod = zod.lt(exclusiveMaximum);
  return {
    zod,
    model: { type, ...(minimum !== undefined ? { minimum } : {}), ...fieldDescription(node) },
  };
}

function convertArray(node: Record<string, unknown>, path: string, depth: number, walk: Walk): Converted {
  if (!isRecord(node.items)) throw new Unsupported(`${path}: an array needs one "items" schema`);
  const items = convertNode(node.items, `${path}[]`, depth, walk);
  const minItems = boundedInt(node, "minItems", path);
  const declaredMax = boundedInt(node, "maxItems", path);
  const maxItems = Math.min(declaredMax ?? MAX_ARRAY_ITEMS, MAX_ARRAY_ITEMS);
  if (minItems !== undefined && minItems > maxItems) {
    throw new Unsupported(`${path}: "minItems" is above the items Vex accepts`);
  }
  let zod = z.array(items.zod).max(maxItems);
  if (minItems !== undefined) zod = zod.min(minItems);
  return {
    zod,
    model: {
      type: "array",
      items: items.model,
      ...(minItems !== undefined && minItems > 0 ? { minItems } : {}),
      ...fieldDescription(node),
    },
  };
}

function convertObject(
  node: Record<string, unknown>,
  path: string,
  depth: number,
  walk: Walk,
): { zod: z.ZodType<Record<string, unknown>>; properties: Record<string, JsonSchemaProperty>; required: string[] } {
  if (depth > MAX_OBJECT_DEPTH) throw new Unsupported(`${path}: nested deeper than ${MAX_OBJECT_DEPTH} levels`);
  const declared = node.properties;
  if (declared !== undefined && !isRecord(declared)) throw new Unsupported(`${path}: "properties" is not an object`);
  const names = declared === undefined ? [] : Object.keys(declared);
  if (names.length === 0 && depth > 0 && node.additionalProperties !== false) {
    throw new Unsupported(`${path}: an object with no declared fields is not supported`);
  }
  const rawRequired = node.required ?? [];
  if (!Array.isArray(rawRequired) || !rawRequired.every((r): r is string => typeof r === "string")) {
    throw new Unsupported(`${path}: "required" is not a list of field names`);
  }
  for (const name of rawRequired) {
    if (!names.includes(name)) throw new Unsupported(`${path}: "${name}" is required but not declared`);
  }
  const required = [...new Set(rawRequired)];
  const shape: Record<string, z.ZodType> = {};
  const properties: Record<string, JsonSchemaProperty> = {};
  for (const name of names) {
    walk.fields += 1;
    if (walk.fields > MAX_FIELDS) throw new Unsupported(`more than ${MAX_FIELDS} fields`);
    const child = convertNode((declared as Record<string, unknown>)[name], `${path}.${name}`, depth + 1, walk);
    shape[name] = required.includes(name) ? child.zod : child.zod.optional();
    properties[name] = child.model;
  }
  return { zod: z.object(shape).strict() as z.ZodType<Record<string, unknown>>, properties, required };
}

function convertNode(raw: unknown, path: string, depth: number, walk: Walk): Converted {
  if (!isRecord(raw)) throw new Unsupported(`${path}: not a schema`);
  for (const key of REFUSED_KEYS) {
    if (key in raw) throw new Unsupported(`${path}: "${key}" is not supported`);
  }
  const { type, nullable } = typeOf(raw, path);
  let converted: Converted;
  switch (type) {
    case "string":
      converted = convertString(raw, path);
      break;
    case "number":
    case "integer":
      converted = convertNumber(raw, type, path);
      break;
    case "boolean":
      converted = { zod: z.boolean(), model: { type: "boolean", ...fieldDescription(raw) } };
      break;
    case "array":
      converted = convertArray(raw, path, depth, walk);
      break;
    case "object": {
      const object = convertObject(raw, path, depth, walk);
      converted = {
        zod: object.zod,
        model: {
          type: "object",
          properties: object.properties,
          ...(object.required.length > 0 ? { required: object.required } : {}),
          additionalProperties: false,
          ...fieldDescription(raw),
        },
      };
      break;
    }
    default:
      throw new Unsupported(`${path}: type "${type}" is not supported`);
  }
  if (!nullable) return converted;
  const { description, ...inner } = converted.model;
  return {
    zod: converted.zod.nullable(),
    model: {
      anyOf: [inner as JsonSchemaProperty, { type: "null" }],
      ...(description !== undefined ? { description } : {}),
    },
  };
}

/**
 * Convert a tool's input schema. The root must be an object (the MCP
 * `inputSchema` contract); a root with no declared fields is a tool that
 * takes no arguments, and still refuses every key.
 */
export function convertInputSchema(raw: unknown): ConvertedInputSchema {
  try {
    if (!isRecord(raw)) throw new Unsupported("the input schema is not an object");
    for (const key of REFUSED_KEYS) {
      if (key in raw) throw new Unsupported(`"${key}" is not supported`);
    }
    if (raw.type !== undefined && raw.type !== "object") {
      throw new Unsupported("the input schema must describe an object");
    }
    const walk: Walk = { fields: 0 };
    const object = convertObject(raw, "input", 0, walk);
    return {
      ok: true,
      validator: object.zod,
      modelSchema: {
        type: "object",
        properties: object.properties,
        ...(object.required.length > 0 ? { required: object.required } : {}),
        additionalProperties: false,
      },
    };
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, reason: error.message.slice(0, 200) };
    throw error;
  }
}
