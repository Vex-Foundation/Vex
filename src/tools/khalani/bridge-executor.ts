/**
 * Khalani bridge executor — STAGED broadcast primitives (Phase-2 R4).
 *
 * The origin deposit + any allowance approvals are Vex-signed, so they follow
 * the full staged discipline the Agent Scan ledger requires: the caller (the
 * `khalani.bridge` handler) creates the `agent_activity` rows FIRST, then drives
 * this module ONE leg at a time — sign locally, hand the caller the computed
 * hash/signature to persist BEFORE it reaches the network, broadcast, then wait a
 * bounded receipt. A crash between sign and send leaves a discoverable pending
 * row, never a silently lost transaction.
 *
 * This module holds the signing keys (it lives under `src/tools/khalani`, outside
 * the `src/vex-agent/tools` signer-import allowlist walk); the handler passes a
 * resolved `ChainWallet` and receives only computed hashes back through the
 * staging hooks, so no key material crosses into `src/vex-agent`.
 *
 * Planning (`planKhalaniDepositLegs`) is pure/network-free: it converts a
 * `DepositPlan` into the ordered list of broadcast legs (with their
 * `agent_activity` roles) WITHOUT signing, so the handler can create every
 * planned row before anything is signed.
 */

import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { VexError, ErrorCodes } from "../../errors.js";
import { ERC20_ABI } from "../../constants/chain.js";
import { getChainRpcUrl } from "./chains.js";
import { createDynamicPublicClient, createDynamicWalletClient } from "./evm-client.js";
import {
  broadcastSignedSolanaTransaction,
  confirmSolanaSignature,
  signSolanaTransactionWithSignature,
} from "./solana-signer.js";
import type {
  Approval,
  ChainFamily,
  ContractCallDepositPlan,
  DepositPlan,
  EvmApproval,
  KhalaniChain,
  SolanaApproval,
  TransferDepositPlan,
} from "./types.js";
import type { ChainWallet } from "../wallet/multi-auth.js";

interface Eip1193TransactionRequest {
  from?: string;
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
}

// ── Pure parsers (retained; unit-covered by khalani-bridge-executor.test.ts) ──

export function parseBigintish(value: unknown, field: string): bigint | undefined {
  if (value == null) return undefined;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, `Invalid bigint field in ${field}: ${value}`);
    }
  }
  throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, `Unsupported value for ${field}.`);
}

function parseNumberish(value: unknown, field: string): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = value.startsWith("0x") ? Number.parseInt(value.slice(2), 16) : Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, `Unsupported numeric value for ${field}.`);
}

function parseChainIdValue(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.startsWith("0x")) return Number.parseInt(value.slice(2), 16);
  return Number(value);
}

function assertEvmApproval(approval: Approval): asserts approval is EvmApproval {
  if (approval.type !== "eip1193_request") {
    throw new VexError(
      ErrorCodes.KHALANI_DEPOSIT_FAILED,
      `Unexpected approval type ${approval.type}; expected eip1193_request.`,
    );
  }
}

function isNativeTransferToken(token: string): boolean {
  const normalized = token.trim().toLowerCase();
  return normalized === "native"
    || normalized === "0x0000000000000000000000000000000000000000"
    || normalized === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
}

// ── Staged leg model ──────────────────────────────────────────────────

export type KhalaniLegRole = "allowance_reset" | "allowance" | "bridge_deposit";

/** The three staged outcomes — mirrors the EVM `signStageBroadcast` contract. */
export type KhalaniStagedOutcome =
  | { readonly kind: "confirmed"; readonly txHash: string }
  | { readonly kind: "reverted"; readonly txHash: string }
  | { readonly kind: "ambiguous"; readonly txHash: string; readonly stage: "send" | "confirm" };

/** Persisted BEFORE broadcast — `nonce` is a number for EVM, `null` for Solana (B1 nonce matrix). */
export interface KhalaniStageHandles {
  readonly txHash: string;
  readonly fromAddress: string;
  readonly nonce: number | null;
}

