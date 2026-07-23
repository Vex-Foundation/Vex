import { afterEach, describe, expect, it } from "vitest";
import {
  buildBridgeCapabilityPrompt,
  buildProtocolsPrompt,
  resetProtocolsPromptCache,
} from "@vex-agent/engine/prompts/protocols.js";
import {
  BRIDGE_CAPABILITY_ABSENT_AFTER_MS,
  BRIDGE_CAPABILITY_STALE_AFTER_MS,
  CURATED_BRIDGE_CHAIN_NAMES,
  classifyBridgeCapability,
  getBridgeCapabilitySnapshotForTest,
  getBridgeCapabilityView,
  isRobinhoodRelayHealthy,
  projectBridgeChainNames,
  resetBridgeCapabilityStateForTest,
  sanitizeBridgeChainName,
  setBridgeCapabilityFetchersForTest,
  setBridgeCapabilitySnapshotForTest,
  triggerBridgeCapabilityRefresh,
  type BridgeCapabilitySnapshot,
} from "@vex-agent/tools/protocols/khalani/capability-snapshot.js";
import type { KhalaniChain } from "@tools/khalani/types.js";
import type { RelayChain } from "@tools/relay/types.js";

/** Fixed reference time for the PURE freshness/render tests. */
const NOW = 1_700_000_000_000;

/**
 * A Khalani chain fixture. `name` is a provider string that MUST NOT reach the
 * prompt — the projection uses only the curated map. `type` is widened to accept
 * a foreign family (bitcoin/tron) so the defensive family filter can be exercised
 * even though the live client never yields those.
 */
function khChain(id: number, type = "eip155"): KhalaniChain {
  return {
    type: type as KhalaniChain["type"],
    id,
    name: `provider-name-${id}`,
    nativeCurrency: { name: "Native", symbol: "N", decimals: 18 },
  };
}

function relayChain(
  id: number,
  opts: { depositEnabled?: boolean; disabled?: boolean } = {},
): RelayChain {
  return { id, name: `relay-${id}`, ...opts };
}

const snap = (
  ageMs: number,
  chainNames: string[],
  robinhoodViaRelay = false,
): BridgeCapabilitySnapshot => ({
  chainNames,
  robinhoodViaRelay,
  lastSuccessfulAt: NOW - ageMs,
});

afterEach(() => {
  resetBridgeCapabilityStateForTest();
  resetProtocolsPromptCache();
});

describe("projectBridgeChainNames — lockstep to live snapshot + curated map", () => {
  // Mirrors protocols.test.ts:38-63 (the KyberSwap lockstep). The expectation is
  // recomputed INDEPENDENTLY of projectBridgeChainNames from the presence rule
  // (live data + family) + wording (curated map) + ordering — a real regression
  // guard: if the projection ever stops family-filtering, reads the provider
  // `name`, drops the curated-map gate, or changes ordering, the rendered list
  // and this expectation diverge.
  it("chain list is derived from the live registry, never hand-written", () => {
    const fixture: KhalaniChain[] = [
      khChain(8453), // Base
      khChain(1), // Ethereum
      khChain(20011000000, "solana"), // Solana
      khChain(42161), // Arbitrum
      khChain(728126428, "tron"), // foreign family → excluded
      khChain(999999), // unknown id → omitted
    ];
    const expected = fixture
      .filter((c) => c.type === "eip155" || c.type === "solana")
      .map((c) => CURATED_BRIDGE_CHAIN_NAMES[c.id])
      .filter((name): name is string => name !== undefined)
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));

    const view = classifyBridgeCapability(
      { chainNames: projectBridgeChainNames(fixture), robinhoodViaRelay: false, lastSuccessfulAt: NOW },
      NOW,
    );
    const section = buildBridgeCapabilityPrompt(view);
    const match = section.match(/Bridge-supported chains \(Khalani\): ([^.]+)\./);
    expect(match, `expected a chain-list sentence in the rendered section; got:\n${section}`).not.toBeNull();
    const rendered = match![1]!.split(", ").map((s) => s.trim());

    expect(rendered).toEqual(expected);
    expect(rendered).toEqual(["Arbitrum", "Base", "Ethereum", "Solana"]);
    // No provider name string ever leaks into the prompt.
    expect(section).not.toContain("provider-name-");
  });
});

