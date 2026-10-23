/**
 * The D16 `x-vex-max-tokens` parser. Format from the gateway's own builder
 * (`VexVirtualsCompute/src/metering/estimate.ts` `maxTokensHeader`):
 * `requested=<n>; effective=<m>; reason=<balance|model_limit>`.
 */

import { describe, expect, it } from "vitest";
import { parseMaxTokensClampHeader } from "@vex-agent/inference/openrouter/max-tokens-clamp.js";

describe("parseMaxTokensClampHeader", () => {
  it("accepts both documented reasons", () => {
    expect(parseMaxTokensClampHeader("requested=16384; effective=4096; reason=balance")).toEqual({
      requested: 16_384,
      effective: 4_096,
      reason: "balance",
    });
    expect(parseMaxTokensClampHeader("requested=200000; effective=65536; reason=model_limit")).toEqual({
      requested: 200_000,
      effective: 65_536,
      reason: "model_limit",
    });
  });

  it("tolerates field order and spacing, not content", () => {
    expect(parseMaxTokensClampHeader("reason=balance;effective=1;requested=2")).toEqual({
      requested: 2,
      effective: 1,
      reason: "balance",
    });
  });

  it.each([
    [null],
    [""],
    ["requested=1; effective=1"],
    ["requested=1; effective=1; reason=balance; extra=1"],
    ["requested=1; requested=2; reason=balance"],
    ["requested=0; effective=1; reason=balance"],
    ["requested=-5; effective=1; reason=balance"],
    ["requested=1.5; effective=1; reason=balance"],
    ["requested=99999999999; effective=1; reason=balance"],
    ["requested=1; effective=1; reason=other"],
    ["requested=1;; effective=1; reason=balance"],
    ["garbage"],
  ])("refuses %j", (value) => {
    expect(parseMaxTokensClampHeader(value)).toBeNull();
  });
});
