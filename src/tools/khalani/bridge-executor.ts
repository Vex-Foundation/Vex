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
 *
 * VEX FEE LEG (`src/tools/bridge-fee`): when a fee is charged, the plan gains
 * ONE extra leg APPENDED AFTER the deposit — Vex's own transfer of 25 bps of
 * the input token to the treasury. It is last on purpose: the deposit is
 * quoted and broadcast for `amount − fee`, so a bridge that never happens
 * never charges a fee. The Solana variant is planned as a DESCRIPTOR
 * (`kind:"solana_fee"`) because building it needs the mint's owner program and
 * the treasury ATA's existence — both network reads — and this planner is
 * network-free; `signStageKhalaniLeg` materializes it against the same
 * per-chain RPC it already signs and broadcasts on.
 *
 * SOLANA LEG (W5 design `w5-design.md` §2/R2/R2b, migration 049): Khalani's
 * provider-built Solana transaction carries no separate blockhash-height
 * evidence (no `blockhashWithMetadata`-style field, unlike Jupiter `/build`),
 * so it follows the same MANDATORY-HEIGHT/REPLACE doctrine K2 built for
 * Jupiter lend/prediction: `prepareVersionedTx` (the shared
 * `src/tools/solana-ecosystem/shared/solana-transaction` primitive) enforces
 * the STRICT sole-signer check, fetches a FRESH `{blockhash,
 * lastValidBlockHeight}` pair from Khalani's own already-trusted per-chain RPC
 * (`getChainRpcUrl` — the same endpoint this module already uses to broadcast
 * and confirm), and bakes it into the transaction BEFORE signing. Both values
 * are surfaced through `onHashStaged` alongside the signature so the caller
 * can persist them via `markActivitySolanaBroadcast`'s evidence-carrying CAS.
 */

import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { Connection, Keypair } from "@solana/web3.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { ERC20_ABI } from "../../constants/chain.js";
import { getChainRpcUrl } from "./chains.js";
import { gasLimitForProviderHintedCall } from "@tools/evm-chains/gas-limit-headroom.js";
import {
  estimateGasForPlanLeg,
  priorLegAnchorFrom,
  type ConfirmedPriorLeg,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { createDynamicPublicClient, createDynamicWalletClient } from "./evm-client.js";
import { broadcastSignedSolanaTransaction, confirmSolanaSignature } from "./solana-signer.js";
import { prepareVersionedTx } from "@tools/solana-ecosystem/shared/solana-transaction.js";
import {
  BRIDGE_FEE_ACTIVITY_EVENT_ROLE,
  buildEvmBridgeFeeTransfer,
  buildSolanaBridgeFeeTransfer,
} from "@tools/bridge-fee/index.js";
import {
  checkNativeValueAuthorizedForCall,
  classifyNativeValue,
  type NativeValueAuthorization,
  type ProvenComponent,
} from "@tools/evm-chains/native-value-authorization/index.js";
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

export type KhalaniLegRole = "allowance_reset" | "allowance" | "bridge_deposit" | "bridge_fee";

/**
 * WHY the leg carries a purpose separate from its role: before migration 050
 * the Vex fee leg was recorded under the `allowance` `event_role`, so the role
 * alone could not tell a real approval apart from the fee transfer. The
 * dedicated `bridge_fee` role now can, but callers still branch on this
 * purpose — it is the one discriminator that also covers the Solana fee leg
 * while it is still an unbuilt descriptor (`kind: "solana_fee"`), before any
 * role-bearing row exists. Collapsing the two is a follow-up cleanup, not part
 * of the 050 change.
 */
export type KhalaniLegPurpose = "bridge" | "vex_fee";

/**
 * The three staged outcomes — mirrors the EVM `signStageBroadcast` contract.
 *
 * `settledAtBlock` is the confirmed EVM leg's receipt block, which the caller
 * threads into the NEXT leg as its read-after-write anchor
 * (`dependent-leg-gas-estimate.ts`). `null` for Solana legs, mirroring the
 * `nonce: null` discriminant `KhalaniStageHandles` already uses for that
 * family — a Solana plan has no EVM block to anchor on.
 */
export type KhalaniStagedOutcome =
  | { readonly kind: "confirmed"; readonly txHash: string; readonly settledAtBlock: bigint | null }
  | { readonly kind: "reverted"; readonly txHash: string }
  | { readonly kind: "ambiguous"; readonly txHash: string; readonly stage: "send" | "confirm" };

/**
 * Persisted BEFORE broadcast — `nonce` is a number for EVM, `null` for Solana
 * (B1 nonce matrix). A `null` nonce always carries the fresh Solana blockhash
 * evidence `markActivitySolanaBroadcast` requires (W5 §2/R2b): the discriminant
 * on `nonce` mirrors the check every caller already performs
 * (`h.nonce === null`), so the evidence fields narrow in automatically instead
 * of needing a separate tag.
 */
export type KhalaniStageHandles =
  | { readonly txHash: string; readonly fromAddress: string; readonly nonce: number }
  | {
      readonly txHash: string;
      readonly fromAddress: string;
      readonly nonce: null;
      readonly recentBlockhash: string;
      readonly lastValidBlockHeight: number;
    };

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
  /**
   * Khalani's gas figure is a HINT that can only RAISE the signed limit, never
   * lower it below our own headroomed estimate (`gasLimitForProviderHintedCall`).
   * The nonce hint is honored as-is; fees are left to viem's estimator (parity
   * with the swap staged path).
   */
  readonly gas?: bigint;
  readonly nonce?: number;
  /** If Khalani declared a sender, it MUST equal the signing wallet (fail-closed). */
  readonly expectedFrom?: Address;
}