describe("projectBridgeChainNames — defensive sanitization", () => {
  it("strips control chars and newlines from a name", () => {
    expect(sanitizeBridgeChainName("Ba\u0000se\n")).toBe("Base");
    expect(sanitizeBridgeChainName("  Ar\tbi\rtrum  ")).toBe("Arbitrum");
    expect(sanitizeBridgeChainName("\u007FSolana")).toBe("Solana");
  });

  it("dedupes duplicate chain ids", () => {
    expect(projectBridgeChainNames([khChain(8453), khChain(8453), khChain(8453)])).toEqual(["Base"]);
  });

  it("omits unknown ids and foreign families", () => {
    const names = projectBridgeChainNames([
      khChain(999999), // unknown id
      khChain(0, "bitcoin"), // foreign family
      khChain(728126428, "tron"), // foreign family (live but unsignable)
      khChain(8453), // valid
    ]);
    expect(names).toEqual(["Base"]);
  });

  it("bounds an oversized upstream list to curated matches", () => {
    const oversized: KhalaniChain[] = [];
    for (let i = 0; i < 500; i += 1) oversized.push(khChain(900_000 + i)); // all unknown ids
    oversized.push(khChain(8453));
    oversized.push(khChain(1));
    const names = projectBridgeChainNames(oversized);
    expect(names).toEqual(["Base", "Ethereum"]);
    expect(names.length).toBeLessThanOrEqual(64);
  });
});

describe("classifyBridgeCapability + render — freshness matrix", () => {
  it("fresh snapshot renders the list with no staleness note", () => {
    const section = buildBridgeCapabilityPrompt(classifyBridgeCapability(snap(5 * 60_000, ["Base", "Arbitrum"]), NOW));
    expect(section).toContain("Bridge-supported chains (Khalani): Base, Arbitrum.");
    expect(section).not.toContain("up to a day old");
    expect(section).not.toContain("bridges via Relay only");
  });

  it("stale snapshot (>60m, <24h) renders the list + a staleness note", () => {
    const section = buildBridgeCapabilityPrompt(classifyBridgeCapability(snap(2 * 60 * 60_000, ["Base"]), NOW));
    expect(section).toContain("Bridge-supported chains (Khalani): Base.");
    expect(section).toContain("up to a day old");
  });

  it("absent snapshot (>=24h) renders the fallback line only", () => {
    const section = buildBridgeCapabilityPrompt(classifyBridgeCapability(snap(25 * 60 * 60_000, ["Base"]), NOW));
    expect(section).toContain("Bridge chain list unavailable — verify by quoting.");
    expect(section).not.toContain("Bridge-supported chains (Khalani)");
  });

  it("null (cold start) snapshot renders the fallback line", () => {
    expect(buildBridgeCapabilityPrompt(classifyBridgeCapability(null, NOW))).toContain(
      "Bridge chain list unavailable — verify by quoting.",
    );
  });

  it("an empty chain list classifies unavailable (defensive)", () => {
    expect(classifyBridgeCapability(snap(0, []), NOW).kind).toBe("unavailable");
  });

  it("threshold boundaries are exact", () => {
    expect(classifyBridgeCapability(snap(BRIDGE_CAPABILITY_STALE_AFTER_MS - 1, ["Base"]), NOW)).toMatchObject({
      kind: "available",
      stale: false,
    });
    expect(classifyBridgeCapability(snap(BRIDGE_CAPABILITY_STALE_AFTER_MS, ["Base"]), NOW)).toMatchObject({
      kind: "available",
      stale: true,
    });
    expect(classifyBridgeCapability(snap(BRIDGE_CAPABILITY_ABSENT_AFTER_MS - 1, ["Base"]), NOW)).toMatchObject({
      kind: "available",
      stale: true,
    });
    expect(classifyBridgeCapability(snap(BRIDGE_CAPABILITY_ABSENT_AFTER_MS, ["Base"]), NOW).kind).toBe("unavailable");
  });
});

describe("Robinhood-via-Relay health gate", () => {
  it("passes only when 4663 is present, depositEnabled, and not disabled", () => {
    expect(isRobinhoodRelayHealthy([relayChain(4663, { depositEnabled: true, disabled: false })])).toBe(true);
  });

  it("fails closed on a missing chain, missing fields, disabled, or the wrong chain", () => {
    expect(isRobinhoodRelayHealthy([])).toBe(false);
    expect(isRobinhoodRelayHealthy([relayChain(4663, { depositEnabled: true })])).toBe(false);
    expect(isRobinhoodRelayHealthy([relayChain(4663, { disabled: false })])).toBe(false);
    expect(isRobinhoodRelayHealthy([relayChain(4663, { depositEnabled: true, disabled: true })])).toBe(false);
    expect(isRobinhoodRelayHealthy([relayChain(1, { depositEnabled: true, disabled: false })])).toBe(false);
  });

  it("renders the Robinhood line only when the gate passed", () => {
    const withGate = buildBridgeCapabilityPrompt(
      classifyBridgeCapability({ chainNames: ["Base"], robinhoodViaRelay: true, lastSuccessfulAt: NOW }, NOW),
    );
    expect(withGate).toContain("Robinhood Chain (4663): bridges via Relay only.");
    expect(withGate).toContain("To fund Robinhood Chain");

    const withoutGate = buildBridgeCapabilityPrompt(
      classifyBridgeCapability({ chainNames: ["Base"], robinhoodViaRelay: false, lastSuccessfulAt: NOW }, NOW),
    );
    expect(withoutGate).not.toContain("bridges via Relay only");
    expect(withoutGate).not.toContain("To fund Robinhood Chain");
  });

  it("never enumerates Relay's general chain catalog", () => {
    const section = buildBridgeCapabilityPrompt(
      classifyBridgeCapability({ chainNames: ["Base", "Arbitrum"], robinhoodViaRelay: true, lastSuccessfulAt: NOW }, NOW),
    );
    expect(section).not.toMatch(/Relay-supported chains/i);
    expect(section).not.toMatch(/chains \(Relay\)/i);
  });
});

