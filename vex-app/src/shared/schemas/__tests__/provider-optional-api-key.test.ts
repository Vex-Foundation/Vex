/**
 * `providerPersistInputSchema` with an OPTIONAL `apiKey` (delta save).
 *
 * The boundary must distinguish three cases without ambiguity:
 *   - field ABSENT      ⇒ "keep the stored key" (valid);
 *   - field PRESENT     ⇒ rotate to that value (valid, still trimmed/bounded);
 *   - field BLANK/SPACES⇒ INVALID. A whitespace-only string must never be
 *     silently reinterpreted as "keep" — the renderer has to omit the field to
 *     mean that, so a stuck/half-cleared input can't quietly skip a rotation
 *     the operator believed they made.
 *
 * Also pins backward compatibility: the first-run payload shape parses
 * unchanged.
 */

import { describe, expect, it } from "vitest";
import { providerPersistInputSchema, type OpenRouterPersistInput } from "../provider.js";

const MODEL = "anthropic/claude-sonnet-4.5";

/** Parse through the full union and prove it chose the OpenRouter member. */
function parseOpenRouter(input: unknown): OpenRouterPersistInput {
  const parsed = providerPersistInputSchema.parse(input);
  if (parsed.provider !== "openrouter") throw new Error("expected the openrouter member");
  return parsed;
}

describe("providerPersistInputSchema - optional apiKey", () => {
  it("accepts a payload with NO apiKey and leaves the field absent", () => {
    const parsed = parseOpenRouter({
      provider: "openrouter",
      model: MODEL,
    });

    expect(parsed.apiKey).toBeUndefined();
    expect("apiKey" in parsed).toBe(false);
    expect(parsed.model).toBe(MODEL);
  });

  it("still accepts the first-run payload unchanged (backward compatible)", () => {
    const parsed = parseOpenRouter({
      provider: "openrouter",
      apiKey: "  sk-or-first-run  ",
      model: MODEL,
    });

    expect(parsed.apiKey).toBe("sk-or-first-run");
  });

  it("round-trips a keep-key payload that also carries an endpoint pin", () => {
    const input = {
      provider: "openrouter" as const,
      model: MODEL,
      endpointTag: "anthropic/2",
    };
    const parsed = providerPersistInputSchema.parse(input);

    expect(parsed).toEqual(input);
    expect(providerPersistInputSchema.parse(parsed)).toEqual(parsed);
  });

  it("REJECTS a whitespace-only apiKey rather than reading it as 'keep'", () => {
    const result = providerPersistInputSchema.safeParse({
      provider: "openrouter",
      apiKey: "   ",
      model: MODEL,
    });

    expect(result.success).toBe(false);
  });

  it("REJECTS an empty-string apiKey", () => {
    const result = providerPersistInputSchema.safeParse({
      provider: "openrouter",
      apiKey: "",
      model: MODEL,
    });

    expect(result.success).toBe(false);
  });

  it("still bounds a supplied apiKey at 200 characters", () => {
    const result = providerPersistInputSchema.safeParse({
      provider: "openrouter",
      apiKey: "x".repeat(201),
      model: MODEL,
    });

    expect(result.success).toBe(false);
  });

  it("still requires the model on the keep-key path", () => {
    const result = providerPersistInputSchema.safeParse({
      provider: "openrouter",
    });

    expect(result.success).toBe(false);
  });
});