/**
 * One planned Vex-signed broadcast leg derived (no signing) from a
 * `DepositPlan`.
 *
 * `nativeValue` is REQUIRED on every EVM leg and is the authorization for that
 * leg's `tx.value`: `signStageEvmLeg` re-checks it against the transaction it
 * is about to serialize and refuses on any mismatch, so a leg cannot reach the
 * signer without one. The planner is network-free, so a PROVIDER-supplied value
 * starts out `unclassified` — `authorizeKhalaniLegNativeValue`
 * (`./deposit-native-value.ts`) is what upgrades it with a proof, and a leg
 * that is never upgraded is refused rather than signed.
 */
export type KhalaniStagedLeg =
  | {
      readonly role: KhalaniLegRole;
      readonly purpose: KhalaniLegPurpose;
      readonly family: "eip155";
      readonly isDeposit: boolean;
      readonly kind: "evm";
      readonly tx: NormalizedEvmTx;
      readonly nativeValue: NativeValueAuthorization;
    }
  | { readonly role: KhalaniLegRole; readonly purpose: KhalaniLegPurpose; readonly family: "solana"; readonly isDeposit: boolean; readonly kind: "solana"; readonly base64Tx: string }
  /**
   * The Solana Vex fee leg, still unbuilt: materialized inside
   * `signStageKhalaniLeg` (see the module doc) because it needs the mint's
   * owner program and the treasury ATA's existence, and this planner is
   * network-free.
   */
  | {
      readonly role: KhalaniLegRole;
      readonly purpose: "vex_fee";
      readonly family: "solana";
      readonly isDeposit: false;
      readonly kind: "solana_fee";
      readonly mint: string;
      readonly feeRaw: bigint;
    };

