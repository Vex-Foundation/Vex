/**
 * F06: the mission draft DTO projects the contract's model out of
 * `constraints_json` so the contract card can show and edit it. Only a
 * well-formed pick projects; a cleared or bad value is dropped (the card shows
 * the default) without losing its siblings.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { normaliseConstraints } = await import("../missions-db-normalize.js");

const SONNET = { provider: "vexcloud", modelId: "anthropic/claude-sonnet-5.5" };

describe("normaliseConstraints - mission model", () => {
  it("projects a well-formed model", () => {
    expect(normaliseConstraints({ model: SONNET })).toEqual({ model: SONNET });
  });

  it("keeps a cleared model as null, which the card reads as the default", () => {
    expect(normaliseConstraints({ model: null, maxLaunchCount: 1 })).toEqual({ model: null, maxLaunchCount: 1 });
  });

  it("drops a model on an unknown backend but keeps the sibling constraints", () => {
    expect(normaliseConstraints({ model: { provider: "anthropic", modelId: "x/y" }, reasoningEffort: "high" })).toEqual({
      reasoningEffort: "high",
    });
  });
});
