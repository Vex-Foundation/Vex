/**
 * Kairos T-1: the audited parallel-safe read allowlist.
 *
 * Pins the invariants that make an entry safe to run concurrently: it is a
 * registered, non-mutating `read`; it never records quote authority; it is
 * never a prepared-action follow-up source; ToolSearch, memory and Lighter
 * tools stay out; and anything not listed resolves to serial.
 */

import { describe, expect, it } from "vitest";

import {
  PARALLEL_SAFE_INTERNAL_READS,
  PARALLEL_SAFE_PROTOCOL_READS,
  READ_PROVIDER_CONCURRENCY_CAPS,
  resolveParallelSafeRead,
} from "@vex-agent/tools/parallel-safe-reads.js";
import { getToolDef } from "@vex-agent/tools/registry.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import { PREQUOTE_QUOTE_TOOLS } from "@vex-agent/tools/protocols/swap-prequote.js";
import { PREPARED_ACTION_SOURCE_TOOL } from "@vex-agent/tools/registry/prepared-action-follow-ups.js";
import { toInjectedToolName } from "@vex-agent/tools/registry/injected-protocol-tools.js";
import { requireValue } from "../../helpers/require-value.js";

const internalNames = Object.keys(PARALLEL_SAFE_INTERNAL_READS);
const protocolIds = Object.keys(PARALLEL_SAFE_PROTOCOL_READS);

describe("parallel-safe read allowlist", () => {
  it.each(internalNames)("internal %s is a registered non-mutating read", (name) => {
    const def = requireValue(getToolDef(name));
    expect(def.actionKind).toBe("read");
    expect(def.mutating).toBe(false);
    expect(def.pressureSafety).toBe("read_only");
  });

  it.each(protocolIds)("protocol %s is a registered non-mutating read", (toolId) => {
    const manifest = requireValue(getProtocolManifest(toolId));
    expect(manifest.actionKind).toBe("read");
    expect(manifest.mutating).toBe(false);
  });

  it("never lists a quote that records quote authority", () => {
    for (const toolId of Object.keys(PREQUOTE_QUOTE_TOOLS)) {
      expect(Object.hasOwn(PARALLEL_SAFE_PROTOCOL_READS, toolId)).toBe(false);
    }
    for (const name of ["SwapQuote", "SwapQuoteUniswap", "BridgeQuote", "BridgeQuoteRelay"]) {
      expect(resolveParallelSafeRead(name)).toBeNull();
    }
  });

  it("keeps ToolSearch, memory, plan, board, mission, Lighter and wallet-writing tools serial", () => {
    for (const name of [
      "ToolSearch",
      "MemorySearch",
      "MemoryGet",
      "MemoryHistory",
      "SessionMemorySearch",
      "SessionMemoryResolve",
      "MemorySuggest",
      "PlanWrite",
      "BoardCompose",
      "MissionDraftUpdate",
      "MissionStop",
      "LoopDefer",
      "CompactApply",
      "BridgeStatus",
      "WalletTrackToken",
      PREPARED_ACTION_SOURCE_TOOL,
      "WalletSendConfirm",
      "SwapExecute",
      "lighter_rhc_onboarding_status",
      "lighter_core_onboarding_status",
      "execute_tool",
    ]) {
      expect(resolveParallelSafeRead(name)).toBeNull();
    }
    for (const toolId of protocolIds) {
      expect(toolId.startsWith("lighter.")).toBe(false);
    }
  });

  it("an unknown or new tool name defaults to serial", () => {
    expect(resolveParallelSafeRead("SomeFutureTool")).toBeNull();
    expect(resolveParallelSafeRead("nothing__here")).toBeNull();
    expect(resolveParallelSafeRead("")).toBeNull();
  });

  it("resolves an allowlisted protocol read by the name the model calls it", () => {
    for (const toolId of protocolIds) {
      const resolved = requireValue(resolveParallelSafeRead(toInjectedToolName(toolId)));
      expect(resolved.identity).toBe(toolId);
    }
  });

  it("every entry carries a justification and a capped provider", () => {
    for (const entry of [
      ...Object.values(PARALLEL_SAFE_INTERNAL_READS),
      ...Object.values(PARALLEL_SAFE_PROTOCOL_READS),
    ]) {
      expect(entry.why.length).toBeGreaterThan(10);
      expect(READ_PROVIDER_CONCURRENCY_CAPS[entry.provider]).toBeGreaterThanOrEqual(1);
    }
  });
});