/** The Vex integrator fee to append as the FINAL leg. `feeRaw` must be positive. */
export interface KhalaniVexFeeLeg {
  /** The source-chain token/mint the user is bridging — the fee is taken from it. */
  readonly tokenAddress: string;
  readonly feeRaw: bigint;
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

/**
 * The call an EVM leg's native-value authorization covers. Kept in ONE place so
 * the tuple the planner classifies and the tuple `signStageEvmLeg` re-checks
 * can never drift apart — a fingerprint computed over two different shapes
 * would refuse every honest leg.
 */
export function khalaniLegNativeValueCall(chainId: number, tx: NormalizedEvmTx) {
  return { chainId, to: tx.to, data: tx.data, valueWei: tx.value ?? 0n } as const;
}

/**
 * Classify an EVM leg's `tx.value` with only what the planner can prove
 * offline. A provider-supplied value gets no Vex-derived component, so it lands
 * in the unclassified remainder and stays refused until a prover upgrades it.
 */
function planLegNativeValue(
  chainId: number,
  tx: NormalizedEvmTx,
  vexDerived?: { readonly nativePrincipal?: ProvenComponent; readonly platformFee?: ProvenComponent },
): NativeValueAuthorization {
  return classifyNativeValue({
    call: khalaniLegNativeValueCall(chainId, tx),
    nativePrincipal: vexDerived?.nativePrincipal,
    vexPlatformFee: vexDerived?.platformFee,
    provenProtocolFee: null,
  });
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
        purpose: "bridge",
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
      purpose: "bridge",
      family: "eip155",
      isDeposit: approval.deposit === true,
      kind: "evm",
      tx,
      // Provider-supplied value — nothing is proven offline. A non-zero value
      // is unclassified here BY DESIGN and must be upgraded by a prover before
      // it can be signed.
      nativeValue: planLegNativeValue(chain.id, tx),
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
  const isNative = isNativeTransferToken(plan.token);
  const tx: NormalizedEvmTx = isNative
    ? { to: getAddress(plan.depositAddress), value: BigInt(plan.amount) }
    : {
        to: getAddress(plan.token),
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [getAddress(plan.depositAddress), BigInt(plan.amount)],
        }),
      };
  // A native TRANSFER deposit is fully proven right here: Vex builds the whole
  // transaction, and its entire value IS the principal being bridged. This is
  // also why the fixed-fee rule must be `value − principal == fee` — a
  // `value == fee` rule would refuse this legitimate leg outright.
  const nativeValue = planLegNativeValue(
    chain.id,
    tx,
    isNative
      ? {
          nativePrincipal: {
            amountWei: BigInt(plan.amount),
            recipient: getAddress(plan.depositAddress),
            refund: "refunded_to_source_on_failure",
            evidence: {
              source: "vex_constructed",
              detail: "the whole value is the deposit amount of a Vex-built native TRANSFER leg",
            },
          },
        }
      : undefined,
  );
  return [{
    role: "bridge_deposit", purpose: "bridge", family: "eip155",
    isDeposit: true, kind: "evm", tx, nativeValue,
  }];
}

/**
 * Plan the Vex fee leg for `sourceChain`'s family. EVM is fully built here
 * (pure); Solana is a descriptor materialized at sign time (module doc).
 */
function planVexFeeLeg(fee: KhalaniVexFeeLeg, sourceChain: KhalaniChain): KhalaniStagedLeg {
  if (sourceChain.type === "solana") {
    return {
      role: BRIDGE_FEE_ACTIVITY_EVENT_ROLE,
      purpose: "vex_fee",
      family: "solana",
      isDeposit: false,
      kind: "solana_fee",
      mint: fee.tokenAddress,
      feeRaw: fee.feeRaw,
    };
  }
  const transfer = buildEvmBridgeFeeTransfer(fee.tokenAddress, fee.feeRaw);
  const tx: NormalizedEvmTx = transfer.kind === "native"
    ? { to: transfer.to, value: transfer.value }
    : { to: transfer.to, data: transfer.data };
  // Vex's own transfer: on the native branch the entire value is the Vex
  // platform fee, computed by `splitBridgeAmountForFee` from the user's own
  // amount. The ERC-20 branch sends no value at all.
  const nativeValue = planLegNativeValue(
    sourceChain.id,
    tx,
    transfer.kind === "native"
      ? {
          platformFee: {
            amountWei: transfer.value,
            recipient: transfer.to,
            refund: "spent_not_recoverable",
            evidence: {
              source: "vex_constructed",
              detail: "the whole value is the Vex integrator fee of a Vex-built native transfer leg",
            },
          },
        }
      : undefined,
  );
  return {
    role: BRIDGE_FEE_ACTIVITY_EVENT_ROLE,
    purpose: "vex_fee",
    family: "eip155",
    isDeposit: false,
    kind: "evm",
    tx,
    nativeValue,
  };
}

