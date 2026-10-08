/**
 * Kairos E-1: the mission draft DTO projects the contract's reasoning effort
 * out of `constraints_json` so the contract card can show and edit it. Only a
 * known effort projects; a bad value is dropped without losing its siblings.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { normaliseConstraints } = await import("../missions-db-normalize.js");

describe("normaliseConstraints - reasoning effort", () => {
  it("projects a known effort", () => {
    expect(normaliseConstraints({ reasoningEffort: "high" })).toEqual({ reasoningEffort: "high" });
  });

  it("keeps a cleared effort as null", () => {
    expect(normaliseConstraints({ reasoningEffort: null })).toEqual({ reasoningEffort: null });
  });

  it("drops an unknown effort but keeps the sibling constraints", () => {
    expect(normaliseConstraints({ reasoningEffort: "turbo", maxLaunchCount: 2 })).toEqual({
      maxLaunchCount: 2,
    });
  });
});
