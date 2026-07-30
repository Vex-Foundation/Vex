/**
 * A shrinking context window must be FELT, not averaged out.
 *
 * Endpoint failover can move a session from a 256k endpoint to a 128k one
 * mid-run. Before this, the turn loop kept banding against the window it
 * captured before the loop started, so every pressure band sat below the real
 * ceiling: graceful compaction never fired and the loop assembled a request the
 * endpoint had to reject on a hard `context_length_exceeded` (owner decision 7).
 *
 * The band observer therefore reads the limit through a GETTER. These tests pin
 * the two halves of that: the observer honours a limit that changes, and it does
 * so WITHOUT resetting its transition state — a shrink is a real upward
 * transition, not a fresh baseline.
 */

import { describe, it, expect } from "vitest";

import {
  computeBand,
  createBandObserver,
} from "@vex-agent/engine/core/context-band.js";
import { resolveEffectiveInferenceConfig } from "@vex-agent/engine/core/turn-loop/effective-inference-config.js";
import type { EndpointCandidate, InferenceProvider } from "@vex-agent/inference/types.js";
import {
  commitEndpointSwitch,
  resetAllSessionEndpointState,
} from "@vex-agent/inference/openrouter/endpoint-failover/session-endpoint-state.js";

const NARROW: EndpointCandidate = {
  tag: "baidu/fp8",
  providerName: "Baidu",
  uptimePercent: 99.9,
  contextLength: 128_000,
  inputPricePerM: 2,
  outputPricePerM: 8,
  cachePricePerM: null,
  cacheWritePricePerM: null,
  reasoningPricePerM: null,
};

describe("createBandObserver — a limit that changes mid-session", () => {
  it("re-bands against the CURRENT window, so a shrink raises the band", () => {
    let limit = 256_000;
    const observe = createBandObserver(() => limit);

    // 120k of 256k is comfortable…
    expect(observe(120_000).band).toBe("normal");
    // …and the SAME 120k against a 128k window is critical. Under the old
    // fixed-limit observer this stayed "normal" and nothing compacted.
    limit = 128_000;
    const shrunk = observe(120_000);
    expect(shrunk.band).not.toBe("normal");
    expect(computeBand(120_000, 128_000)).toBe(shrunk.band);
  });

  it("reports the shrink as an upward TRANSITION rather than re-baselining", () => {
    let limit = 256_000;
    const observe = createBandObserver(() => limit);
    observe(120_000);

    limit = 128_000;
    const shrunk = observe(120_000);
    // `emit` is what drives the band-observed telemetry and the compaction
    // trigger; a reset observer would have swallowed it as an initial reading.
    expect(shrunk.emit).toBe(true);
    expect(shrunk.fromBand).toBe("normal");
  });

  it("still accepts a plain number — existing callers are unaffected", () => {
    const observe = createBandObserver(100_000);
    expect(observe(10_000).band).toBe("normal");
  });
});

describe("resolveEffectiveInferenceConfig — the loop's per-iteration window", () => {
  const baseConfig = {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    contextLimit: 256_000,
    endpointTag: "deepinfra/fp4",
    maxOutputTokens: 4_096,
    inputPricePerM: 0.5,
    outputPricePerM: 1.5,
    priceCurrency: "USD" as const,
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: false,
  };

  function provider(): InferenceProvider {
    return {
      id: "openrouter",
      failoverDeps: () => ({ loadCandidates: async () => [NARROW] }),
    } as unknown as InferenceProvider;
  }

  it("hands the loop the SWITCHED endpoint's narrower window", async () => {
    resetAllSessionEndpointState();
    commitEndpointSwitch("s1", NARROW.tag);

    const effective = await resolveEffectiveInferenceConfig(
      baseConfig,
      256_000,
      "s1",
      provider(),
    );

    // 256k → 128k. This is the value the pre-inference ceiling and every band
    // consumer in the loop now measure against, so an over-window request is
    // blocked before it is issued instead of being rejected by the provider.
    expect(effective.contextLimit).toBe(128_000);
    expect(effective.config.endpointTag).toBe(NARROW.tag);
    expect(effective.config.inputPricePerM).toBe(2);
  });

  it("never RAISES the loop's own limit, even on a wider endpoint", async () => {
    // `TurnLoopConfig.contextLimit` is an independent input, not a copy of the
    // config's — the loop's value stays the ceiling and a switch may only
    // tighten it.
    resetAllSessionEndpointState();
    commitEndpointSwitch("s3", NARROW.tag);
    const wide = { ...NARROW, contextLength: 1_000_000 };
    const effective = await resolveEffectiveInferenceConfig(baseConfig, 64_000, "s3", {
      id: "openrouter",
      failoverDeps: () => ({ loadCandidates: async () => [wide] }),
    } as unknown as InferenceProvider);
    expect(effective.contextLimit).toBe(64_000);
  });

  it("is a no-op for a session that never switched", async () => {
    resetAllSessionEndpointState();
    const effective = await resolveEffectiveInferenceConfig(
      baseConfig,
      256_000,
      "s2",
      provider(),
    );
    expect(effective.contextLimit).toBe(256_000);
    expect(effective.config.endpointTag).toBe("deepinfra/fp4");
  });
});
