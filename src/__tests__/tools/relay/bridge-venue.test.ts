/**
 * Bridge VENUE ROUTER - chain-aware Khalani/Relay policy (owner decision
 * 2026-08-17).
 *
 * The live Khalani registry is the input, so it is mocked at the client seam
 * (`getKhalaniClient`) rather than over HTTP: these tests are about the ROUTING
 * DECISION, not about how the list is fetched. The 24h module cache is cleared
 * per test so one case's registry can never decide the next one's route.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const khalaniClient = vi.hoisted(() => ({ getChains: vi.fn() }));
vi.mock("@tools/khalani/client.js", () => ({ getKhalaniClient: () => khalaniClient }));

import { resolveBridgeVenue } from "@tools/relay/bridge-venue.js";
import { clearKhalaniChainsCache } from "@tools/khalani/chains.js";

/** A minimal registry row - only `id` reaches the venue decision. */
function chain(id: number) {
  return { type: "eip155" as const, id, name: `chain-${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } };
}

/** Khalani serves Ethereum, Base and Arbitrum in these tests; nothing else. */
const SERVED = [chain(1), chain(8453), chain(42161)];

beforeEach(() => {
  clearKhalaniChainsCache();
  khalaniClient.getChains.mockReset();
  khalaniClient.getChains.mockResolvedValue(SERVED);
});

describe("resolveBridgeVenue", () => {
  it("routes to khalani when the live registry serves BOTH sides", async () => {
    expect(await resolveBridgeVenue("base", "ethereum")).toEqual({ venue: "khalani" });
    expect(await resolveBridgeVenue("8453", "42161")).toEqual({ venue: "khalani" });
  });

  it("routes to relay when ONE side is absent from the live registry", async () => {
    expect(await resolveBridgeVenue("base", "hyperevm")).toEqual({ venue: "relay" });
    expect(await resolveBridgeVenue("sonic", "ethereum")).toEqual({ venue: "relay" });
  });

  it("routes to relay when NEITHER side is in the live registry", async () => {
    expect(await resolveBridgeVenue("hyperevm", "robinhood")).toEqual({ venue: "relay" });
  });

  it("still routes Robinhood Chain to relay, now from the registry rather than a constant", async () => {
    expect(await resolveBridgeVenue("base", "robinhood")).toEqual({ venue: "relay" });
    expect(await resolveBridgeVenue("4663", "base")).toEqual({ venue: "relay" });
  });

  it("refuses BY NAME for a chain no Vex registry resolves, instead of naming a venue", async () => {
    const decision = await resolveBridgeVenue("base", "arc");
    expect(decision.venue).toBeNull();
    expect(decision.refusal).toContain("\"arc\" is not a chain Vex can resolve");
    expect(khalaniClient.getChains).not.toHaveBeenCalled();
  });

  it("refuses when the Khalani registry cannot be READ - it must not silently pick relay", async () => {
    khalaniClient.getChains.mockRejectedValue(new Error("upstream 503"));
    const decision = await resolveBridgeVenue("base", "ethereum");
    expect(decision.venue).toBeNull();
    expect(decision.refusal).toContain("could not be read");
    // The real cause is never leaked verbatim, and no venue is guessed.
    expect(decision.refusal).not.toContain("503");
  });

  it("treats an EMPTY registry as unreadable rather than as zero coverage", async () => {
    khalaniClient.getChains.mockResolvedValue([]);
    const decision = await resolveBridgeVenue("base", "ethereum");
    expect(decision.venue).toBeNull();
    expect(decision.refusal).toContain("could not be read");
  });

  it("reads the registry once per day, not once per route", async () => {
    await resolveBridgeVenue("base", "ethereum");
    await resolveBridgeVenue("ethereum", "arbitrum");
    expect(khalaniClient.getChains).toHaveBeenCalledTimes(1);
  });
});
