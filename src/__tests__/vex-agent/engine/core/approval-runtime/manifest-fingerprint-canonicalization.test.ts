/**
 * `computeManifestFingerprint` — WHICH reorderings are behaviour-preserving.
 *
 * The fingerprint's whole job is to answer "is the contract behind this toolId
 * still the one the human approved?". It canonicalizes orderings that NO caller
 * can observe, so a cosmetic reshuffle does not invalidate a queued approval.
 *
 * The regression this file freezes: ENUM MEMBER ORDER IS OBSERVABLE. Runtime
 * chain normalization (`tools/protocols/runtime/params.ts`) resolves a
 * case-insensitive match to the FIRST declared member, so an enum declared
 * `["base","BASE"]` and the same enum declared `["BASE","base"]` hand the
 * handler DIFFERENT strings for the identical user input. Sorting enum members
 * into the hash made those two contracts indistinguishable — a silent
 * substitution under a queued approval, which is exactly what the fingerprint
 * exists to prevent.
 */

import { describe, it, expect } from "vitest";

import { computeManifestFingerprint } from "@vex-agent/engine/core/approval-runtime/tool-call-envelope.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";

function manifestWith(overrides: Partial<ProtocolToolManifest>): ProtocolToolManifest {
  return {
    toolId: "test.fingerprint",
    namespace: "dexscreener",
    lifecycle: "active",
    description: "A fixture manifest used only to pin fingerprint canonicalization.",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
    ...overrides,
  } as ProtocolToolManifest;
}

function param(overrides: Partial<ProtocolToolManifest["params"][number]>) {
  return {
    key: "chain",
    type: "string",
    description: "Chain to read.",
    required: true,
    ...overrides,
  } as ProtocolToolManifest["params"][number];
}

describe("computeManifestFingerprint — enum member order", () => {
  it("CHANGES when an ambiguous enum is reordered — the handler-visible value changes with it", () => {
    const a = manifestWith({ params: [param({ enum: ["base", "BASE"] })] });
    const b = manifestWith({ params: [param({ enum: ["BASE", "base"] })] });

    expect(computeManifestFingerprint(a)).not.toBe(computeManifestFingerprint(b));
  });

  it("CHANGES when an unambiguous enum is reordered — declaration order is the contract", () => {
    const a = manifestWith({ params: [param({ enum: ["base", "arbitrum"] })] });
    const b = manifestWith({ params: [param({ enum: ["arbitrum", "base"] })] });

    expect(computeManifestFingerprint(a)).not.toBe(computeManifestFingerprint(b));
  });

  it("is STABLE for an identical enum declaration", () => {
    const a = manifestWith({ params: [param({ enum: ["base", "arbitrum"] })] });
    const b = manifestWith({ params: [param({ enum: ["base", "arbitrum"] })] });

    expect(computeManifestFingerprint(a)).toBe(computeManifestFingerprint(b));
  });

  it("still CHANGES when an enum member is added or removed", () => {
    const a = manifestWith({ params: [param({ enum: ["base"] })] });
    const b = manifestWith({ params: [param({ enum: ["base", "arbitrum"] })] });

    expect(computeManifestFingerprint(a)).not.toBe(computeManifestFingerprint(b));
  });
});

describe("computeManifestFingerprint — orderings that remain canonicalized", () => {
  it("is UNCHANGED when params are reordered (a call is keyed by name)", () => {
    const a = manifestWith({ params: [param({ key: "chain" }), param({ key: "query" })] });
    const b = manifestWith({ params: [param({ key: "query" }), param({ key: "chain" })] });

    expect(computeManifestFingerprint(a)).toBe(computeManifestFingerprint(b));
  });

  it("is UNCHANGED when group members or the groups themselves are reordered", () => {
    const params = [param({ key: "a" }), param({ key: "b" }), param({ key: "c" })];
    const a = manifestWith({ params, atMostOne: [["a", "b"], ["c"]] });
    const b = manifestWith({ params, atMostOne: [["c"], ["b", "a"]] });

    expect(computeManifestFingerprint(a)).toBe(computeManifestFingerprint(b));
  });
});

describe("computeManifestFingerprint - retired-spelling aliases", () => {
  const alias = (key: string) => ({ key, removeAfter: "D5 owner acceptance." });

  // The load-bearing one. `aliases` entered the projection in Batch 4; if it had
  // entered unconditionally (as `aliases: null`), EVERY queued approval in the
  // system would have been stranded by the field's arrival alone.
  it("leaves an alias-FREE manifest byte-identical to its pre-alias hash", () => {
    const bare = manifestWith({ params: [param({ key: "chain" })] });
    // Pinned literal, derived independently from the PRE-alias v2 field list
    // (key/type/required/unit/enum/acceptsStringArray plus the three group
    // fields), not copied out of the current implementation. A change here is a
    // stranded-approval migration, not a refactor.
    expect(computeManifestFingerprint(bare)).toBe("4e1100eabcbaf452be7826f62a9ad4a6");
  });

  it("CHANGES when an alias is added - an alias widens what the boundary admits", () => {
    const before = manifestWith({ params: [param({ key: "walletFamily" })] });
    const after = manifestWith({
      params: [param({ key: "walletFamily", aliases: [alias("wallet")] })],
    });

    expect(computeManifestFingerprint(after)).not.toBe(computeManifestFingerprint(before));
  });

  it("is UNCHANGED when alias declaration order is reshuffled - the keys are a SET", () => {
    const a = manifestWith({
      params: [param({ key: "walletFamily", aliases: [alias("wallet"), alias("network")] })],
    });
    const b = manifestWith({
      params: [param({ key: "walletFamily", aliases: [alias("network"), alias("wallet")] })],
    });

    expect(computeManifestFingerprint(a)).toBe(computeManifestFingerprint(b));
  });

  it("is UNCHANGED when only the `removeAfter` prose differs - it is not call shape", () => {
    const a = manifestWith({
      params: [param({ key: "walletFamily", aliases: [{ key: "wallet", removeAfter: "one" }] })],
    });
    const b = manifestWith({
      params: [param({ key: "walletFamily", aliases: [{ key: "wallet", removeAfter: "another" }] })],
    });

    expect(computeManifestFingerprint(a)).toBe(computeManifestFingerprint(b));
  });
});
