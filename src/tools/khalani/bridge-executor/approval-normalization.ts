/**
 * Turning Khalani's untrusted `approvals` wire shape into the normalized EVM
 * transaction the planner and the signer work with.
 *
 * Everything here is PURE and network-free — parsing, classification, and
 * fail-closed validation of provider-supplied fields. It owns the one job of
 * "what did the provider actually say", so the planner (`./deposit-plan.ts`)
 * can stay about leg ORDER and roles, and the signer (`./leg-signing.ts`) can
 * stay about signing discipline.
 *
 * Unit-covered by `src/__tests__/khalani/khalani-bridge-executor.test.ts`.
 */

import { decodeFunctionData, getAddress, type Hex } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { isKhalaniNativeAlias } from "../native-token-identity.js";
import type { Approval, EvmApproval, KhalaniChain } from "../types.js";
import type { KhalaniLegRole, NormalizedEvmTx } from "./staged-leg.js";

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

export function assertEvmApproval(approval: Approval): asserts approval is EvmApproval {
  if (approval.type !== "eip1193_request") {
    throw new VexError(
      ErrorCodes.KHALANI_DEPOSIT_FAILED,
      `Unexpected approval type ${approval.type}; expected eip1193_request.`,
    );
  }
}

/**
 * Native-asset classification for the deposit path. The alias set itself lives
 * in the dependency-free leaf `../native-token-identity.ts` so the background
 * bridge-repair sweep can share it without pulling viem and this module's error
 * machinery into its graph; this stays the deposit path's named entry point.
 */
export function isNativeTransferToken(token: string): boolean {
  return isKhalaniNativeAlias(token);
}

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
export function classifyEvmApprovalRole(data: string | undefined): KhalaniLegRole {
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

export function normalizeEvmApproval(approval: EvmApproval, chain: KhalaniChain): NormalizedEvmTx | null {
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
