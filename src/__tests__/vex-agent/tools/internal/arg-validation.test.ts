/**
 * The shared model-boundary argument hygiene owner.
 *
 * The two properties every consumer depends on:
 *   1. `issue.path` reaches the model. zod 4 never puts the field name in
 *      `issue.message`, so a formatter that drops the path produces an error
 *      naming nothing — the defect this module was extracted to end.
 *   2. VALUES never reach the model. Only shapes (rule 06).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  describeReceivedValue,
  dropEmptyModelValues,
  formatZodIssueForModel,
  formatZodIssuesForModel,
} from "@vex-agent/tools/internal/arg-validation.js";

describe("formatZodIssueForModel — the path is mandatory", () => {
  const schema = z.object({
    tokenIn: z.string().min(1, { message: "tokenIn is required" }),
    limit: z.number().int().positive(),
  });

  it("names the field zod's message does not", () => {
    const parsed = schema.safeParse({ tokenIn: "x", limit: 0 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // zod's own message names nothing — this is the whole reason the module
    // exists. "Too small: expected number to be >0" is true of any field.
    expect(parsed.error.issues[0]?.message).not.toContain("limit");
    expect(formatZodIssueForModel(parsed.error.issues[0], { tokenIn: "x", limit: 0 }))
      .toContain("limit:");
  });

  it("turns an empty value into the empty-means-absent instruction", () => {
    const parsed = schema.safeParse({ tokenIn: "", limit: 1 });
    if (parsed.success) throw new Error("expected failure");
    const message = formatZodIssueForModel(parsed.error.issues[0], { tokenIn: "", limit: 1 });
    expect(message).toContain("an empty string");
    expect(message).toContain("means ABSENT");
  });

  it("never echoes the value — only its shape", () => {
    const secret = "sk-live-do-not-log";
    const parsed = z.object({ q: z.string().max(3) }).safeParse({ q: secret });
    if (parsed.success) throw new Error("expected failure");
    const message = formatZodIssueForModel(parsed.error.issues[0], { q: secret });
    expect(message).not.toContain(secret);
    expect(message).toContain("q:");
  });

  it("does not restate a type the schema message already names", () => {
    const parsed = schema.safeParse({ tokenIn: "x", limit: "5" });
    if (parsed.success) throw new Error("expected failure");
    const message = formatZodIssueForModel(parsed.error.issues[0], { tokenIn: "x", limit: "5" });
    expect(message).toContain("limit:");
    expect(message).not.toContain("(received a string)");
  });

  it("adds the shape when a custom message does not name it", () => {
    const amountSchema = z.object({
      amountIn: z.union([z.string(), z.number()])
        .refine(() => false, { message: "amountIn must be a human decimal" }),
    });
    const parsed = amountSchema.safeParse({ amountIn: 42 });
    if (parsed.success) throw new Error("expected failure");
    expect(formatZodIssueForModel(parsed.error.issues[0], { amountIn: 42 }))
      .toContain("(received a number)");
  });

  it("leaves a pathless issue (a top-level refine) unadorned", () => {
    const refined = z.object({ a: z.string().optional() })
      .refine(() => false, { message: "Provide exactly one of `a` or `b`" });
    const parsed = refined.safeParse({ a: "x" });
    if (parsed.success) throw new Error("expected failure");
    expect(formatZodIssueForModel(parsed.error.issues[0], { a: "x" }))
      .toBe("Provide exactly one of `a` or `b`");
  });

  it("locates every issue, not just the first", () => {
    const parsed = schema.safeParse({});
    if (parsed.success) throw new Error("expected failure");
    const message = formatZodIssuesForModel(parsed.error.issues, {});
    expect(message).toContain("tokenIn:");
    expect(message).toContain("limit:");
  });

  it("falls back rather than throwing on no issue", () => {
    expect(formatZodIssueForModel(undefined, {})).toBe("invalid arguments");
    expect(formatZodIssuesForModel([], {})).toBe("invalid arguments");
  });
});

describe("dropEmptyModelValues", () => {
  it("drops empty strings, lists, objects and nulls, recursively", () => {
    expect(dropEmptyModelValues({
      query: "",
      cursor: "   ",
      fromUsers: [],
      filter: { top: "" },
      cashtags: ["VEX"],
      note: null,
    })).toEqual({ cashtags: ["VEX"] });
  });

  it("keeps false and 0 — they are values, not blanks", () => {
    expect(dropEmptyModelValues({ list: false, limit: 0 })).toEqual({ list: false, limit: 0 });
  });

  it("never mutates its input", () => {
    const input = { a: "", b: "x" };
    dropEmptyModelValues(input);
    expect(input).toEqual({ a: "", b: "x" });
  });

  it("returns a non-object untouched so zod reports the real type error", () => {
    expect(dropEmptyModelValues("not-an-object")).toBe("not-an-object");
    expect(dropEmptyModelValues(null)).toBe(null);
  });

  it("preserves a discriminator so an empty one fails as an unknown action", () => {
    expect(dropEmptyModelValues({ action: "", chain: "" }, { preserveKeys: ["action"] }))
      .toEqual({ action: "" });
  });

  it("preserves null on request — it is `clear this field`, not `nothing`", () => {
    expect(dropEmptyModelValues({ title: null, goal: "" }, { preserveNull: true }))
      .toEqual({ title: null });
  });
});

describe("describeReceivedValue — shape, never value", () => {
  it.each([
    [{ k: "" }, "an empty string"],
    [{ k: "  " }, "an empty string"],
    [{ k: "real" }, "a string"],
    [{ k: [] }, "an empty list"],
    [{ k: [1] }, "a list"],
    [{ k: {} }, "an empty object"],
    [{ k: { a: 1 } }, "an object"],
    [{ k: 42 }, "a number"],
    [{ k: true }, "a boolean"],
    [{ k: null }, "null"],
  ])("%o → %s", (params, expected) => {
    expect(describeReceivedValue(params, ["k"])).toBe(expected);
  });

  it("returns null for an absent or unreachable path", () => {
    expect(describeReceivedValue({}, ["k"])).toBeNull();
    expect(describeReceivedValue({ k: "s" }, ["k", "deeper"])).toBeNull();
  });
});
