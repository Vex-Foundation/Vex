import { describe, it, expect } from "vitest";
import type {
  InferenceConfig,
  InferenceUsage,
  InferenceResponse,
  ParsedToolCall,
  StreamChunk,
  ProviderBalance,
  RequestCost,
  ProviderMessage,
  ToolDefinition,
  InferenceProvider,
} from "../../../vex-agent/inference/types.js";

/**
 * Type-level tests: verify that the interfaces compile and are structurally sound.
 * These tests use satisfies/assignability checks — they fail at compile time, not runtime.
 */
describe("types - structural integrity", () => {
  it("InferenceConfig has all required fields", () => {
    const config: InferenceConfig = {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      contextLimit: 128_000,
      maxOutputTokens: 16384,
      inputPricePerM: 3.0,
      outputPricePerM: 15.0,
      priceCurrency: "USD",
      cachePricePerM: 1.5,
      cacheWritePricePerM: 3.75,
      reasoningPricePerM: 15.0,
      supportsReasoningEffort: true,
    };
    expect(config.provider).toBe("openrouter");
    expect(config.temperature).toBeUndefined();
  });

  it("InferenceConfig allows optional temperature", () => {
    const config: InferenceConfig = {
      provider: "openrouter",
      model: "test",
      contextLimit: 128_000,
      temperature: 0.7,
      maxOutputTokens: 16384,
      inputPricePerM: 3.0,
      outputPricePerM: 15.0,
      priceCurrency: "USD",
      cachePricePerM: null,
      cacheWritePricePerM: null,
      reasoningPricePerM: null,
      supportsReasoningEffort: false,
    };
    expect(config.temperature).toBe(0.7);
  });

  it("InferenceUsage supports extended fields", () => {
    const usage: InferenceUsage = {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      cachedTokens: 200,
      cacheWriteTokens: 40,
      reasoningTokens: 100,
    };
    expect(usage.cachedTokens).toBe(200);
    expect(usage.cacheWriteTokens).toBe(40);
  });

  it("InferenceResponse represents text-only response", () => {
    const response: InferenceResponse = {
      content: "Hello world",
      toolCalls: null,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      malformedToolCallCount: 0,
    };
    expect(response.content).toBe("Hello world");
    expect(response.toolCalls).toBeNull();
  });

  it("InferenceResponse represents tool call response", () => {
    const toolCall: ParsedToolCall = {
      id: "call_123",
      name: "web_research",
      arguments: { query: "bitcoin price" },
    };
    const response: InferenceResponse = {
      content: null,
      toolCalls: [toolCall],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      malformedToolCallCount: 0,
    };
    expect(response.content).toBeNull();
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].name).toBe("web_research");
  });

  it("StreamChunk supports all chunk types", () => {
    const contentChunk: StreamChunk = { type: "content", text: "Hello" };
    const toolDelta: StreamChunk = {
      type: "tool_call_delta",
      toolCallIndex: 0,
      toolCallId: "call_1",
      toolCallName: "search",
      toolCallArgsDelta: '{"query":',
    };
    const reasoningChunk: StreamChunk = { type: "reasoning", reasoningText: "thinking..." };
    const usageChunk: StreamChunk = {
      type: "usage",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    };
    const errorChunk: StreamChunk = { type: "error", errorMessage: "overloaded", errorCode: 503 };
    const doneChunk: StreamChunk = { type: "done" };

    expect(contentChunk.type).toBe("content");
    expect(toolDelta.toolCallName).toBe("search");
    expect(reasoningChunk.reasoningText).toBe("thinking...");
    expect(usageChunk.usage?.promptTokens).toBe(100);
    expect(errorChunk.errorCode).toBe(503);
    expect(doneChunk.type).toBe("done");
  });

  it("RequestCost has full breakdown", () => {
    const cost: RequestCost = {
      totalCost: 0.0045,
      currency: "USD",
      breakdown: {
        promptCost: 0.003,
        completionCost: 0.0025,
        cachedSavings: 0.001,
        reasoningCost: 0,
      },
    };
    expect(cost.totalCost).toBe(0.0045);
    expect(cost.breakdown.cachedSavings).toBe(0.001);
  });

  it("ProviderMessage supports all roles", () => {
    const system: ProviderMessage = { role: "system", content: "You are..." };
    const user: ProviderMessage = { role: "user", content: "Hello" };
    const assistant: ProviderMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", command: "web_research", args: { query: "test" } }],
    };
    const tool: ProviderMessage = {
      role: "tool",
      content: '{"results": []}',
      toolCallId: "call_1",
    };

    expect(system.role).toBe("system");
    expect(assistant.toolCalls).toHaveLength(1);
    expect(tool.toolCallId).toBe("call_1");
    expect(user.role).toBe("user");
  });

  it("ToolDefinition matches OpenAI format", () => {
    const tool: ToolDefinition = {
      type: "function",
      function: {
        name: "web_research",
        description: "Search the web",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
    };
    expect(tool.function.name).toBe("web_research");
  });

  it("ProviderBalance supports OpenRouter usage fields", () => {
    const orBalance: ProviderBalance = {
      available: 12.5,
      currency: "USD",
      isLow: false,
      displayText: "$12.50 USD",
      total: 50,
      usageDaily: 2.3,
      usageMonthly: 37.5,
    };

    expect(orBalance.usageDaily).toBe(2.3);
    expect(orBalance.currency).toBe("USD");
  });
});
