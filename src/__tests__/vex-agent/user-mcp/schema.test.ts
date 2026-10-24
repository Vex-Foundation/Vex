import { describe, expect, it } from "vitest";
import { convertInputSchema, MAX_ARRAY_ITEMS, MAX_FIELDS, MAX_STRING_CHARS } from "@vex-agent/user-mcp/schema.js";

function accepted(schema: unknown) {
  const out = convertInputSchema(schema);
  if (!out.ok) throw new Error(`expected accepted, got: ${out.reason}`);
  return out;
}

function refused(schema: unknown): string {
  const out = convertInputSchema(schema);
  if (out.ok) throw new Error("expected refused");
  return out.reason;
}

describe("convertInputSchema: refused constructs", () => {
  for (const key of ["$ref", "oneOf", "anyOf", "allOf", "not", "if", "patternProperties"]) {
    it(`refuses "${key}" anywhere`, () => {
      expect(refused({ type: "object", properties: { a: { type: "string", [key]: {} } } })).toContain(key);
      expect(refused({ type: "object", [key]: {} })).toContain(key);
    });
  }

  it("refuses a free-form nested object", () => {
    expect(refused({ type: "object", properties: { meta: { type: "object" } } })).toMatch(/no declared fields/);
    expect(refused({ type: "object", properties: { meta: { type: "object", additionalProperties: true } } })).toMatch(
      /no declared fields/,
    );
  });

  it("refuses more than one non-null type, numeric enums, tuples and unknown types", () => {
    expect(refused({ type: "object", properties: { a: { type: ["string", "number"] } } })).toMatch(/more than one type/);
    expect(refused({ type: "object", properties: { a: { type: "number", enum: [1, 2] } } })).toMatch(/enum/);
    expect(refused({ type: "object", properties: { a: { type: "array", items: [{ type: "string" }] } } })).toMatch(/items/);
    expect(refused({ type: "object", properties: { a: { type: "file" } } })).toMatch(/not supported/);
    expect(refused({ type: "object", properties: { a: {} } })).toMatch(/no "type"/);
  });

  it("refuses a required field that is not declared, a non-object root, and deep nesting", () => {
    expect(refused({ type: "object", properties: {}, required: ["q"] })).toMatch(/required but not declared/);
    expect(refused({ type: "string" })).toMatch(/must describe an object/);
    const nest = (inner: unknown) => ({ type: "object", properties: { x: inner } });
    expect(convertInputSchema(nest(nest(nest({ type: "object", properties: { s: { type: "string" } } })))).ok).toBe(true);
    expect(refused(nest(nest(nest(nest({ type: "object", properties: { s: { type: "string" } } })))))).toMatch(/deeper/);
  });

  it(`refuses more than ${MAX_FIELDS} fields`, () => {
    const properties = Object.fromEntries(Array.from({ length: MAX_FIELDS + 1 }, (_, i) => [`f${i}`, { type: "string" }]));
    expect(refused({ type: "object", properties })).toMatch(/more than/);
  });
});

describe("convertInputSchema: what is accepted", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look up", pattern: "^(a+)+$", maxLength: 50 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
      mode: { type: "string", enum: ["fast", "deep"] },
      tags: { type: "array", items: { type: "string" }, maxItems: 5000 },
      note: { type: ["string", "null"] },
      filter: { type: "object", properties: { lang: { type: "string" } }, required: ["lang"], additionalProperties: true },
    },
    required: ["query"],
  };

  it("validates good arguments and refuses an undeclared key, also inside nested objects", () => {
    const { validator } = accepted(schema);
    expect(validator.safeParse({ query: "x", limit: 3, mode: "fast", tags: ["a"], note: null, filter: { lang: "en" } }).success).toBe(true);
    expect(validator.safeParse({ query: "x", extra: 1 }).success).toBe(false);
    expect(validator.safeParse({ query: "x", filter: { lang: "en", extra: 1 } }).success).toBe(false);
    expect(validator.safeParse({}).success).toBe(false);
    expect(validator.safeParse({ query: "x", limit: 21 }).success).toBe(false);
    expect(validator.safeParse({ query: "x", limit: 1.5 }).success).toBe(false);
    expect(validator.safeParse({ query: "x", mode: "slow" }).success).toBe(false);
  });

  it("caps strings and arrays whatever the server declared, and never compiles a pattern", () => {
    const { validator } = accepted(schema);
    expect(validator.safeParse({ query: "y".repeat(51) }).success).toBe(false);
    expect(validator.safeParse({ query: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!" }).success).toBe(true);
    expect(validator.safeParse({ query: "x", tags: Array(MAX_ARRAY_ITEMS + 1).fill("t") }).success).toBe(false);
    const open = accepted({ type: "object", properties: { q: { type: "string" } } });
    expect(open.validator.safeParse({ q: "z".repeat(MAX_STRING_CHARS + 1) }).success).toBe(false);
  });

  it("shows the model only what the validator accepts", () => {
    const { modelSchema } = accepted(schema);
    expect(modelSchema.additionalProperties).toBe(false);
    expect(modelSchema.required).toEqual(["query"]);
    expect(modelSchema.properties.query).toEqual({ type: "string", description: "What to look up" });
    expect(JSON.stringify(modelSchema)).not.toContain("pattern");
    expect(modelSchema.properties.filter).toMatchObject({ type: "object", additionalProperties: false, required: ["lang"] });
    expect(modelSchema.properties.note).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
  });

  it("accepts a tool with no arguments, and still refuses every key", () => {
    const { validator, modelSchema } = accepted({ type: "object" });
    expect(modelSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(validator.safeParse({}).success).toBe(true);
    expect(validator.safeParse({ a: 1 }).success).toBe(false);
  });
});