export interface KhalaniStageHooks {
  /** Persist the computed hash/signature (`markActivityBroadcast`) — a throw aborts BEFORE any broadcast. */
  readonly onHashStaged: (handles: KhalaniStageHandles) => Promise<void>;
  /** Bookkeeping after the RPC accepts the submission (`markBroadcastAccepted`) — a throw here does NOT roll back. */
  readonly onAccepted: () => Promise<void>;
}

interface NormalizedEvmTx {
  readonly to: Address;
  readonly data?: Hex;
  readonly value?: bigint;
  /** Khalani's gas/nonce hints are honored; fees are left to viem's estimator (parity with the swap staged path). */
  readonly gas?: bigint;
  readonly nonce?: number;
  /** If Khalani declared a sender, it MUST equal the signing wallet (fail-closed). */
  readonly expectedFrom?: Address;
}

/** One planned Vex-signed broadcast leg derived (no signing) from a `DepositPlan`. */
export type KhalaniStagedLeg =
  | { readonly role: KhalaniLegRole; readonly family: "eip155"; readonly isDeposit: boolean; readonly kind: "evm"; readonly tx: NormalizedEvmTx }
  | { readonly role: KhalaniLegRole; readonly family: "solana"; readonly isDeposit: boolean; readonly kind: "solana"; readonly base64Tx: string };

const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Classify a NON-deposit EVM approval by decoding its calldata: an
 * `approve(spender, 0)` is an allowance RESET, any other `approve` (or an
 * undecodable call) is an allowance GRANT. Both are valid bridge leg roles — a
 * mis-decode fails safe to `allowance`.
 */
function classifyEvmApprovalRole(data: string | undefined): KhalaniLegRole {
  if (!data || !data.startsWith("0x")) return "allowance";
  try {
    const decoded = decodeFunctionData({ abi: APPROVE_ABI, data: data as Hex });
    if (decoded.functionName === "approve" && decoded.args[1] === 0n) {
      return "allowance_reset";
    }
  } catch {
    // Not a recognizable approve — record it as a generic allowance leg.
  }
  return "allowance";
}

function normalizeEvmApproval(approval: EvmApproval, chain: KhalaniChain): NormalizedEvmTx | null {
  if (approval.request.method === "wallet_switchEthereumChain") {
    const requestedChainId = parseChainIdValue(
      Array.isArray(approval.request.params)
        ? (approval.request.params[0] as { chainId?: unknown } | undefined)?.chainId
        : undefined,
    );
    if (requestedChainId != null && requestedChainId !== chain.id) {
      throw new VexError(
        ErrorCodes.CHAIN_MISMATCH,
        `Khalani requested chain switch to ${requestedChainId}, but the selected route uses ${chain.id}.`,
      );
    }
    // A client-side chain switch is not a broadcast — no staged leg.
    return null;
  }
  if (approval.request.method !== "eth_sendTransaction") {
    throw new VexError(
      ErrorCodes.KHALANI_DEPOSIT_FAILED,
      `Unsupported EVM approval method: ${approval.request.method}`,
    );
  }
  const txRequest = Array.isArray(approval.request.params)
    ? approval.request.params[0] as Eip1193TransactionRequest | undefined
    : undefined;
  if (!txRequest?.to) {
    throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "Khalani did not provide an EVM transaction target.");
  }
  return {
    to: getAddress(txRequest.to),
    ...(txRequest.data ? { data: txRequest.data as Hex } : {}),
    ...(txRequest.value ? { value: parseBigintish(txRequest.value, "tx.value") } : {}),
    ...(txRequest.gas ? { gas: parseBigintish(txRequest.gas, "tx.gas") } : {}),
    ...(txRequest.nonce !== undefined ? { nonce: parseNumberish(txRequest.nonce, "tx.nonce") } : {}),
    ...(txRequest.from ? { expectedFrom: getAddress(txRequest.from) } : {}),
  };
}