describe("cache safety — the dynamic layer carries the change, not buildProtocolsPrompt", () => {
  it("buildProtocolsPrompt is snapshot-independent and carries no live chain list", () => {
    resetProtocolsPromptCache();
    setBridgeCapabilitySnapshotForTest({ chainNames: ["Base"], robinhoodViaRelay: true, lastSuccessfulAt: NOW });
    const a = buildProtocolsPrompt();

    resetProtocolsPromptCache();
    setBridgeCapabilitySnapshotForTest({ chainNames: ["Arbitrum", "Ethereum"], robinhoodViaRelay: false, lastSuccessfulAt: NOW });
    const b = buildProtocolsPrompt();

    expect(a).toEqual(b);
    expect(a).not.toContain("Bridge-supported chains (Khalani)");
    expect(a).not.toContain("Robinhood Chain (4663): bridges via Relay only");
  });

  it("the dynamic layer DOES change with the snapshot", () => {
    const a = buildBridgeCapabilityPrompt(
      classifyBridgeCapability({ chainNames: ["Base"], robinhoodViaRelay: false, lastSuccessfulAt: NOW }, NOW),
    );
    const b = buildBridgeCapabilityPrompt(
      classifyBridgeCapability({ chainNames: ["Arbitrum", "Ethereum"], robinhoodViaRelay: false, lastSuccessfulAt: NOW }, NOW),
    );
    expect(a).toContain("Bridge-supported chains (Khalani): Base.");
    expect(b).toContain("Bridge-supported chains (Khalani): Arbitrum, Ethereum.");
    expect(a).not.toEqual(b);
  });
});

describe("snapshot refresh state machine (single-flight + fail-soft)", () => {
  it("single-flight: concurrent triggers share one Khalani fetch", async () => {
    resetBridgeCapabilityStateForTest();
    let khalaniCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setBridgeCapabilityFetchersForTest({
      fetchKhalaniChains: async () => {
        khalaniCalls += 1;
        await gate;
        return [khChain(8453)];
      },
      fetchRelayChains: async () => [],
    });

    const p1 = triggerBridgeCapabilityRefresh();
    const p2 = triggerBridgeCapabilityRefresh();
    release();
    await Promise.all([p1, p2]);

    expect(khalaniCalls).toBe(1);
    expect(getBridgeCapabilitySnapshotForTest()?.chainNames).toEqual(["Base"]);
  });

  it("a Khalani fetch failure keeps the last good snapshot", async () => {
    resetBridgeCapabilityStateForTest();
    const good: BridgeCapabilitySnapshot = { chainNames: ["Base"], robinhoodViaRelay: true, lastSuccessfulAt: NOW };
    setBridgeCapabilitySnapshotForTest(good);
    setBridgeCapabilityFetchersForTest({
      fetchKhalaniChains: async () => {
        throw new Error("khalani down");
      },
      fetchRelayChains: async () => [relayChain(4663, { depositEnabled: true, disabled: false })],
    });

    await triggerBridgeCapabilityRefresh();

    expect(getBridgeCapabilitySnapshotForTest()).toEqual(good);
  });

  it("a Relay health failure drops the Robinhood gate but still builds the snapshot", async () => {
    resetBridgeCapabilityStateForTest();
    setBridgeCapabilityFetchersForTest({
      fetchKhalaniChains: async () => [khChain(8453)],
      fetchRelayChains: async () => {
        throw new Error("relay down");
      },
    });

    await triggerBridgeCapabilityRefresh();

    const stored = getBridgeCapabilitySnapshotForTest();
    expect(stored?.chainNames).toEqual(["Base"]);
    expect(stored?.robinhoodViaRelay).toBe(false);
  });

  it("stale-while-revalidate: cold accessor returns the fallback, then populates", async () => {
    resetBridgeCapabilityStateForTest();
    setBridgeCapabilityFetchersForTest({
      fetchKhalaniChains: async () => [khChain(8453), khChain(1)],
      fetchRelayChains: async () => [relayChain(4663, { depositEnabled: true, disabled: false })],
    });

    const cold = await getBridgeCapabilityView();
    expect(cold.kind).toBe("unavailable");

    await triggerBridgeCapabilityRefresh();

    const warm = await getBridgeCapabilityView();
    expect(warm).toMatchObject({
      kind: "available",
      chainNames: ["Base", "Ethereum"],
      robinhoodViaRelay: true,
      stale: false,
    });
  });
});
