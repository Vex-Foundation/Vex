/**
 * THE OTHER APPROVAL KINDS - one pending approval of every family the money
 * card serves beside the swap, so the H3 frame can be checked on each (row
 * S6b-06): a wallet send, a bridge, a Lighter limit order, a Lighter deposit,
 * the Lighter trading-fee authorization, a token launch asked for over MCP, a
 * call to the user's own MCP tool, and a generic signed transaction.
 *
 * Each is an `ApprovalSummaryDto` in the shape its producer writes, read in
 * source: the wallet send's `WalletSendConfirm` arguments, the bridge's
 * `bridgeAmount` / `vexFee` display lines (`buildBridgeApprovalPreview`), the
 * Lighter rows the card's curated lists read (`ApprovalDetails.tsx`), the
 * `pools.launch_execute` parameters, and the `mcp` namespace the engine marks
 * an MCP tool call with. The action kinds are the manifests' own
 * (`lighter/manifests/write.ts`: an order create is `external_post`, a deposit
 * and the fee authorization `user_wallet_broadcast`). Every figure, address
 * and name is plausible and invented; none is a real wallet or transaction.
 *
 * They wait in the swap chat, which the swap-waiting state opens, so the
 * column around them is the same picture and only the cards differ.
 */

import type { ApprovalPendingGlobalDto, ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import { isoAt, MINUTE } from "../clock.js";
import { fixture } from "../mark.js";
import { EVM_WALLET } from "./base.js";
import { SWAP_CHAT } from "./sessions.js";

const SECOND = 1_000;
const FRIEND = "0x9a3c5f1e2d4b6a8c0e1f3a5b7c9d0e2f4a6b8c0d";
const LIGHTER_GATEWAY = "0x3b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f";
const FEE_COLLECTOR = "0x7e57fee000000000000000000000000000000fee";
const PROJECT = "48330000-0000-4000-8000-00000000f001";

type Over = Partial<ApprovalSummaryDto> & Pick<ApprovalSummaryDto, "id" | "toolName" | "preview">;

/** One pending approval in this chat, enqueued `agoMs` before the harness instant. */
function pending(agoMs: number, over: Over): ApprovalSummaryDto {
  return {
    sessionId: SWAP_CHAT.id,
    toolCallId: `call_${over.id}`,
    status: "pending",
    permissionAtEnqueue: "restricted",
    createdAt: isoAt(-agoMs),
    resolvedAt: null,
    reasoningPreview: "",
    actionKind: "user_wallet_broadcast",
    riskLevel: "high",
    expiresAt: isoAt(-agoMs + 10 * MINUTE),
    decision: null,
    decisionReason: null,
    executionStatus: "not_started",
    origin: "agent",
    projectId: null,
    requestedByClient: null,
    ...over,
  };
}

const KINDS: readonly ApprovalSummaryDto[] = [
  pending(30 * SECOND, {
    id: "h3-fixture-approval-transfer",
    toolName: "WalletSendConfirm",
    reasoningPreview: "Send the 25 USDC you asked for to your friend's address on Base.",
    preview: {
      toolName: "WalletSendConfirm",
      criticalArgs: { network: "eip155", chain: "base", to: FRIEND, amount: "25", token: "USDC" },
    },
  }),
  pending(40 * SECOND, {
    id: "h3-fixture-approval-bridge",
    toolName: "BridgeExecute",
    preview: {
      toolName: "BridgeExecute",
      criticalArgs: {
        fromChain: "8453",
        toChain: "42161",
        amountRaw: "50000000",
        slippageBps: 50,
        bridgeAmount: "50 USDC | 50000000 raw units | 6 decimals",
        bridgeDestinationWallet:
          `Destination wallet ${EVM_WALLET.address} | your selected EVM wallet | derived by Vex, never a parameter`,
        vexFee:
          "Vex fee 0.25% (25 bps): 0.125 USDC | 125000 raw units | 6 decimals, taken on the input token as a separate "
          + `transfer after the bridge confirms; 49875000 raw units are bridged; paid to ${FEE_COLLECTOR}; stated by the `
          + "matched quote and re-checked before signing.",
        safety: "pass",
      },
    },
  }),
  pending(50 * SECOND, {
    id: "h3-fixture-approval-lighter-order",
    toolName: "lighter:order.create",
    actionKind: "external_post",
    riskLevel: "medium",
    preview: {
      toolName: "order.create",
      namespace: "lighter",
      criticalArgs: {
        toolId: "lighter.order.create",
        environment: "core",
        side: "buy",
        baseAmountDisplay: "0.0002",
        marketSymbol: "BTC",
        marketType: "perp",
        orderType: "limit",
        timeInForce: "good-till-time",
        reduceOnly: false,
        priceDisplay: "68000.0",
        notionalDisplay: "13.6000000",
        orderExpiryIso: isoAt(28 * 24 * 60 * MINUTE),
      },
    },
  }),
  pending(60 * SECOND, {
    id: "h3-fixture-approval-lighter-deposit",
    toolName: "lighter:deposit",
    preview: {
      toolName: "deposit",
      namespace: "lighter",
      criticalArgs: {
        toolId: "lighter.deposit",
        summary: "Deposit 100 USDC from your wallet into your Lighter account",
        walletAddress: EVM_WALLET.address,
        depositTo: "Lighter Core, account 4821",
        settlementNetworkName: "Arbitrum",
        amountDisplay: "100 USDC",
        approvalRequired: "No: the allowance already covers this deposit",
        scopeNote: "One deposit of exactly this amount, sent once.",
        gatewayAddress: LIGHTER_GATEWAY,
      },
    },
  }),
  pending(70 * SECOND, {
    id: "h3-fixture-approval-lighter-fees",
    toolName: "lighter:fees.approve",
    riskLevel: "medium",
    preview: {
      toolName: "fees.approve",
      namespace: "lighter",
      criticalArgs: {
        toolId: "lighter.fees.approve",
        summary: "Authorize VEX trading fees",
        revoke: false,
        perpetualFee: "0.02% of each perpetual fill",
        spotFee: "0.02% of each spot fill",
        recipient: FEE_COLLECTOR,
        tradingAccount: "Lighter Core, account 4821",
        walletAddress: EVM_WALLET.address,
        authorizationValidUntil: isoAt(365 * 24 * 60 * MINUTE),
        scopeNote: "Vex may take these fees on fills until you revoke them; nothing else is authorized.",
      },
    },
  }),
  pending(80 * SECOND, {
    id: "h3-fixture-approval-launch",
    toolName: "pools:launch_execute",
    origin: "studio_mcp",
    projectId: PROJECT,
    requestedByClient: null,
    preview: {
      toolName: "launch_execute",
      namespace: "pools",
      criticalArgs: {
        toolId: "pools.launch_execute",
        chain: "4663",
        name: "Harbor Token",
        symbol: "HRBR",
        pairedAsset: "weth",
        prebuy: "0.01",
        holderRewards: false,
        imagePath: "art/harbor.png",
      },
    },
  }),
  pending(90 * SECOND, {
    id: "h3-fixture-approval-mcp",
    toolName: "mcp:deepwiki / read_wiki_structure",
    actionKind: "read",
    riskLevel: "info",
    expiresAt: null,
    preview: {
      toolName: "deepwiki / read_wiki_structure",
      namespace: "mcp",
      criticalArgs: { server: "deepwiki", tool: "read_wiki_structure", arguments: '{"repoName":"facebook/react"}' },
    },
  }),
  pending(100 * SECOND, {
    id: "h3-fixture-approval-signed-tx",
    toolName: "WalletEvmTransactionConfirm",
    preview: {
      toolName: "WalletEvmTransactionConfirm",
      criticalArgs: { chain: "base", recipient: FRIEND, value: "0", data: "0xa9059cbb" },
    },
  }),
];

/** The kinds as the chat's own pending read returns them. */
export function approvalKinds(): ApprovalSummaryDto[] {
  return fixture("approval-kinds", [...KINDS]);
}

/** The same rows as the app-wide inbox lists them. */
export function approvalKindsPendingAll(): ApprovalPendingGlobalDto[] {
  return approvalKinds().map((row) => ({ ...row, sessionTitle: SWAP_CHAT.title, projectName: null }));
}
