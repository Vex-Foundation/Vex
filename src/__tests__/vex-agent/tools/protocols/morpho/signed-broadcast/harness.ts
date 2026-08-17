/**
 * Shared fixtures and the mock surface for `signed-broadcast.test.ts`.
 *
 * The `vi.mock` calls themselves stay in the test file, because module mocking
 * is per-test-file. What lives here is everything that does not need hoisting:
 * the addresses, the client pair, the request builder, and the receipt shapes
 * each case group reads.
 */

import { vi, type Mock } from "vitest";

import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { getMorphoPublicClient } from "@tools/morpho/evm-client.js";
import { getMorphoActionClient } from "@tools/morpho/mutations/client.js";
import type * as SignedBroadcastModule from "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast.js";
import type {
  MorphoExecutionClients,
  MorphoVaultExecutionRequest,
} from "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast/run.js";

export const CHAIN_ID = 8453;
export const WALLET = "0xaAaAbBbBccCCddddEeeEFffF0000111122223333" as const;
export const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const VAULT = "0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca";
export const ADAPTER = "0xb98c948cfa24072e58935bc004a8a7b376ae746a";
export const BUNDLER3 = "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4";
export const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const DEPOSIT_ASSETS = 1_000_000n;
export const MINTED_SHARES = 970_000_000_000_000_000n;

function pad(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}
function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
export function transfer(token: string, from: string, to: string, amount: bigint) {
  return { address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: word(amount) };
}

/** A fresh accrued vault reading, in the shape `readMorphoVaultState` returns. */
export function vaultState() {
  return {
    generation: "v1" as const,
    address: VAULT,
    assetAddress: ASSET,
    assetDecimals: 6,
    assetSymbol: "USDC",
    shareDecimals: 18,
    shareSymbol: "steakUSDC",
    name: "Steakhouse USDC",
    assetsPerShareRaw: 1_030_000n,
    toShares: () => MINTED_SHARES,
    toAssets: () => DEPOSIT_ASSETS,
    performanceFeeRaw: null,
    managementFeeRaw: null,
  };
}

/** An allowance plan that still owes one exact-amount approval. */
export function allowancePlanNeedingApproval() {
  return {
    shape: "approve" as const,
    token: ASSET,
    owner: WALLET,
    spender: ADAPTER,
    spenderRole: "GeneralAdapter1",
    requiredAmountRaw: DEPOSIT_ASSETS,
    currentAllowanceRaw: 0n,
    steps: [{
      kind: "allowance" as const,
      to: ASSET,
      data: "0xapprove" as const,
      spender: ADAPTER,
      amountRaw: DEPOSIT_ASSETS,
      explanation: "exact",
    }],
  };
}

/** The rows `createAgentActivityIntent` would have returned for this plan. */
export function rowsFor(events: readonly Record<string, unknown>[]) {
  return events.map((event, index) => ({
    id: 100 + index,
    protocolExecutionId: 7,
    eventIndex: index,
    ...event,
    tokenInAddress: (event.tokenIn as { tokenAddress?: string } | undefined)?.tokenAddress ?? null,
    tokenOutAddress: (event.tokenOut as { tokenAddress?: string } | undefined)?.tokenAddress ?? null,
    amountInRaw: (event.tokenIn as { amountRaw?: string } | undefined)?.amountRaw ?? null,
    amountOutRaw: (event.tokenOut as { amountRaw?: string } | undefined)?.amountRaw ?? null,
  }));
}

/** The sealed block a confirmed receipt names, looked up BY HASH for its time. */
export const SEALED_BLOCK_HASH = `0x${"1".repeat(64)}` as const;

export const getBlockMock = vi.fn(async () => ({ timestamp: 1_760_000_000n }));

/**
 * REAL Base clients with only `getBlock` replaced. Nothing here reaches a
 * network: the staged-broadcast primitive and the execution preparation are
 * both mocked in the test file, so the wallet and action clients are only ever
 * carried. They are built rather than hand-shaped because an object literal is
 * not a viem client, and a double forced into position by a type escape would
 * keep compiling after `MorphoExecutionClients` gained a member.
 */
export const clients: MorphoExecutionClients = {
  publicClient: Object.assign(getMorphoPublicClient(CHAIN_ID), { getBlock: getBlockMock }),
  walletClient: createWalletClient({
    account: privateKeyToAccount(`0x${"1".repeat(64)}`),
    chain: base,
    transport: http("http://127.0.0.1:1"),
  }),
  actionClient: getMorphoActionClient(CHAIN_ID),
};

export function request(
  overrides: Partial<MorphoVaultExecutionRequest> = {},
): MorphoVaultExecutionRequest {
  return {
    toolId: "morpho.vault.deposit",
    sessionId: "session-1",
    intentParams: { vault: VAULT, amount: "1" },
    chainId: CHAIN_ID,
    vaultAddress: VAULT as Address,
    walletAddress: WALLET,
    amountRaw: DEPOSIT_ASSETS,
    slippageBps: 100,
    ...overrides,
  };
}

export function confirmedOutcome(logs: unknown[], txHash = "0xdep") {
  return {
    kind: "confirmed",
    txHash,
    receipt: { blockNumber: 42n, blockHash: SEALED_BLOCK_HASH, logs, status: "success" },
  };
}

/**
 * The mocked collaborators, plus the module under test, handed to each case
 * group so a group file never repeats the hoisted mock wiring.
 */
export interface SignedBroadcastContext {
  readonly module: typeof SignedBroadcastModule;
  readonly createIntent: Mock;
  readonly confirm: Mock;
  readonly fail: Mock;
  readonly abort: Mock;
  readonly notePendingReason: Mock;
  readonly noteBlockTime: Mock;
  readonly signStageBroadcast: Mock;
  readonly prepareExecution: Mock;
  readonly prepareLeg: Mock;
  /** The event inputs the module handed to `createAgentActivityIntent`. */
  readonly capturedEvents: () => Record<string, unknown>[];
}