function planContractCallLegs(plan: ContractCallDepositPlan, chain: KhalaniChain): KhalaniStagedLeg[] {
  const family: ChainFamily = chain.type;
  const legs: KhalaniStagedLeg[] = [];
  for (const approval of plan.approvals) {
    if (family === "solana") {
      const solanaApproval = approval as SolanaApproval;
      if (solanaApproval.type !== "solana_sendTransaction") {
        throw new VexError(
          ErrorCodes.KHALANI_DEPOSIT_FAILED,
          `Unexpected approval type ${approval.type}; expected solana_sendTransaction.`,
        );
      }
      legs.push({
        role: solanaApproval.deposit ? "bridge_deposit" : "allowance",
        family: "solana",
        isDeposit: solanaApproval.deposit === true,
        kind: "solana",
        base64Tx: solanaApproval.transaction,
      });
      continue;
    }
    assertEvmApproval(approval);
    const tx = normalizeEvmApproval(approval, chain);
    if (tx === null) continue; // chain-switch — not a broadcast
    legs.push({
      role: approval.deposit ? "bridge_deposit" : classifyEvmApprovalRole(tx.data),
      family: "eip155",
      isDeposit: approval.deposit === true,
      kind: "evm",
      tx,
    });
  }
  return legs;
}

function planTransferLeg(plan: TransferDepositPlan, chain: KhalaniChain): KhalaniStagedLeg[] {
  if (chain.type !== "eip155") {
    throw new VexError(
      ErrorCodes.KHALANI_DEPOSIT_FAILED,
      "Solana TRANSFER deposits are not implemented.",
      "Retry with --deposit-method CONTRACT_CALL.",
    );
  }
  const tx: NormalizedEvmTx = isNativeTransferToken(plan.token)
    ? { to: getAddress(plan.depositAddress), value: BigInt(plan.amount) }
    : {
        to: getAddress(plan.token),
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [getAddress(plan.depositAddress), BigInt(plan.amount)],
        }),
      };
  return [{ role: "bridge_deposit", family: "eip155", isDeposit: true, kind: "evm", tx }];
}

/**
 * Convert a `DepositPlan` into the ordered Vex-signed broadcast legs, WITHOUT
 * signing. PERMIT2 is intentionally blocked; the plan MUST contain exactly one
 * `deposit` leg (the hash the caller later submits to Khalani).
 */
export function planKhalaniDepositLegs(plan: DepositPlan, sourceChain: KhalaniChain): KhalaniStagedLeg[] {
  if (plan.kind === "PERMIT2") {
    throw new VexError(
      ErrorCodes.KHALANI_PERMIT2_BLOCKED,
      "PERMIT2 live execution is intentionally blocked.",
      "Use dryRun to inspect the permit payload or retry with --deposit-method CONTRACT_CALL.",
    );
  }
  const legs = plan.kind === "TRANSFER"
    ? planTransferLeg(plan, sourceChain)
    : planContractCallLegs(plan, sourceChain);

  const depositCount = legs.filter((leg) => leg.isDeposit).length;
  if (depositCount === 0) {
    throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "Khalani did not mark any action with deposit=true.");
  }
  if (depositCount > 1) {
    throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "Khalani marked more than one action with deposit=true.");
  }
  return legs;
}

// ── Staged per-leg signing ─────────────────────────────────────────────