/**
 * Convert a `DepositPlan` into the ordered Vex-signed broadcast legs, WITHOUT
 * signing. PERMIT2 is intentionally blocked; the plan MUST contain exactly one
 * `deposit` leg (the hash the caller later submits to Khalani).
 *
 * `vexFee`, when present, is APPENDED as the final leg — see the module doc for
 * why it must run after the deposit and never before it. Pass `null` (or omit)
 * when the fee floors to zero: a zero-value transfer would burn gas and move
 * nothing.
 */
export function planKhalaniDepositLegs(
  plan: DepositPlan,
  sourceChain: KhalaniChain,
  vexFee: KhalaniVexFeeLeg | null = null,
): KhalaniStagedLeg[] {
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
  if (vexFee && vexFee.feeRaw > 0n) {
    legs.push(planVexFeeLeg(vexFee, sourceChain));
  }
  return legs;
}

// ── Staged per-leg signing ─────────────────────────────────────────────

async function signStageEvmLeg(
  tx: NormalizedEvmTx,
  nativeValue: NativeValueAuthorization,
  chain: KhalaniChain,
  chains: KhalaniChain[],
  privateKey: Hex,
  hooks: KhalaniStageHooks,
  priorLeg: ConfirmedPriorLeg | undefined,
): Promise<KhalaniStagedOutcome> {
  // THE LAST GATE. Re-validated here, against the exact transaction about to be
  // serialized, rather than trusted from plan time: the authorization is bound
  // to a `(chain, to, calldata, value)` fingerprint, so a value that grew — or
  // a target that changed — after classification cannot be signed. A leg whose
  // native charge was never proven fails here too, which is what makes
  // "never sign a value you could not classify" a property of the signer and
  // not a convention callers have to remember.
  const authorized = checkNativeValueAuthorizedForCall(
    nativeValue,
    khalaniLegNativeValueCall(chain.id, tx),
  );
  if (!authorized.ok) {
    throw new VexError(
      ErrorCodes.NATIVE_VALUE_UNAUTHORIZED,
      `Refused before signing: ${authorized.reason}.`,
      "Nothing was signed. Re-quote the bridge; do not retry this deposit plan.",
    );
  }

  const walletClient = createDynamicWalletClient(chain, chains, privateKey);
  const publicClient = createDynamicPublicClient(chain, chains);
  const account = walletClient.account;

  if (tx.expectedFrom && getAddress(account.address) !== tx.expectedFrom) {
    throw new VexError(
      ErrorCodes.KHALANI_ADDRESS_MISMATCH,
      `Approval sender ${tx.expectedFrom} does not match the configured EVM wallet.`,
    );
  }

  // Estimated explicitly for EVERY leg (allowance AND bridge deposit) rather
  // than signing either Khalani's `tx.gas` verbatim or viem's bare estimate —
  // both are the out-of-gas defect `gasLimitWithHeadroom` documents. Same call
  // shape as the signed transaction (`value` included), so a leg that can no
  // longer execute still throws HERE, before anything is signed, staged, or
  // broadcast, and the raw error reaches the handler's classifier unchanged.
  // `priorLeg` (the approval leg this plan just confirmed) additionally lets
  // the estimate survive a node that has not applied that approval yet —
  // bounded, and never at the cost of signing an unestimated leg
  // (`dependent-leg-gas-estimate.ts`).
  const gasEstimate = await estimateGasForPlanLeg(
    publicClient,
    {
      account,
      to: tx.to,
      ...(tx.data ? { data: tx.data } : {}),
      value: tx.value ?? 0n,
    },
    priorLeg,
  );
  const gasLimit = gasLimitForProviderHintedCall(gasEstimate, tx.gas);

  const request = await walletClient.prepareTransactionRequest({
    account,
    chain: walletClient.chain,
    to: tx.to,
    ...(tx.data ? { data: tx.data } : {}),
    value: tx.value ?? 0n,
    gas: gasLimit,
    ...(tx.nonce !== undefined ? { nonce: tx.nonce } : {}),
  });
  // Re-asserted on the request that is actually serialized: when fees/nonce
  // still need filling, viem may route preparation through the node's
  // `wallet_fillTransaction`, whose reply overwrites `gas` with the node's own
  // unbuffered figure. The signed bytes are what the chain enforces, so the
  // limit has to survive to exactly here.
  const serializedTransaction = await walletClient.signTransaction({ ...request, gas: gasLimit });
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
    // Same validator the estimator uses, so a receipt without a usable block
    // number degrades to "no anchor" rather than to a bad one.
    const settledAtBlock = priorLegAnchorFrom(receipt.blockNumber)?.blockNumber ?? null;
    return receipt.status === "success"
      ? { kind: "confirmed", txHash, settledAtBlock }
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
  // Sole-signer check + fresh-blockhash REPLACE (module doc) — refuses a
  // transaction that is not exactly sole-signed by `signer`, then signs over a
  // FRESH blockhash fetched from Khalani's own per-chain RPC. The derived
  // signature (base58) is available BEFORE broadcast, so it stages exactly
  // like the EVM hash. Khalani's `txHash` field carries this Solana signature
  // by API contract; the row's chain_family is 'solana' and its nonce stays
  // NULL (B1) — now paired with the blockhash evidence W5 §2/R2b requires.
  const prepared = await prepareVersionedTx(base64Tx, Keypair.fromSecretKey(signer.secretKey), {
    connection: new Connection(rpcUrl, "confirmed"),
  });
  const signedBase64 = Buffer.from(prepared.serialized).toString("base64");
  const signature = prepared.signature;

  await hooks.onHashStaged({
    txHash: signature,
    fromAddress: signer.address,
    nonce: null,
    recentBlockhash: prepared.recentBlockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  });

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
      : { kind: "confirmed", txHash: signature, settledAtBlock: null };
  } catch {
    return { kind: "ambiguous", txHash: signature, stage: "confirm" };
  }
}

