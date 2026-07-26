/**
 * Relay /chains route-health gate (Wave-2 W2, R11) — fail-closed matrix.
 *
 * A route is serviceable ONLY when BOTH chains are, right now, EVM AND
 * depositEnabled===true AND disabled===false. Every health field is optional on
 * the untrusted payload, so a MISSING field must fail exactly like a bad value.
 * This table walks every single-field defect on each side + not-found + the
 * origin-first tie-break.
 */

import { describe, it, expect } from "vitest";

import { evaluateRelayRouteHealth, type RelayChainHealthFailure } from "@tools/relay/health.js";
import type { RelayChain } from "@tools/relay/types.js";

const ORIGIN_ID = 8453;
const DEST_ID = 4663;

/** A fully-healthy chain; overrides carve out one defect at a time. */
function healthy(id: number, name: string, overrides: Partial<RelayChain> = {}): RelayChain {
  return { id, name, vmType: "evm", depositEnabled: true, disabled: false, ...overrides };
}

const OK_ORIGIN = healthy(ORIGIN_ID, "base");
const OK_DEST = healthy(DEST_ID, "robinhood");

describe("evaluateRelayRouteHealth — serviceable path", () => {
  it("both EVM + depositEnabled + not disabled → serviceable with both chains", () => {
    const result = evaluateRelayRouteHealth([OK_ORIGIN, OK_DEST], ORIGIN_ID, DEST_ID);
    expect(result.serviceable).toBe(true);
    if (result.serviceable) {
      expect(result.origin.id).toBe(ORIGIN_ID);
      expect(result.destination.id).toBe(DEST_ID);
    }
  });
});

// Each row mutates ONE health field on ONE side; `undefined` = the field is
// ABSENT (deleted), which must fail closed identically to a bad explicit value.
type Defect = { readonly patch: Partial<RelayChain>; readonly del?: keyof RelayChain; readonly reason: RelayChainHealthFailure };

const DEFECTS: readonly Defect[] = [
  { patch: { vmType: "svm" }, reason: "vm_type_not_evm" },
  { del: "vmType", patch: {}, reason: "vm_type_not_evm" },
  { patch: { depositEnabled: false }, reason: "deposit_not_enabled" },
  { del: "depositEnabled", patch: {}, reason: "deposit_not_enabled" },
  { patch: { disabled: true }, reason: "chain_disabled" },
  { del: "disabled", patch: {}, reason: "chain_disabled" },
];

function withDefect(base: RelayChain, defect: Defect): RelayChain {
  const next: RelayChain = { ...base, ...defect.patch };
  if (defect.del) delete (next as Record<string, unknown>)[defect.del];
  return next;
}

describe("evaluateRelayRouteHealth — origin-side defects fail closed", () => {
  for (const defect of DEFECTS) {
    const label = defect.del ? `missing ${defect.del}` : JSON.stringify(defect.patch);
    it(`origin ${label} → not serviceable (${defect.reason}, origin)`, () => {
      const result = evaluateRelayRouteHealth([withDefect(OK_ORIGIN, defect), OK_DEST], ORIGIN_ID, DEST_ID);
      expect(result).toMatchObject({ serviceable: false, failedSide: "origin", chainId: ORIGIN_ID, reason: defect.reason });
    });
  }
});

describe("evaluateRelayRouteHealth — destination-side defects fail closed", () => {
  for (const defect of DEFECTS) {
    const label = defect.del ? `missing ${defect.del}` : JSON.stringify(defect.patch);
    it(`destination ${label} → not serviceable (${defect.reason}, destination)`, () => {
      const result = evaluateRelayRouteHealth([OK_ORIGIN, withDefect(OK_DEST, defect)], ORIGIN_ID, DEST_ID);
      expect(result).toMatchObject({ serviceable: false, failedSide: "destination", chainId: DEST_ID, reason: defect.reason });
    });
  }
});

describe("evaluateRelayRouteHealth — not found + tie-break", () => {
  it("origin absent from the registry → chain_not_found (origin)", () => {
    const result = evaluateRelayRouteHealth([OK_DEST], ORIGIN_ID, DEST_ID);
    expect(result).toMatchObject({ serviceable: false, failedSide: "origin", chainId: ORIGIN_ID, reason: "chain_not_found" });
  });
  it("destination absent from the registry → chain_not_found (destination)", () => {
    const result = evaluateRelayRouteHealth([OK_ORIGIN], ORIGIN_ID, DEST_ID);
    expect(result).toMatchObject({ serviceable: false, failedSide: "destination", chainId: DEST_ID, reason: "chain_not_found" });
  });
  it("empty registry → origin reported first", () => {
    const result = evaluateRelayRouteHealth([], ORIGIN_ID, DEST_ID);
    expect(result).toMatchObject({ serviceable: false, failedSide: "origin", reason: "chain_not_found" });
  });
  it("BOTH sides broken → origin reported first (deterministic)", () => {
    const result = evaluateRelayRouteHealth(
      [withDefect(OK_ORIGIN, { patch: { disabled: true }, reason: "chain_disabled" }), withDefect(OK_DEST, { patch: { depositEnabled: false }, reason: "deposit_not_enabled" })],
      ORIGIN_ID,
      DEST_ID,
    );
    expect(result).toMatchObject({ serviceable: false, failedSide: "origin", reason: "chain_disabled" });
  });
});
