/**
 * Khalani handlers — parity with the other protocol handler tests. Asserts structural coverage
 * (handler ↔ manifest pairing, count, all functions) and required-param
 * rejection paths that don't need a live Khalani client.
 *
 * The manifest-side parity test (`khalani-manifest.test.ts`) already
 * covers a different slice; this file narrowly covers the handler map.
 */

import { describe, it, expect } from "vitest";
import { makeProtocolContext } from "./_test-context.js";

import { KHALANI_HANDLERS } from "../../../vex-agent/tools/protocols/khalani/handlers.js";
import { KHALANI_TOOLS } from "../../../vex-agent/tools/protocols/khalani/manifest.js";

const EXECUTION_CTX = makeProtocolContext();

describe("khalani handlers — structural coverage", () => {
  it("has a handler for every manifest toolId", () => {
    const handlerKeys = new Set(Object.keys(KHALANI_HANDLERS));
    const manifestIds = KHALANI_TOOLS.map(t => t.toolId);
    const missing = manifestIds.filter(id => !handlerKeys.has(id));
    expect(missing).toEqual([]);
  });

  it("has no extra handlers without manifests", () => {
    const manifestIds = new Set(KHALANI_TOOLS.map(t => t.toolId));
    const handlerKeys = Object.keys(KHALANI_HANDLERS);
    const extra = handlerKeys.filter(key => !manifestIds.has(key));
    expect(extra).toEqual([]);
  });

  it("handler count matches manifest count", () => {
    expect(Object.keys(KHALANI_HANDLERS).length).toBe(KHALANI_TOOLS.length);
  });

  it("every handler is a function", () => {
    for (const [, handler] of Object.entries(KHALANI_HANDLERS)) {
      expect(typeof handler).toBe("function");
    }
  });
});

describe("khalani handlers — required param rejections", () => {
  // These are the handlers whose manifest declares required:true primitives
  // that the handler also validates at the top (defensive — pre-PR1 the
  // runtime only checked presence, not type; PR1 added runtime type
  // validation, but the handler's defensive check remains).

  it("khalani.tokens.search fails without query", async () => {
    const result = await KHALANI_HANDLERS["khalani.tokens.search"]!({}, EXECUTION_CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("query");
  });

  it("khalani.tokens.autocomplete fails without keyword", async () => {
    const result = await KHALANI_HANDLERS["khalani.tokens.autocomplete"]!({}, EXECUTION_CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("keyword");
  });

  it("khalani.quote.get fails without fromChain/toChain/fromToken/toToken/amount", async () => {
    const result = await KHALANI_HANDLERS["khalani.quote.get"]!({}, EXECUTION_CTX);
    expect(result.success).toBe(false);
    // Handler aggregates the missing-param message across the 5 required fields.
    expect(result.output).toMatch(/fromChain|toChain|amount/);
  });

  it("khalani.orders.get fails without orderId", async () => {
    const result = await KHALANI_HANDLERS["khalani.orders.get"]!({}, EXECUTION_CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("orderId");
  });
});
