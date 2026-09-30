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
  AGENT_DB_BOUND_FIELDS,
  formatParseErrors,
  parseAgentDbBoundsEnv,
  parseAgentEnv,
  parseAgentToolReadEnv,
  parseAgentWakeEnv,
  parseAgentWalletReadEnv,
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

describe("parseAgentDbBoundsEnv (Kairos S-4)", () => {
  it("returns the always-on defaults when unset", () => {
    const r = parseAgentDbBoundsEnv({});
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({
      statementTimeoutMs: 30_000,
      connectionTimeoutMs: 10_000,
      idleInTransactionTimeoutMs: 60_000,
      longStatementTimeoutMs: 300_000,
      controlPoolMax: 2,
    });
  });

  it("every field has a positive minimum, so no value disables a bound", () => {
    for (const field of AGENT_DB_BOUND_FIELDS) {
      expect(field.min).toBeGreaterThan(0);
      const r = parseAgentDbBoundsEnv({ [field.key]: "0" });
      expect(r.errors).toEqual([
        { key: field.key, raw: "0", reason: "out_of_range", detail: { min: field.min, max: field.max } },
      ]);
    }
  });

  it("accepts valid overrides", () => {
    const r = parseAgentDbBoundsEnv({
      AGENT_DB_STATEMENT_TIMEOUT_MS: "20000",
      AGENT_DB_CONNECTION_TIMEOUT_MS: "3000",
      AGENT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "90000",
      AGENT_DB_LONG_STATEMENT_TIMEOUT_MS: "600000",
      AGENT_DB_CONTROL_POOL_MAX: "4",
    });
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({
      statementTimeoutMs: 20_000,
      connectionTimeoutMs: 3_000,
      idleInTransactionTimeoutMs: 90_000,
      longStatementTimeoutMs: 600_000,
      controlPoolMax: 4,
    });
  });

  it("an invalid value is reported and its default applies", () => {
    const r = parseAgentDbBoundsEnv({ AGENT_DB_CONTROL_POOL_MAX: "many", AGENT_DB_STATEMENT_TIMEOUT_MS: "1.5" });
    expect(r.errors.map((e) => [e.key, e.reason])).toEqual([
      ["AGENT_DB_STATEMENT_TIMEOUT_MS", "not_a_number"],
      ["AGENT_DB_CONTROL_POOL_MAX", "not_a_number"],
    ]);
    expect(r.value.controlPoolMax).toBe(2);
    expect(r.value.statementTimeoutMs).toBe(30_000);
  });

  it("the long-statement budget is never below the ordinary statement cap", () => {
    const r = parseAgentDbBoundsEnv({
      AGENT_DB_STATEMENT_TIMEOUT_MS: "120000",
      AGENT_DB_LONG_STATEMENT_TIMEOUT_MS: "60000",
    });
    expect(r.errors).toEqual([]);
    expect(r.value.longStatementTimeoutMs).toBe(120_000);
  });
});

describe("parseAgentToolReadEnv (Kairos T-1 + T-3)", () => {
  it("defaults to three concurrent reads, a 45 s read cap and a 120 s extended cap", () => {
    const r = parseAgentToolReadEnv({});
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({
      readConcurrency: 3,
      readTimeoutMs: 45_000,
      extendedReadTimeoutMs: 120_000,
    });
  });

  it("accepts 1 (strictly serial) and 0 for either timeout (disabled)", () => {
    const r = parseAgentToolReadEnv({
      AGENT_TOOL_READ_CONCURRENCY: "1",
      AGENT_TOOL_READ_TIMEOUT_MS: "0",
      AGENT_TOOL_READ_EXTENDED_TIMEOUT_MS: "0",
    });
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ readConcurrency: 1, readTimeoutMs: 0, extendedReadTimeoutMs: 0 });
  });

  it("refuses a concurrency of 0 or above 8, and the default applies", () => {
    for (const raw of ["0", "9", "two"]) {
      const r = parseAgentToolReadEnv({ AGENT_TOOL_READ_CONCURRENCY: raw });
      expect(r.errors.map((e) => e.key)).toEqual(["AGENT_TOOL_READ_CONCURRENCY"]);
      expect(r.value.readConcurrency).toBe(3);
    }
  });
});

describe("parseAgentWakeEnv (Kairos S-3)", () => {
  it("defaults to one wake slice at a time, the serial executor", () => {
    const r = parseAgentWakeEnv({});
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ wakeConcurrency: 1 });
    expect(parseAgentWakeEnv({ AGENT_WAKE_CONCURRENCY: "  " }).value.wakeConcurrency).toBe(1);
  });

  it("accepts 1 through 4", () => {
    for (const n of [1, 2, 3, 4]) {
      const r = parseAgentWakeEnv({ AGENT_WAKE_CONCURRENCY: String(n) });
      expect(r.errors).toEqual([]);
      expect(r.value.wakeConcurrency).toBe(n);
    }
  });

  it("refuses 0, above 4 or a non-number, and the serial default applies", () => {
    for (const raw of ["0", "5", "1.5", "two"]) {
      const r = parseAgentWakeEnv({ AGENT_WAKE_CONCURRENCY: raw });
      expect(r.errors.map((e) => e.key)).toEqual(["AGENT_WAKE_CONCURRENCY"]);
      expect(r.value.wakeConcurrency).toBe(1);
    }
  });
});

describe("parseAgentWalletReadEnv (Kairos W-1)", () => {
  it("defaults to parallel legs with a 25 s per-leg deadline", () => {
    const r = parseAgentWalletReadEnv({});
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ parallelLegs: true, legTimeoutMs: 25_000 });
  });

  it("0 and 0 is the pre-Phase-6 read: serial legs, no deadline", () => {
    const r = parseAgentWalletReadEnv({
      AGENT_WALLET_READ_PARALLEL: "0",
      AGENT_WALLET_READ_LEG_TIMEOUT_MS: "0",
    });
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ parallelLegs: false, legTimeoutMs: 0 });
  });

  it("refuses values out of range, and the default applies", () => {
    const r = parseAgentWalletReadEnv({
      AGENT_WALLET_READ_PARALLEL: "2",
      AGENT_WALLET_READ_LEG_TIMEOUT_MS: "999999",
    });
    expect(r.errors.map((e) => e.key)).toEqual([
      "AGENT_WALLET_READ_PARALLEL",
      "AGENT_WALLET_READ_LEG_TIMEOUT_MS",
    ]);
    expect(r.value).toEqual({ parallelLegs: true, legTimeoutMs: 25_000 });
  });
});
