import { vi } from "vitest";

import type { InferenceProvider, StreamChunk } from "@vex-agent/inference/types.js";

/**
 * A complete `InferenceProvider` double. Every member has an inert default and
 * the caller overrides only the arms its test drives, so the double is checked
 * against the real interface instead of being cast to it.
 */
export function fakeInferenceProvider(overrides: Partial<InferenceProvider> = {}): InferenceProvider {
  return {
    id: "fake",
    displayName: "Fake",
    loadConfig: async () => null,
    chatCompletion: vi.fn<InferenceProvider["chatCompletion"]>(),
    chatCompletionSimple: vi.fn<InferenceProvider["chatCompletionSimple"]>(),
    chatCompletionStream: async function* (): AsyncGenerator<StreamChunk> {},
    getBalance: async () => null,
    calculateCost: () => ({
      totalCost: 0,
      currency: "USD",
      breakdown: { promptCost: 0, completionCost: 0, cachedSavings: 0, reasoningCost: 0 },
    }),
    ...overrides,
  };
}

/**
 * `runStreamingInference` guards against providers that break the static
 * contract at runtime: one with no stream method, or one whose stream method
 * returns something that is not async-iterable. Neither shape is expressible
 * as an `InferenceProvider`, so these build the double whole and then reshape
 * the one member at runtime, which is exactly the situation the guard exists
 * for.
 */
export function withoutStreamMethod(provider: InferenceProvider): InferenceProvider {
  Reflect.deleteProperty(provider, "chatCompletionStream");
  return provider;
}

export function withNonIterableStream(provider: InferenceProvider): InferenceProvider {
  Reflect.set(provider, "chatCompletionStream", () => ({}));
  return provider;
}