async function signStageEvmLeg(
  tx: NormalizedEvmTx,
  chain: KhalaniChain,
  chains: KhalaniChain[],
  privateKey: Hex,
  hooks: KhalaniStageHooks,
): Promise<KhalaniStagedOutcome> {
  const walletClient = createDynamicWalletClient(chain, chains, privateKey);
  const publicClient = createDynamicPublicClient(chain, chains);
  const account = walletClient.account;

  if (tx.expectedFrom && getAddress(account.address) !== tx.expectedFrom) {
    throw new VexError(
      ErrorCodes.KHALANI_ADDRESS_MISMATCH,
      `Approval sender ${tx.expectedFrom} does not match the configured EVM wallet.`,
    );
  }

  const request = await walletClient.prepareTransactionRequest({
    account,
    chain: walletClient.chain,
    to: tx.to,
    ...(tx.data ? { data: tx.data } : {}),
    value: tx.value ?? 0n,
    ...(tx.gas !== undefined ? { gas: tx.gas } : {}),
    ...(tx.nonce !== undefined ? { nonce: tx.nonce } : {}),
  });
  const serializedTransaction = await walletClient.signTransaction(request);
  const txHash = keccak256(serializedTransaction);
  const nonce = request.nonce;
  if (nonce === undefined) {
    throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "Prepared Khalani transaction has no nonce.");
  }

  await hooks.onHashStaged({ txHash, fromAddress: account.address, nonce });

  try {
    await publicClient.sendRawTransaction({ serializedTransaction });
  } catch {
    return { kind: "ambiguous", txHash, stage: "send" };
  }

  try {
    await hooks.onAccepted();
  } catch {
    // Best-effort bookkeeping — the transaction is already in flight.
  }

  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    return receipt.status === "success"
      ? { kind: "confirmed", txHash }
      : { kind: "reverted", txHash };
  } catch {
    return { kind: "ambiguous", txHash, stage: "confirm" };
  }
}

async function signStageSolanaLeg(
  base64Tx: string,
  chain: KhalaniChain,
  chains: KhalaniChain[],
  signer: Extract<ChainWallet, { family: "solana" }>,
  hooks: KhalaniStageHooks,
): Promise<KhalaniStagedOutcome> {
  const rpcUrl = getChainRpcUrl(chain.id, chains);
  // Signature (base58) is derived from the SIGNED transaction — available BEFORE
  // broadcast, so it stages exactly like the EVM hash. Khalani's `txHash` field
  // carries this Solana signature by API contract; the row's chain_family is
  // 'solana' and its nonce stays NULL (B1).
  const { signedBase64, signature } = signSolanaTransactionWithSignature(signer.secretKey, base64Tx);

  await hooks.onHashStaged({ txHash: signature, fromAddress: signer.address, nonce: null });

  try {
    await broadcastSignedSolanaTransaction(rpcUrl, signedBase64);
  } catch {
    return { kind: "ambiguous", txHash: signature, stage: "send" };
  }

  try {
    await hooks.onAccepted();
  } catch {
    // Best-effort bookkeeping — the transaction is already in flight.
  }

  try {
    const confirmation = await confirmSolanaSignature(rpcUrl, signature);
    // Mirror the EVM receipt mapping: a mined-but-failed transaction (non-null
    // `value.err`, surfaced as `reverted`) is a revert, never a confirmed deposit.
    return confirmation.status === "reverted"
      ? { kind: "reverted", txHash: signature }
      : { kind: "confirmed", txHash: signature };
  } catch {
    return { kind: "ambiguous", txHash: signature, stage: "confirm" };
  }
}

/**
 * Sign, stage (via `hooks.onHashStaged`), broadcast, and await a bounded receipt
 * for ONE planned leg. The leg's family selects the signer path; the caller's
 * `signer` MUST match that family (fail-closed otherwise).
 */
export async function signStageKhalaniLeg(
  leg: KhalaniStagedLeg,
  sourceChain: KhalaniChain,
  chains: KhalaniChain[],
  signer: ChainWallet,
  hooks: KhalaniStageHooks,
): Promise<KhalaniStagedOutcome> {
  if (leg.kind === "evm") {
    if (signer.family !== "eip155") {
      throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "EVM deposit requires an EVM signing wallet.");
    }
    return signStageEvmLeg(leg.tx, sourceChain, chains, signer.privateKey, hooks);
  }
  if (signer.family !== "solana") {
    throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "Solana deposit requires a Solana signing wallet.");
  }
  return signStageSolanaLeg(leg.base64Tx, sourceChain, chains, signer, hooks);
}
