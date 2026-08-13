import { describe, expect, it } from "vitest";

import {
  LIGHTER_LIVE_TRADING_RELEASE_GATE_ENABLE_VALUE,
  LIGHTER_LIVE_TRADING_RELEASE_GATE_ENV_KEY,
  readLighterLiveTradingReleaseGateStatus,
} from "../live-trading-release-gate.js";

describe("Lighter live-trading release gate", () => {
  it("is closed when the operator gate is absent", () => {
    expect(readLighterLiveTradingReleaseGateStatus({})).toEqual({
      enabled: false,
      source: "privileged_runtime",
      reason: "The privileged Lighter live-trading release gate is not enabled.",
    });
  });

  it("opens only for the exact approval-gated create release value", () => {
    expect(readLighterLiveTradingReleaseGateStatus({
      [LIGHTER_LIVE_TRADING_RELEASE_GATE_ENV_KEY]:
        LIGHTER_LIVE_TRADING_RELEASE_GATE_ENABLE_VALUE,
    })).toEqual({
      enabled: true,
      source: "privileged_runtime",
      reason: "The privileged Lighter approval-gated create release gate is enabled.",
    });
  });

  it("stays closed for truthy but unrecognized values", () => {
    for (const value of ["1", "true", "enabled", "approval-gated-cancel-v1"]) {
      expect(readLighterLiveTradingReleaseGateStatus({
        [LIGHTER_LIVE_TRADING_RELEASE_GATE_ENV_KEY]: value,
      })).toEqual({
        enabled: false,
        source: "privileged_runtime",
        reason: "The privileged Lighter live-trading release gate value is not recognized.",
      });
    }
  });
});