/**
 * Sign, stage (via `hooks.onHashStaged`), broadcast, and await a bounded receipt
 * for ONE planned leg. The leg's family selects the signer path; the caller's
 * `signer` MUST match that family (fail-closed otherwise).
 *
 * `priorLeg` is the `settledAtBlock` anchor of the leg this plan confirmed
 * immediately before (the allowance leg). It only affects gas ESTIMATION for
 * EVM legs — see `signStageEvmLeg`.
 */
export async function signStageKhalaniLeg(
  leg: KhalaniStagedLeg,
  sourceChain: KhalaniChain,
  chains: KhalaniChain[],
  signer: ChainWallet,
  hooks: KhalaniStageHooks,
  priorLeg?: ConfirmedPriorLeg,
): Promise<KhalaniStagedOutcome> {
  if (leg.kind === "evm") {
    if (signer.family !== "eip155") {
      throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "EVM deposit requires an EVM signing wallet.");
    }
    return signStageEvmLeg(leg.tx, leg.nativeValue, sourceChain, chains, signer.privateKey, hooks, priorLeg);
  }
  if (signer.family !== "solana") {
    throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "Solana deposit requires a Solana signing wallet.");
  }
  if (leg.kind === "solana_fee") {
    // Materialized here, not in the planner: resolving the mint's owner
    // program and the treasury ATA's existence are network reads, and the
    // planner is network-free. The RPC is the same per-chain endpoint this
    // module already signs and broadcasts on.
    const fee = await buildSolanaBridgeFeeTransfer({
      connection: new Connection(getChainRpcUrl(sourceChain.id, chains), "confirmed"),
      mint: leg.mint,
      feeRaw: leg.feeRaw,
      owner: signer.address,
    });
    return signStageSolanaLeg(fee.base64Tx, sourceChain, chains, signer, hooks);
  }
  return signStageSolanaLeg(leg.base64Tx, sourceChain, chains, signer, hooks);
}
