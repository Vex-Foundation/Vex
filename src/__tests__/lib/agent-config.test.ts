/**
 * Tests for shared agent-config helpers (M9).
 *
 * Covers:
 *  - Field metadata constants are wired to the right keys/ranges.
 *  - parseAgentEnv: blank/whitespace = unset/default; literal "0"
 *    accepted; trailing garbage rejected via Number() (not parseFloat);
 *    out-of-range reported with min/max detail; ALL agent errors
 *    aggregated (no early-return).
 *  - formatParseErrors stable shape.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_CONTEXT_LIMIT,
  AGENT_MAX_OUTPUT_TOKENS,
  AGENT_TEMPERATURE,
  formatParseErrors,
  parseAgentEnv,
} from "../../lib/agent-config.js";

describe("agent-config field metadata", () => {
  it("AGENT_CONTEXT_LIMIT range + default", () => {
    expect(AGENT_CONTEXT_LIMIT.key).toBe("AGENT_CONTEXT_LIMIT");
    expect(AGENT_CONTEXT_LIMIT.kind).toBe("int");
    expect(AGENT_CONTEXT_LIMIT.min).toBe(1000);
    expect(AGENT_CONTEXT_LIMIT.max).toBe(2_000_000);
    expect(AGENT_CONTEXT_LIMIT.default).toBe(256_000);
  });

  it("AGENT_TEMPERATURE has null default (no fixed value)", () => {
    expect(AGENT_TEMPERATURE.kind).toBe("float");
    expect(AGENT_TEMPERATURE.default).toBeNull();
  });
});

describe("parseAgentEnv", () => {
  it("returns defaults when env empty", () => {
    const r = parseAgentEnv({});
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ contextLimit: 256_000, maxOutputTokens: 16_384, temperature: null });
  });

  it("blank string = unset (preserves engine contract)", () => {
    const r = parseAgentEnv({ AGENT_TEMPERATURE: "", AGENT_CONTEXT_LIMIT: "" });
    expect(r.errors).toEqual([]);
    expect(r.value.temperature).toBeNull();
    expect(r.value.contextLimit).toBe(256_000);
  });

  it("whitespace-only = unset", () => {
    const r = parseAgentEnv({ AGENT_TEMPERATURE: "   ", AGENT_CONTEXT_LIMIT: "  \t " });
    expect(r.errors).toEqual([]);
    expect(r.value.temperature).toBeNull();
    expect(r.value.contextLimit).toBe(256_000);
  });

  it("literal 0 accepted for temperature", () => {
    const r = parseAgentEnv({ AGENT_TEMPERATURE: "0" });
    expect(r.errors).toEqual([]);
    expect(r.value.temperature).toBe(0);
  });

  it("0.7 parses cleanly", () => {
    const r = parseAgentEnv({ AGENT_TEMPERATURE: "0.7" });
    expect(r.errors).toEqual([]);
    expect(r.value.temperature).toBeCloseTo(0.7);
  });

  it("rejects trailing garbage in float (Number, not parseFloat)", () => {
    const r = parseAgentEnv({ AGENT_TEMPERATURE: "0.7abc" });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.key).toBe("AGENT_TEMPERATURE");
    expect(r.errors[0]?.reason).toBe("not_a_number");
    expect(r.value.temperature).toBeNull();
  });

  it("rejects float in int field (regex /^-?\\d+$/)", () => {
    const r = parseAgentEnv({ AGENT_CONTEXT_LIMIT: "1500.5" });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.key).toBe("AGENT_CONTEXT_LIMIT");
    expect(r.errors[0]?.reason).toBe("not_a_number");
  });

  it("reports out_of_range with min/max detail", () => {
    const r = parseAgentEnv({ AGENT_TEMPERATURE: "99" });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      key: "AGENT_TEMPERATURE",
      raw: "99",
      reason: "out_of_range",
      detail: { min: 0, max: 2 },
    });
  });

  it("aggregates ALL agent errors (no early return)", () => {
    const r = parseAgentEnv({
      AGENT_CONTEXT_LIMIT: "abc",
      AGENT_MAX_OUTPUT_TOKENS: "xyz",
      AGENT_TEMPERATURE: "9999",
    });
    expect(r.errors).toHaveLength(3);
    const keys = r.errors.map((e) => e.key);
    expect(keys).toContain("AGENT_CONTEXT_LIMIT");
    expect(keys).toContain("AGENT_MAX_OUTPUT_TOKENS");
    expect(keys).toContain("AGENT_TEMPERATURE");
  });

  it("partial valid + partial invalid: keeps valid, errors invalid", () => {
    const r = parseAgentEnv({ AGENT_CONTEXT_LIMIT: "64000", AGENT_TEMPERATURE: "bad" });
    expect(r.value.contextLimit).toBe(64_000);
    expect(r.value.temperature).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.key).toBe("AGENT_TEMPERATURE");
  });

  it("undefined / null env values treated as unset", () => {
    const r = parseAgentEnv({
      AGENT_CONTEXT_LIMIT: undefined,
      AGENT_TEMPERATURE: null,
    });
    expect(r.errors).toEqual([]);
    expect(r.value.contextLimit).toBe(256_000);
    expect(r.value.temperature).toBeNull();
  });
});

describe("formatParseErrors", () => {
  it("formats out_of_range with min/max", () => {
    const out = formatParseErrors("Bad agent env:", [
      { key: "AGENT_TEMPERATURE", raw: "99", reason: "out_of_range", detail: { min: 0, max: 2 } },
    ]);
    expect(out).toContain("Bad agent env:");
    expect(out).toContain('AGENT_TEMPERATURE="99"');
    expect(out).toContain("out of range 0..2");
  });

  it("formats not_a_number plainly", () => {
    const out = formatParseErrors("X:", [{ key: "AGENT_CONTEXT_LIMIT", raw: "abc", reason: "not_a_number" }]);
    expect(out).toContain('AGENT_CONTEXT_LIMIT="abc"');
    expect(out).toContain("not a number");
  });

  it("handles multiple errors on separate lines", () => {
    const out = formatParseErrors("Bad:", [
      { key: "A", raw: "1", reason: "out_of_range", detail: { min: 5, max: 10 } },
      { key: "B", raw: "x", reason: "not_a_number" },
    ]);
    const lines = out.split("\n");
    expect(lines.length).toBe(3);
  });
});
