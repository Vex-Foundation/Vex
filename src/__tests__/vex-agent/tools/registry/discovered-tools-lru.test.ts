/**
 * P-3 (Kairos Phase 6): the discovered working set's LRU-by-use policy.
 *
 * OFF (`DISCOVERED_TOOL_LRU_CAP === null`, the shipped value) must be the old
 * FIFO cap byte for byte, so the first block replays random traffic against a
 * verbatim copy of the pre-P-3 algorithm. The ON block drives the same module
 * with an explicit cap, which is the value the switch would pass.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  DISCOVERED_TOOL_PIN_TTL_MS,
  MAX_DISCOVERED_TOOLS_PER_SESSION,
  clearDiscoveredTools,
  discoveredToolCapacity,
  getDiscoveredToolIds,
  pinDiscoveredTool,
  recordDiscoveredTools,
  touchDiscoveredTool,
} from "@vex-agent/tools/registry/discovered-tools.js";
import {
  DISCOVERED_TOOL_LRU_CAP,
  P3_LRU_CAP_WHEN_ON,
} from "@vex-agent/tools/registry/discovery-policy.js";
import { buildDisplacementWarning } from "@vex-agent/tools/protocols/discovery.js";
import { APPROVAL_TTL_MS } from "@vex-agent/engine/core/approval-runtime/enqueue.js";

const SESSION = "p3-lru-suite";
const CAP = P3_LRU_CAP_WHEN_ON;

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}.${String(i)}`);
}

/** The pre-P-3 `recordDiscoveredTools` body, copied verbatim as the oracle. */
function oldFifo(existing: readonly string[], toolIds: readonly string[]): {
  bounded: string[];
  displaced: string[];
} {
  const fresh = new Set(toolIds);
  const next = [...existing.filter((id) => !fresh.has(id)), ...toolIds];
  const overflow = next.length - MAX_DISCOVERED_TOOLS_PER_SESSION;
  const displaced = overflow > 0 ? next.slice(0, overflow) : [];
  const bounded = overflow > 0 ? next.slice(overflow) : next;
  return { bounded, displaced };
}

/** Deterministic PRNG so a failure replays. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

afterEach(() => clearDiscoveredTools(SESSION));

describe("P-3 OFF is the old FIFO cap exactly", () => {
  it("ships OFF", () => {
    expect(DISCOVERED_TOOL_LRU_CAP).toBeNull();
    expect(discoveredToolCapacity()).toBe(MAX_DISCOVERED_TOOLS_PER_SESSION);
  });

  it("replays 300 random rounds, uses and pins identically to the pre-P-3 algorithm", () => {
    const random = lcg(7);
    const pool = ids("t", 90);
    let oracle: string[] = [];
    for (let round = 0; round < 300; round += 1) {
      const size = 1 + Math.floor(random() * 20);
      const batch = [...new Set(Array.from({ length: size }, () => pool[Math.floor(random() * pool.length)] ?? "t.0"))];
      // Uses and pins must be invisible to the OFF path.
      const used = oracle[Math.floor(random() * Math.max(1, oracle.length))];
      if (used !== undefined) {
        touchDiscoveredTool(SESSION, used);
        pinDiscoveredTool(SESSION, used);
      }
      const expected = oldFifo(oracle, batch);
      const displaced = recordDiscoveredTools(SESSION, batch);
      expect(displaced).toEqual(expected.displaced);
      expect(getDiscoveredToolIds(SESSION)).toEqual(expected.bounded);
      oracle = expected.bounded;
    }
  });

  it("states the pre-P-3 displacement sentence unchanged", () => {
    expect(buildDisplacementWarning(["x.a"])).toBe(
      "\"x.a\" is no longer callable by name - this session keeps the most recent 40 "
      + "discovered tools. Search for or select them again if you still need them.",
    );
  });
});

describe("P-3 ON: least recently USED goes first", () => {
  it("a use protects an old tool that FIFO would have displaced", () => {
    const first = ids("a", CAP);
    recordDiscoveredTools(SESSION, first, CAP);
    // a.0 is the oldest DISCOVERED, but it is the most recently USED.
    touchDiscoveredTool(SESSION, "a.0");
    const displaced = recordDiscoveredTools(SESSION, ["b.0"], CAP);
    expect(displaced).toEqual(["a.1"]);
    expect(getDiscoveredToolIds(SESSION)).toContain("a.0");
    expect(getDiscoveredToolIds(SESSION)).toHaveLength(CAP);
  });

  it("keeps DISCOVERY order in the set, so the injected array does not reshuffle on use", () => {
    recordDiscoveredTools(SESSION, ["a.0", "a.1", "a.2"], CAP);
    touchDiscoveredTool(SESSION, "a.0");
    expect(getDiscoveredToolIds(SESSION)).toEqual(["a.0", "a.1", "a.2"]);
  });

  it("a touch of an unrecorded tool adds nothing", () => {
    touchDiscoveredTool(SESSION, "never.recorded");
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });

  it("never displaces the round being recorded: the cap is soft for a round larger than it", () => {
    recordDiscoveredTools(SESSION, ids("old", 4), CAP);
    const round = ids("big", CAP + 4);
    const displaced = recordDiscoveredTools(SESSION, round, CAP);
    expect(displaced).toEqual(ids("old", 4));
    expect(getDiscoveredToolIds(SESSION)).toEqual(round);
  });

  it("never displaces a tool pinned by a pending approval or prepared action", () => {
    recordDiscoveredTools(SESSION, ids("a", CAP), CAP);
    pinDiscoveredTool(SESSION, "a.0");
    const displaced = recordDiscoveredTools(SESSION, ["b.0", "b.1"], CAP);
    expect(displaced).toEqual(["a.1", "a.2"]);
    expect(getDiscoveredToolIds(SESSION)).toContain("a.0");
  });

  it("stays above the cap rather than drop a pinned tool when only protected tools remain", () => {
    recordDiscoveredTools(SESSION, ids("a", CAP), CAP);
    for (const id of ids("a", CAP)) pinDiscoveredTool(SESSION, id);
    const displaced = recordDiscoveredTools(SESSION, ["b.0"], CAP);
    expect(displaced).toEqual([]);
    expect(getDiscoveredToolIds(SESSION)).toHaveLength(CAP + 1);
  });

  it("a lapsed pin protects nothing", () => {
    recordDiscoveredTools(SESSION, ids("a", CAP), CAP);
    pinDiscoveredTool(SESSION, "a.0", Date.now() - 1);
    expect(recordDiscoveredTools(SESSION, ["b.0"], CAP)).toEqual(["a.0"]);
  });

  it("the pin lasts as long as the approval queue TTL", () => {
    expect(DISCOVERED_TOOL_PIN_TTL_MS).toBe(APPROVAL_TTL_MS);
  });

  it("names the LRU rule and the ON cap when it displaces", () => {
    expect(buildDisplacementWarning(["x.a"], CAP)).toBe(
      `"x.a" is no longer callable by name - this session keeps the ${String(CAP)} most recently `
      + "used discovered tools. Search for or select them again if you still need them.",
    );
    expect(discoveredToolCapacity(CAP)).toBe(CAP);
  });
});
