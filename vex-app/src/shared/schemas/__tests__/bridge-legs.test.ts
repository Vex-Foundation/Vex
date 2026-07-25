/**
 * Bridge leg DTO — schema parity + coercion (Agent Scan Phase 2).
 *
 * PARITY (Phase-1 column-list-parity discipline, mirrors
 * `messages-archive-column-parity`): the leg `role` and `chainFamily`
 * vocabularies are the RENDERER-side mirror of the `event_role` (bridge
 * subset, migration 045 + 050's `bridge_fee`) and `chain_family` CHECK
 * constraints. If a migration adds a
 * bridge role or family, this list AND the DTO MUST be updated in the same
 * change, or a real leg would silently drop out of `coerceBridgeLegs` (the leg
 * would fail `safeParse` and be omitted). This test is the source-of-truth pin.
 */

import { describe, expect, it } from "vitest";
import {
  bridgeChainFamilySchema,
  bridgeLegRoleSchema,
  bridgeLegSchema,
  coerceBridgeLegs,
  BRIDGE_LEGS_MAX,
  type BridgeLeg,
} from "../bridge-legs.js";

// The bridge `event_role` vocabulary (the subset a leg can carry) and
// `chain_family` vocabulary — kept in lockstep with
// `src/vex-agent/db/migrations/045_bridge_activity.sql` and
// `050_agent_activity_cost_breakdown.sql` (which added `bridge_fee`: the Vex
// integrator-fee transfer, recorded as `allowance` before 050).
const MIGRATION_BRIDGE_ROLES = [
  "allowance_reset",
  "allowance",
  "bridge_deposit",
  "bridge_fee",
  "bridge_fill_expected",
  "bridge_fill_observed",
  "bridge_refund",
] as const;
const MIGRATION_CHAIN_FAMILIES = ["eip155", "solana"] as const;

describe("bridge leg vocabulary parity with the migrations", () => {
  it("bridgeLegRoleSchema pins exactly the migration bridge event roles", () => {
    expect([...bridgeLegRoleSchema.options].sort()).toEqual(
      [...MIGRATION_BRIDGE_ROLES].sort(),
    );
  });

  it("bridgeChainFamilySchema pins exactly the migration chain families", () => {
    expect([...bridgeChainFamilySchema.options].sort()).toEqual(
      [...MIGRATION_CHAIN_FAMILIES].sort(),
    );
  });

  it("accepts a bridge_fee leg — a fee row must never drop out of coerceBridgeLegs", () => {
    const legs = coerceBridgeLegs([
      { role: "bridge_fee", chainId: 8453, chainFamily: "eip155", txHash: "0xfee", status: "confirmed", failureCode: null },
    ]);
    expect(legs).toHaveLength(1);
    expect(legs[0]?.role).toBe("bridge_fee");
  });
});

describe("bridgeLegSchema", () => {
  const valid: BridgeLeg = {
    role: "bridge_deposit",
    chainId: 8453,
    chainFamily: "eip155",
    txHash: "0xdeposit",
    status: "confirmed",
    failureCode: null,
  };

  it("accepts a well-formed leg", () => {
    expect(bridgeLegSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a hashless planned/pending leg (txHash null)", () => {
    expect(bridgeLegSchema.safeParse({ ...valid, txHash: null, status: "pending" }).success).toBe(true);
  });

  it("accepts a large Khalani-Solana chain id (>2^31, within safe-integer range)", () => {
    expect(
      bridgeLegSchema.safeParse({ ...valid, chainId: 20011000000, chainFamily: "solana", txHash: null }).success,
    ).toBe(true);
  });

  it("rejects an unknown role and an unknown family (closed vocab)", () => {
    expect(bridgeLegSchema.safeParse({ ...valid, role: "swap" }).success).toBe(false);
    expect(bridgeLegSchema.safeParse({ ...valid, chainFamily: "bitcoin" }).success).toBe(false);
  });

  it("rejects an unexpected extra key (strict)", () => {
    expect(bridgeLegSchema.safeParse({ ...valid, explorerUrl: "https://x" }).success).toBe(false);
  });
});

describe("coerceBridgeLegs", () => {
  it("null / non-array → []", () => {
    expect(coerceBridgeLegs(null)).toEqual([]);
    expect(coerceBridgeLegs(undefined)).toEqual([]);
    expect(coerceBridgeLegs("nope")).toEqual([]);
  });

  it("preserves EVERY well-formed leg in order (OWNER RULE — no truncation)", () => {
    const raw = [
      { role: "allowance", chainId: 8453, chainFamily: "eip155", txHash: "0xa", status: "confirmed", failureCode: null },
      { role: "bridge_deposit", chainId: 8453, chainFamily: "eip155", txHash: "0xb", status: "confirmed", failureCode: null },
      { role: "bridge_fill_expected", chainId: 42161, chainFamily: "eip155", txHash: "0xc", status: "confirmed", failureCode: null },
      { role: "bridge_refund", chainId: 8453, chainFamily: "eip155", txHash: "0xd", status: "confirmed", failureCode: null },
    ];
    const legs = coerceBridgeLegs(raw);
    expect(legs).toHaveLength(4);
    expect(legs.map((l) => l.role)).toEqual([
      "allowance",
      "bridge_deposit",
      "bridge_fill_expected",
      "bridge_refund",
    ]);
  });

  it("drops only a genuinely malformed leg, keeping the valid ones", () => {
    const raw = [
      { role: "bridge_deposit", chainId: 8453, chainFamily: "eip155", txHash: "0xb", status: "confirmed", failureCode: null },
      { role: "not_a_role", chainId: 1, chainFamily: "eip155", txHash: null, status: null, failureCode: null },
    ];
    const legs = coerceBridgeLegs(raw);
    expect(legs).toHaveLength(1);
    expect(legs[0]?.role).toBe("bridge_deposit");
  });

  it("BRIDGE_LEGS_MAX is generous enough for any real bridge", () => {
    expect(BRIDGE_LEGS_MAX).toBeGreaterThanOrEqual(16);
  });
});
