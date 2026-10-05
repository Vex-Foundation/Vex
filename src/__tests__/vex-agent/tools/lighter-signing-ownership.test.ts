/**
 * LIGHTER_SIGNING_OWNERSHIP_RECHECK: which wallet the approve call executes
 * under, the ownership rule itself, and that the approve handler hands its own
 * session wallet to the executor. The executor-level OFF==ON proof lives in
 * `lighter-order-create-execution.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LighterAccountResponse } from "@tools/lighter/types.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const WALLETS = vi.hoisted(() => ({
  selected: { id: "evm_selected", address: "0x1111111111111111111111111111111111111111", label: "Selected", createdAt: "2026-01-01T00:00:00.000Z" },
  primary: null as null | { id: string; address: string; label: string; createdAt: string },
}));

vi.mock("@tools/wallet/inventory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/wallet/inventory.js")>()),
  getPrimaryEvmEntry: () => WALLETS.primary,
  getWalletById: (family: string, id: string) =>
    family === "evm" && id === WALLETS.selected.id ? WALLETS.selected : null,
}));

const executor = vi.hoisted(() => ({
  execute: vi.fn(),
  intent: null as Record<string, unknown> | null,
}));

vi.mock("@vex-agent/tools/protocols/lighter/order-create-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/tools/protocols/lighter/order-create-execution.js")>()),
  executeApprovedLighterCreateOrder: executor.execute,
  getConfiguredLighterCreateOrderExecutionDeps: () => ({}),
}));
vi.mock("@vex-agent/db/repos/lighter-order-execution-intents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/repos/lighter-order-execution-intents.js")>()),
  findByIntentId: async () => executor.intent,
  markApprovalDecision: async () => ({ ...executor.intent, approvalStatus: "approved" }),
}));

import {
  judgeLighterSigningOwnership,
  LIGHTER_SIGNING_OWNERSHIP_NOT_MASTER,
  LIGHTER_SIGNING_OWNERSHIP_NOT_OWNED,
  LIGHTER_SIGNING_OWNERSHIP_WALLET_UNAVAILABLE,
  resolveLighterSigningOwnershipWallet,
} from "@vex-agent/tools/protocols/lighter/signing-ownership.js";
import { LIGHTER_WRITE_HANDLERS } from "@vex-agent/tools/protocols/lighter/handlers/write.js";
import { requireValue } from "../../helpers/require-value.js";

const SESSION_CTX: Pick<ProtocolExecutionContext, "walletResolution" | "walletPolicy"> = {
  walletResolution: { source: "session", evm: { id: WALLETS.selected.id, address: WALLETS.selected.address }, solana: null },
  walletPolicy: { kind: "none" },
};

function account(row: Partial<LighterAccountResponse["accounts"][number]> = {}): LighterAccountResponse {
  return { code: 200, total: 1, accounts: [{ index: 42, l1_address: WALLETS.selected.address, ...row }] };
}

beforeEach(() => {
  WALLETS.primary = null;
  executor.execute.mockReset();
});

describe("resolveLighterSigningOwnershipWallet", () => {
  it("is the session's selected wallet, as the preview resolves it", () => {
    expect(resolveLighterSigningOwnershipWallet(SESSION_CTX)).toEqual({ kind: "wallet", address: WALLETS.selected.address });
  });

  it("is unavailable when the session has no EVM wallet selected, the wallet was removed, its address drifted, or the policy is invalid", () => {
    expect(resolveLighterSigningOwnershipWallet({
      walletResolution: { source: "session", evm: null, solana: null },
      walletPolicy: { kind: "none" },
    })).toEqual({ kind: "unavailable" });
    expect(resolveLighterSigningOwnershipWallet({
      walletResolution: { source: "session", evm: { id: "evm_removed", address: WALLETS.selected.address }, solana: null },
      walletPolicy: { kind: "none" },
    })).toEqual({ kind: "unavailable" });
    expect(resolveLighterSigningOwnershipWallet({
      walletResolution: { source: "session", evm: { id: WALLETS.selected.id, address: `0x${"9".repeat(40)}` }, solana: null },
      walletPolicy: { kind: "none" },
    })).toEqual({ kind: "unavailable" });
    expect(resolveLighterSigningOwnershipWallet({
      walletResolution: SESSION_CTX.walletResolution,
      walletPolicy: { kind: "invalid", reason: "session_unavailable" },
    })).toEqual({ kind: "unavailable" });
  });

  it("is the primary wallet in a trusted default context, and lets a default context with no EVM wallet through as its preview does", () => {
    const defaults = { walletResolution: { source: "default" }, walletPolicy: { kind: "none" } } as const;
    expect(resolveLighterSigningOwnershipWallet(defaults)).toEqual({ kind: "trusted_default_without_wallet" });
    WALLETS.primary = { id: "evm_primary", address: `0x${"7".repeat(40)}`, label: "Primary", createdAt: "2026-01-01T00:00:00.000Z" };
    expect(resolveLighterSigningOwnershipWallet(defaults)).toEqual({ kind: "wallet", address: `0x${"7".repeat(40)}` });
  });
});

describe("judgeLighterSigningOwnership", () => {
  const wallet = { kind: "wallet", address: WALLETS.selected.address } as const;

  it("matches the owner without regard to case, and reports whether Lighter named the account type", () => {
    expect(judgeLighterSigningOwnership({ accountIndex: 42, account: account(), wallet }))
      .toEqual({ kind: "matched", accountTypeReported: false });
    expect(judgeLighterSigningOwnership({
      accountIndex: 42,
      account: account({ l1_address: WALLETS.selected.address.toUpperCase().replace("0X", "0x"), account_type: 0 }),
      wallet,
    })).toEqual({ kind: "matched", accountTypeReported: true });
  });

  it.each([
    { label: "another owner", row: { l1_address: `0x${"5".repeat(40)}` }, reason: LIGHTER_SIGNING_OWNERSHIP_NOT_OWNED },
    { label: "no owner", row: { l1_address: undefined }, reason: LIGHTER_SIGNING_OWNERSHIP_NOT_OWNED },
    { label: "a malformed owner", row: { l1_address: "not-a-wallet" }, reason: LIGHTER_SIGNING_OWNERSHIP_NOT_OWNED },
    { label: "a sub-account", row: { account_type: 1 }, reason: LIGHTER_SIGNING_OWNERSHIP_NOT_MASTER },
  ])("refuses $label", ({ row, reason }) => {
    expect(judgeLighterSigningOwnership({ accountIndex: 42, account: account(row), wallet })).toEqual({ kind: "refused", reason });
  });

  it("refuses an account answer without exactly one row for the approved index", () => {
    expect(judgeLighterSigningOwnership({ accountIndex: 43, account: account(), wallet }))
      .toEqual({ kind: "refused", reason: LIGHTER_SIGNING_OWNERSHIP_NOT_OWNED });
    const twice = account();
    expect(judgeLighterSigningOwnership({
      accountIndex: 42,
      account: { ...twice, accounts: [...twice.accounts, ...twice.accounts] },
      wallet,
    })).toEqual({ kind: "refused", reason: LIGHTER_SIGNING_OWNERSHIP_NOT_OWNED });
  });

  it("refuses when no usable session wallet reached it, and skips only the trusted default without a wallet", () => {
    for (const missing of [undefined, { kind: "unavailable" } as const, { kind: "wallet", address: "0x123" } as const]) {
      expect(judgeLighterSigningOwnership({ accountIndex: 42, account: account(), wallet: missing }))
        .toEqual({ kind: "refused", reason: LIGHTER_SIGNING_OWNERSHIP_WALLET_UNAVAILABLE });
    }
    expect(judgeLighterSigningOwnership({ accountIndex: 42, account: account(), wallet: { kind: "trusted_default_without_wallet" } }))
      .toEqual({ kind: "skipped_trusted_default" });
  });
});

describe("lighter.order.create hands the executor its own session wallet", () => {
  const INTENT = {
    intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
    sessionId: "session-1",
    previewId: "lighter-preview-1",
    protocolExecutionId: null,
    approvalId: null,
    matchHash: "a".repeat(64),
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    marketIndex: 0,
    side: "buy",
    baseAmountInteger: "10000",
    priceInteger: "300000",
    orderType: "market",
    timeInForce: "immediate-or-cancel",
    reduceOnly: false,
    triggerPriceInteger: null,
    orderExpiryMs: 1893456000000,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    providerVersion: "lighter-preview-v1",
    credentialRefJson: {
      kind: "encrypted_vault_reference",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/rhc/account-42/api-key-7",
    },
    approvalStatus: "approval_pending",
    executionState: "approval_pending",
    decisionReason: null,
    decidedAt: null,
    nonceReservationId: null,
    nonceValue: null,
    createdAt: "2026-08-12T00:00:01.000Z",
    updatedAt: "2026-08-12T00:00:02.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };

  async function approve(walletContext: Pick<ProtocolExecutionContext, "walletResolution" | "walletPolicy">) {
    executor.intent = INTENT;
    executor.execute.mockReset().mockResolvedValue({ status: "sequencer_pending", intentId: INTENT.intentId });
    const context: ProtocolExecutionContext = {
      sessionPermission: "full",
      approved: false,
      sessionId: "session-1",
      ...walletContext,
    };
    const result = await requireValue(LIGHTER_WRITE_HANDLERS["lighter.order.create"])({ intentId: INTENT.intentId }, context);
    expect(executor.execute, result.output).toHaveBeenCalledTimes(1);
    const call = requireValue(executor.execute.mock.calls[0]);
    const input: unknown = call[0];
    return typeof input === "object" && input !== null && "sessionWallet" in input ? input.sessionWallet : "absent";
  }

  it("passes the selected wallet, or says it is unavailable", async () => {
    expect(await approve(SESSION_CTX)).toEqual({ kind: "wallet", address: WALLETS.selected.address });
    expect(await approve({
      walletResolution: { source: "session", evm: null, solana: null },
      walletPolicy: { kind: "none" },
    })).toEqual({ kind: "unavailable" });
  });
});
