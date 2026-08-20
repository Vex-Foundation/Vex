import { describe, expect, it } from "vitest";
import {
  normalizeReasoningCapability,
  reasoningEffortSchema,
  REASONING_EFFORT_VALUES,
  selectDefaultReasoningEffort,
  type RawReasoningCapability,
} from "../reasoning.js";

describe("reasoningEffortSchema (7-value transport enum)", () => {
  it("accepts every OpenRouter effort value, including none/max", () => {
    for (const value of REASONING_EFFORT_VALUES) {
      expect(reasoningEffortSchema.safeParse(value).success).toBe(true);
    }
    expect(REASONING_EFFORT_VALUES).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("rejects values outside the 7-value set", () => {
    for (const value of ["off", "extreme", "MEDIUM", "", "very_high"]) {
      expect(reasoningEffortSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("normalizeReasoningCapability", () => {
  function raw(overrides: Partial<RawReasoningCapability> = {}): RawReasoningCapability {
    return {
      supportedEfforts: undefined,
      defaultEffort: undefined,
      defaultEnabled: undefined,
      mandatory: undefined,
      ...overrides,
    };
  }

  it("omitted capability (undefined) normalizes to null (non-reasoning model)", () => {
    expect(normalizeReasoningCapability(undefined)).toBeNull();
  });

  it("reasoning object present but supportedEfforts OMITTED (undefined) normalizes to null - distinct from explicit null", () => {
    // D3: `supported_efforts` OMITTED means "we don't know the selectable
    // set" (→ null); explicit `null` means OpenRouter's own "no
    // restriction" signal (→ the full canonical set, tested below). These
    // must NOT collapse to the same behavior.
    expect(
      normalizeReasoningCapability(
        raw({ supportedEfforts: undefined, defaultEffort: "medium", mandatory: false }),
      ),
    ).toBeNull();
  });

  it("supportedEfforts: null uses the canonical positive order + appends none", () => {
    const capability = normalizeReasoningCapability(raw({ supportedEfforts: null }));
    expect(capability).toEqual({
      supportedEfforts: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
      defaultEffort: null,
      defaultEnabled: null,
      mandatory: false,
    });
  });

  it("preserves API order for an explicit array (does not re-sort to canonical)", () => {
    const capability = normalizeReasoningCapability(
      raw({ supportedEfforts: ["low", "high", "medium"] }),
    );
    expect(capability?.supportedEfforts).toEqual(["low", "high", "medium", "none"]);
  });

  it("dedupes repeated efforts, preserving first-occurrence order", () => {
    const capability = normalizeReasoningCapability(
      raw({ supportedEfforts: ["high", "high", "medium", "high"] }),
    );
    expect(capability?.supportedEfforts).toEqual(["high", "medium", "none"]);
  });

  it("drops unrecognized upstream values", () => {
    const capability = normalizeReasoningCapability(
      raw({ supportedEfforts: ["high", "ultra", "medium"] }),
    );
    expect(capability?.supportedEfforts).toEqual(["high", "medium", "none"]);
  });

  it("empty array normalizes to null (no selector)", () => {
    expect(normalizeReasoningCapability(raw({ supportedEfforts: [] }))).toBeNull();
  });

  it("all-unknown array normalizes to null", () => {
    expect(
      normalizeReasoningCapability(raw({ supportedEfforts: ["ultra", "mega"] })),
    ).toBeNull();
  });

  it('["none"]-only array normalizes to null (never an Off-only selector)', () => {
    expect(normalizeReasoningCapability(raw({ supportedEfforts: ["none"] }))).toBeNull();
  });

  it("mandatory strips none from the final set even when upstream inconsistently lists it", () => {
    const capability = normalizeReasoningCapability(
      raw({ supportedEfforts: ["high", "none"], mandatory: true }),
    );
    expect(capability?.supportedEfforts).toEqual(["high"]);
    expect(capability?.mandatory).toBe(true);
  });

  it("non-mandatory appends exactly one none", () => {
    const capability = normalizeReasoningCapability(
      raw({ supportedEfforts: ["high", "medium"], mandatory: false }),
    );
    expect(capability?.supportedEfforts).toEqual(["high", "medium", "none"]);
  });

  it("clamps defaultEffort to the final set (valid case passes through)", () => {
    const capability = normalizeReasoningCapability(
      raw({ supportedEfforts: ["high", "medium"], defaultEffort: "medium" }),
    );
    expect(capability?.defaultEffort).toBe("medium");
  });

  it("clamps defaultEffort to null when mandatory strips the raw default (default_effort: none)", () => {
    const capability = normalizeReasoningCapability(
      raw({ supportedEfforts: ["high"], mandatory: true, defaultEffort: "none" }),
    );
    expect(capability?.defaultEffort).toBeNull();
  });

  it("clamps defaultEffort to null when it is not among the supported efforts", () => {
    const capability = normalizeReasoningCapability(
      raw({ supportedEfforts: ["high"], defaultEffort: "xhigh" }),
    );
    expect(capability?.defaultEffort).toBeNull();
  });

  it("treats absent mandatory as false and absent defaultEnabled as null", () => {
    const capability = normalizeReasoningCapability(raw({ supportedEfforts: ["high"] }));
    expect(capability?.mandatory).toBe(false);
    expect(capability?.defaultEnabled).toBeNull();
  });

  it("passes through defaultEnabled true/false", () => {
    expect(
      normalizeReasoningCapability(raw({ supportedEfforts: ["high"], defaultEnabled: true }))
        ?.defaultEnabled,
    ).toBe(true);
    expect(
      normalizeReasoningCapability(raw({ supportedEfforts: ["high"], defaultEnabled: false }))
        ?.defaultEnabled,
    ).toBe(false);
  });
});

describe("selectDefaultReasoningEffort (D4 preselect fixtures)", () => {
  it('["high"] with no defaults preselects "high"', () => {
    const capability = normalizeReasoningCapability({
      supportedEfforts: ["high"],
      defaultEffort: undefined,
      defaultEnabled: undefined,
      mandatory: undefined,
    });
    expect(capability).not.toBeNull();
    expect(selectDefaultReasoningEffort(capability!)).toBe("high");
  });

  it('["high"] + defaultEnabled:false preselects Off ("none")', () => {
    const capability = normalizeReasoningCapability({
      supportedEfforts: ["high"],
      defaultEffort: undefined,
      defaultEnabled: false,
      mandatory: undefined,
    });
    expect(capability).not.toBeNull();
    expect(selectDefaultReasoningEffort(capability!)).toBe("none");
  });

  it('mandatory ["high"] + defaultEnabled:false preselects "high" (mandatory can never preselect Off)', () => {
    const capability = normalizeReasoningCapability({
      supportedEfforts: ["high"],
      defaultEffort: undefined,
      defaultEnabled: false,
      mandatory: true,
    });
    expect(capability).not.toBeNull();
    expect(selectDefaultReasoningEffort(capability!)).toBe("high");
  });

  it("prefers an upstream defaultEffort that survived normalization", () => {
    const capability = normalizeReasoningCapability({
      supportedEfforts: ["low", "high", "xhigh"],
      defaultEffort: "xhigh",
      defaultEnabled: undefined,
      mandatory: undefined,
    });
    expect(capability).not.toBeNull();
    expect(selectDefaultReasoningEffort(capability!)).toBe("xhigh");
  });

  it('falls back to "medium" when no default is set and medium is supported', () => {
    const capability = normalizeReasoningCapability({
      supportedEfforts: null,
      defaultEffort: undefined,
      defaultEnabled: undefined,
      mandatory: undefined,
    });
    expect(capability).not.toBeNull();
    expect(selectDefaultReasoningEffort(capability!)).toBe("medium");
  });

  it("falls back to the middle of the positive set when medium is unsupported", () => {
    const capability = normalizeReasoningCapability({
      supportedEfforts: ["low", "high", "xhigh", "max"],
      defaultEffort: undefined,
      defaultEnabled: undefined,
      mandatory: undefined,
    });
    expect(capability).not.toBeNull();
    // positive efforts in API order: [low, high, xhigh, max] → middle index
    // floor((4-1)/2) = 1 → "high".
    expect(selectDefaultReasoningEffort(capability!)).toBe("high");
  });
});
