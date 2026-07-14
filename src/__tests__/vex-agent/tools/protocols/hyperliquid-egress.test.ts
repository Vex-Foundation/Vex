import { describe, expect, it } from "vitest";

import { hyperliquidPolicySchema } from "../../../../lib/hyperliquid-policy.js";
import {
  classifyHyperliquidEgress,
  evaluateApprovalGate,
} from "@vex-agent/tools/protocols/runtime/gates.js";
import type { ProtocolExecutionContext, ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";

const OWN_ADDRESS = "0x1111111111111111111111111111111111111111";
const FOREIGN_ADDRESS = "0x2222222222222222222222222222222222222222";

const manifest = (toolId: string): ProtocolToolManifest => ({
  toolId,
  namespace: "hyperliquid",
  lifecycle: "active",
  description: "test",
  mutating: true,
  actionKind: "external_post",
  params: [],
  exampleParams: {},
});

const context = (permission: "restricted" | "full", approved = false): ProtocolExecutionContext => ({
  sessionPermission: permission,
  approved,
  walletResolution: {
    source: "session",
    evm: { id: "wallet-1", address: OWN_ADDRESS },
    solana: null,
  },
  walletPolicy: { kind: "none" },
  hyperliquidPolicy: {
    kind: "available",
    snapshot: {
      policy: hyperliquidPolicySchema.parse({ egressAlwaysApprove: true }),
      version: "test",
      resolvedAt: "2026-07-11T00:00:00.000Z",
      provenance: "preferences",
    },
  },
});

function requiresApproval(
  toolId: string,
  params: Record<string, unknown>,
  permission: "restricted" | "full",
): boolean {
  return evaluateApprovalGate(
    manifest(toolId),
    { toolId },
    params,
    context(permission),
    undefined,
    undefined,
    undefined,
  )?.pendingApproval === true;
}

describe("Hyperliquid egress approval", () => {
  it.each([
    ["restricted", "hyperliquid.deposit", {}, true],
    ["restricted", "hyperliquid.transfer.usdClass", {}, true],
    ["restricted", "hyperliquid.withdraw", { destination: OWN_ADDRESS }, true],
    ["restricted", "hyperliquid.withdraw", { destination: FOREIGN_ADDRESS }, true],
    ["restricted", "hyperliquid.transfer.send", { destination: OWN_ADDRESS }, true],
    ["full", "hyperliquid.deposit", {}, false],
    ["full", "hyperliquid.transfer.usdClass", {}, false],
    ["full", "hyperliquid.withdraw", { destination: OWN_ADDRESS.toUpperCase() }, false],
    ["full", "hyperliquid.withdraw", { destination: FOREIGN_ADDRESS }, true],
    ["full", "hyperliquid.transfer.send", { destination: OWN_ADDRESS }, true],
  ] as const)("%s %s approval=%s", (permission, toolId, params, expected) => {
    expect(requiresApproval(toolId, params, permission)).toBe(expected);
  });

  it("fails closed for a missing or invalid destination and a non-session wallet snapshot", () => {
    expect(classifyHyperliquidEgress("hyperliquid.withdraw", {}, context("full"))).toBe("foreign");
    expect(classifyHyperliquidEgress("hyperliquid.withdraw", { destination: "not-an-address" }, context("full"))).toBe("foreign");
    expect(classifyHyperliquidEgress("hyperliquid.withdraw", { destination: OWN_ADDRESS }, {
      ...context("full"),
      walletResolution: { source: "default" },
    })).toBe("foreign");
  });

  it("recognises only a validated case-insensitive self withdrawal as own-account funding", () => {
    expect(classifyHyperliquidEgress("hyperliquid.withdraw", { destination: OWN_ADDRESS.toUpperCase() }, context("full"))).toBe("own_account");
    expect(classifyHyperliquidEgress("hyperliquid.deposit", {}, context("full"))).toBe("own_account");
    expect(classifyHyperliquidEgress("hyperliquid.transfer.usdClass", {}, context("full"))).toBe("own_account");
    expect(classifyHyperliquidEgress("hyperliquid.perp.open", {}, context("full"))).toBe("none");
  });

  it("keeps trusted Hyperliquid preview extras on a forced foreign-egress approval", () => {
    const hyperliquid = {
      stopLossVerdict: "protected_required" as const,
      notionalUsd: "100",
      estLiquidationPx: "50000",
    };
    expect(evaluateApprovalGate(
      manifest("hyperliquid.transfer.send"),
      { toolId: "hyperliquid.transfer.send" },
      { destination: FOREIGN_ADDRESS },
      context("full"),
      undefined,
      undefined,
      undefined,
      hyperliquid,
    )).toMatchObject({ pendingApproval: true, hyperliquid });
  });
});
