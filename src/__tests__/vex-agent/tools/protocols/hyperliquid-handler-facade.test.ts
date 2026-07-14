import { describe, expect, it } from "vitest";

import * as handlersModule from "@vex-agent/tools/protocols/hyperliquid/handlers.js";

const EXPECTED_HANDLER_IDS = [
  "hyperliquid.perp.markets",
  "hyperliquid.perp.positions",
  "hyperliquid.perp.orders",
  "hyperliquid.perp.fills",
  "hyperliquid.perp.funding",
  "hyperliquid.account.overview",
  "hyperliquid.spot.markets",
  "hyperliquid.spot.balances",
  "hyperliquid.market.book",
  "hyperliquid.risk.proposeSetup",
  "hyperliquid.perp.open",
  "hyperliquid.perp.close",
  "hyperliquid.perp.setTpsl",
  "hyperliquid.perp.modifyOrder",
  "hyperliquid.perp.cancelOrders",
  "hyperliquid.perp.setLeverage",
  "hyperliquid.perp.adjustMargin",
  "hyperliquid.perp.twap",
  "hyperliquid.spot.trade",
  "hyperliquid.deposit",
  "hyperliquid.transfer.usdClass",
  "hyperliquid.withdraw",
  "hyperliquid.transfer.send",
  "hyperliquid.vault.overview",
  "hyperliquid.vault.transfer",
  "hyperliquid.staking.overview",
  "hyperliquid.staking.delegate",
  "hyperliquid.staking.transfer",
  "hyperliquid.rewards.claim",
  "hyperliquid.builder.approveFee",
  "hyperliquid.workspace.enter",
  "hyperliquid.workspace.exit",
] as const;

const EXPECTED_RUNTIME_EXPORTS = [
  "HYPERLIQUID_HANDLERS",
  "applyOpenLeverage",
  "auditCapture",
  "builderForOrders",
  "cancelStaleStopsAfterReplacement",
  "capturePerpSafely",
  "compensateRejectedStop",
  "consolidateConfirmedOpen",
  "hyperliquidDepositCapture",
  "preflightConfigureAndSubmitPerpOpen",
  "requestHyperliquidWorkspaceMode",
  "resetBuilderFeeAllowanceMemoForTests",
] as const;

describe("Hyperliquid handler facade", () => {
  it("preserves the exact handler routing table and insertion order", () => {
    expect(Object.keys(handlersModule.HYPERLIQUID_HANDLERS)).toEqual(EXPECTED_HANDLER_IDS);
    for (const handlerId of EXPECTED_HANDLER_IDS) {
      expect(handlersModule.HYPERLIQUID_HANDLERS[handlerId]).toBeTypeOf("function");
    }
  });

  it("preserves the existing runtime export surface", () => {
    expect(Object.keys(handlersModule).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
  });
});
