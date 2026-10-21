/**
 * THE SHARED DEPOSIT CORE: the reads that prepare a Vex Inference deposit and
 * the ONE signing path that sends it, used by every deposit authority:
 *
 * - the funding page form (`deposit.ts`, "the form is the approval");
 * - the agent deposit tool pair (`agent-deposit.ts`), under an approval card,
 *   a full-permission session, or an active auto top-up rule;
 * - the auto top-up poller (`../auto-top-up/executor.ts`).
 *
 * A caller chooses the AUTHORITY and supplies its own extra checks; it never
 * chooses the destination, the token, the chain or the bounds below. Those
 * are fixed here, so no caller can weaken them:
 *
 * | Field | Bound in {@link planDeposit} | Re-checked in the pre-sign gate (before the key exists) | Re-checked in the final check (after the key, last await before the signature) |
 * |---|---|---|---|
 * | chain | 4663 (the transfer port's client) | the signed request is prepared for 4663 | n/a (no network call) |
 * | token | VEX, 18 decimals | the signed `to` is the VEX contract, `value` 0 | n/a |
 * | amount (wei) | the caller's figure | the signed calldata encodes it; the wallet's pending VEX covers it; still at least the backend minimum at its CURRENT rate | n/a |
 * | from | an inventory wallet LINKED to the signed-in account | still in the inventory; still linked (fresh account read) | still in the inventory; linked verdict of the gate |
 * | to | the pinned address, equal to the backend's `deposit_address` | pin re-resolved; backend re-read; calldata encodes it | pin re-resolved |
 * | fee bound | from a fresh estimate | `signStageBroadcast` refuses a request above it; ETH covers the exposure | n/a |
 * | expiry | the caller's | re-checked | re-checked |
 * | vault, execution gate | | both | both |
 * | caller authority | | `extraGate` | `extraFinal` |
 *
 * ONE DEPOSIT PER WALLET AT A TIME. {@link withWalletReservation} is the
 * single flight shared by every caller: the form, the agent and the poller
 * cannot sign two deposits from one wallet concurrently.
 *
 * OUTCOMES. A throw before the send means nothing was broadcast
 * (`signStageBroadcast` contract): a refusal. After the send: a successful
 * receipt is `confirmed` (the Transfer log is proven with the agent send
 * tool's own `proveErc20Transfer`), a reverted one `reverted`, and anything
 * unknown stays `pending`: never re-sent, never reported failed. Vex
 * Inference is told about the hash (`/v1/deposits/notify`, a hint only).
 */

import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import type { VexError } from "@shared/ipc/result.js";
import type { VexCloudSubmitDepositResult } from "@shared/schemas/vex-cloud-funding.js";
import {
  formatMicroUsd,
  formatVexExact,
  microUsdToWeiCeil,
  parseRateX18,
  VEX_TOKEN_ADDRESS,
  weiToMicroUsdFloor,
} from "@shared/vex-cloud-money.js";
import type { WalletInventoryEntry } from "@vex-lib/wallet.js";
import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import type {
  FinalSignedRequest,
  StagedBroadcastOutcome,
  StagedFeeExposureLimit,
} from "@tools/evm-chains/staged-broadcast.js";
import type { Erc20TransferPort } from "@tools/evm-chains/erc20-transfer-port.js";
import { proveErc20Transfer } from "@vex-agent/tools/internal/wallet/send/transfer-settlement.js";
import type { VexCloudAccountResponse, VexCloudApi } from "../api-client.js";
import { refused, type VexCloudOutcome, type VexCloudRefusal } from "../outcome.js";
import { backendRefusal, requireBearer, type SessionPort } from "./backend-call.js";

export interface DepositDeps extends SessionPort {
  readonly api: Pick<VexCloudApi, "readAccount" | "notifyDeposit">;
  readonly chain: () => Erc20TransferPort;
  readonly listEvmWallets: () => readonly WalletInventoryEntry[];
  readonly isVaultUnlocked: () => boolean;
  readonly isExecutionReady: () => boolean;
  /** Re-resolved at prepare AND inside the pre-sign gate AND the final check. */
  readonly pinnedDepositAddress: () => string | null;
  /** Decrypt the entry's key; throws `SIGNER_MISMATCH` when it does not derive the entry's address. */
  readonly loadPrivateKey: (entry: WalletInventoryEntry) => Promise<Hex>;
  readonly now: () => Date;
}

const TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const NOTHING_SIGNED = "Nothing was signed or sent.";

export function transferCalldata(to: Address, amountWei: bigint): Hex {
  return encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [to, amountWei] });
}

export function findWallet(deps: Pick<DepositDeps, "listEvmWallets">, address: string): WalletInventoryEntry | undefined {
  return deps.listEvmWallets().find((entry) => entry.address.toLowerCase() === address.toLowerCase());
}

/** Linked to the signed-in account, per the account's own fresh `wallets`. */
export function isLinkedTo(account: VexCloudAccountResponse, address: string): boolean {
  return account.wallets.some((wallet) => wallet.address.toLowerCase() === address.toLowerCase());
}

export const SENDER_NOT_LINKED_DETAIL =
  "That wallet is not linked to your Vex Inference account, so a deposit from it would not reach your balance. Nothing was signed. Sign in again under Settings, Vex Inference to link it, or pick a linked wallet.";

const RATE_UNAVAILABLE_DETAIL =
  "Vex Inference has no current VEX price, so the $5 minimum cannot be checked. Nothing was signed; try again in a few minutes.";

export interface DepositMinimum {
  readonly rateX18: bigint;
  readonly minimumWei: bigint;
  readonly minimumMicroUsd: bigint;
}

/** The minimum at the account's current rate, or the refusal when no valid rate exists. */
export function minimumOf(account: VexCloudAccountResponse): VexCloudOutcome<DepositMinimum> {
  if (!account.rate.available) return refused("rate_unavailable", RATE_UNAVAILABLE_DETAIL);
  const rateX18 = parseRateX18(account.rate.vex_wei_per_micro_usd);
  if (rateX18 === null) return refused("rate_unavailable", RATE_UNAVAILABLE_DETAIL);
  const minimumMicroUsd = BigInt(account.limits.min_deposit_micro_usd);
  return { ok: true, value: { rateX18, minimumMicroUsd, minimumWei: microUsdToWeiCeil(minimumMicroUsd, rateX18) } };
}

export function pinRefusal(pinned: string | null, backend: string | null): VexCloudOutcome<never> | null {
  if (pinned === null) {
    return refused("deposits_not_open", "Deposits open soon. This version of Vex has no Vex Inference deposit address yet, so nothing can be sent.");
  }
  if (backend === null) {
    // The backend has no custody configured: the same state as an empty pin.
    return refused("deposits_not_open", "Deposits are not open yet: Vex Inference has no deposit address configured. Nothing was sent.");
  }
  if (backend.toLowerCase() !== pinned.toLowerCase()) {
    return refused(
      "deposit_address_mismatch",
      "Funding is disabled: the deposit address built into Vex does not match the one Vex Inference reports. Nothing was sent. Update Vex, and contact support if this stays.",
    );
  }
  return null;
}

/** The fee bound a deposit is approved under: room above a fresh estimate, never an open ceiling. */
export function depositFeeBound(quote: { readonly gasEstimate: bigint; readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }): StagedFeeExposureLimit {
  const gasLimit = (gasLimitWithHeadroom(quote.gasEstimate) * 3n) / 2n;
  const maxFeePerGas = quote.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = quote.maxPriorityFeePerGas * 2n;
  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas, maxNetworkFeeWei: gasLimit * maxFeePerGas };
}

// ── plan ─────────────────────────────────────────────────────────────────

/** Everything a deposit was prepared against; the input to {@link executeDeposit}. */
export interface DepositPlan {
  readonly from: Address;
  readonly to: Address;
  readonly amountWei: bigint;
  readonly feeBound: StagedFeeExposureLimit;
  readonly account: VexCloudAccountResponse;
  readonly minimum: DepositMinimum;
  readonly usdMicroEstimate: bigint;
  readonly walletVexWei: bigint;
  readonly walletNativeWei: bigint;
}

/**
 * Fresh reads for one deposit of `amountWei` from `walletAddress`: the pin,
 * the session, the account (pin equality, linked sender, the minimum at the
 * current rate), the wallet's VEX and ETH and a fee estimate. Signs nothing.
 */
export async function planDeposit(
  deps: DepositDeps,
  input: { readonly walletAddress: string; readonly amountWei: bigint },
  signal: AbortSignal,
  accountRead?: VexCloudAccountResponse,
): Promise<VexCloudOutcome<DepositPlan>> {
  const pinned = deps.pinnedDepositAddress();
  if (pinned === null) return pinRefusal(null, null) ?? refused("deposits_not_open", "Deposits open soon.");
  const entry = findWallet(deps, input.walletAddress);
  if (entry === undefined) {
    return refused("wallet_not_in_inventory", "That wallet is not one of the EVM wallets in this app. Pick a wallet from the list.");
  }
  if (input.amountWei <= 0n) return refused("invalid_amount", "Enter an amount above zero.");

  let account = accountRead;
  if (account === undefined) {
    const bearer = await requireBearer(deps);
    if (!bearer.ok) return bearer;
    const read = await deps.api.readAccount(bearer.value, signal);
    if (!read.ok) return backendRefusal(deps, read.failure);
    account = read.value;
  }
  const mismatch = pinRefusal(pinned, account.deposit_address);
  if (mismatch !== null) return mismatch;
  if (!isLinkedTo(account, entry.address)) return refused("sender_not_linked", SENDER_NOT_LINKED_DETAIL);
  const minimum = minimumOf(account);
  if (!minimum.ok) return minimum;
  if (input.amountWei < minimum.value.minimumWei) {
    return refused(
      "below_minimum",
      `The minimum deposit is ${formatMicroUsd(minimum.value.minimumMicroUsd)}, which is ${formatVexExact(minimum.value.minimumWei)} VEX at the current rate. Enter at least that much.`,
    );
  }

  const from = getAddress(entry.address);
  const to = getAddress(pinned);
  const data = transferCalldata(to, input.amountWei);
  let vexWei: bigint;
  let nativeWei: bigint;
  let quote: { gasEstimate: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  try {
    const chain = deps.chain();
    vexWei = await chain.readVexBalance(from, signal, "pending");
    if (vexWei < input.amountWei) {
      return refused(
        "insufficient_funds",
        `This wallet holds ${formatVexExact(vexWei)} VEX, less than the ${formatVexExact(input.amountWei)} VEX asked for. Use a smaller amount or another wallet.`,
      );
    }
    nativeWei = await chain.readNativeBalance(from);
    quote = await chain.quoteTransferFees(from, data);
  } catch {
    if (signal.aborted) return refused("cancelled", "Cancelled. Nothing was signed.");
    return refused("chain_unavailable", "Robinhood Chain could not be read, so the deposit was not prepared. Nothing was signed; try again in a moment.");
  }
  const feeBound = depositFeeBound(quote);
  const expectedNetworkFee = gasLimitWithHeadroom(quote.gasEstimate) * quote.maxFeePerGas;
  if (nativeWei < expectedNetworkFee) {
    return refused(
      "insufficient_funds",
      "This wallet does not hold enough ETH on Robinhood Chain to pay the network fee. Add a little ETH to it, then try again.",
    );
  }
  return {
    ok: true,
    value: {
      from,
      to,
      amountWei: input.amountWei,
      feeBound,
      account,
      minimum: minimum.value,
      usdMicroEstimate: weiToMicroUsdFloor(input.amountWei, minimum.value.rateX18),
      walletVexWei: vexWei,
      walletNativeWei: nativeWei,
    },
  };
}

// ── single flight ────────────────────────────────────────────────────────

const inFlight = new Set<string>();

/**
 * Run `body` holding the one deposit reservation of `walletAddress`. The
 * reservation is taken synchronously, before the first await, so a second
 * caller (a double click, the poller, the agent) is refused rather than
 * racing.
 */
export async function withWalletReservation<T>(
  walletAddress: string,
  body: () => Promise<VexCloudOutcome<T>>,
): Promise<VexCloudOutcome<T>> {
  const key = walletAddress.toLowerCase();
  if (inFlight.has(key)) {
    return refused("already_running", "A deposit from this wallet is already being sent. Wait for it to finish.");
  }
  inFlight.add(key);
  try {
    return await body();
  } finally {
    inFlight.delete(key);
  }
}

/** Test-only reset so suites cannot leak in-flight marks into each other. */
export function __resetDepositCoreForTests(): void {
  inFlight.clear();
}

// ── execute ──────────────────────────────────────────────────────────────

/** A gate refusal raised inside a `signStageBroadcast` hook; caught right outside it. */
class GateRefusal extends Error {
  constructor(readonly refusal: VexCloudRefusal) {
    super(refusal.detail);
    this.name = "GateRefusal";
  }
}

function gate(kind: VexCloudRefusal["kind"], detail: string, vaultError?: VexError): never {
  throw new GateRefusal({ kind, detail, ...(vaultError !== undefined && { vaultError }) });
}

function classifyPreBroadcastThrow(cause: unknown): VexCloudRefusal {
  if (cause instanceof GateRefusal) return cause.refusal;
  const name = cause instanceof Error ? cause.name : "";
  const code = typeof (cause as { code?: unknown })?.code === "string" ? (cause as { code: string }).code : "";
  if (code === "SIGNER_MISMATCH" || name === "DeferredSignerIdentityError") {
    return {
      kind: "signer_mismatch",
      detail: `The key stored for this wallet does not match its address, so Vex refused to sign. ${NOTHING_SIGNED} Re-import the wallet or restore it from a backup.`,
    };
  }
  if (code === "KEYSTORE_PASSWORD_NOT_SET") {
    return { kind: "vault", detail: `Vex is locked. Unlock Vex, then deposit again. ${NOTHING_SIGNED}` };
  }
  if (name === "EvmNonceOwnerUnavailableError") {
    return {
      kind: "already_running",
      detail: `Another transaction from this wallet is still being signed. ${NOTHING_SIGNED} Try again in a moment.`,
    };
  }
  if (name === "StagedFeeBoundsExceededError" || (cause instanceof Error && cause.message.includes("approved transaction ceiling"))) {
    return {
      kind: "fee_above_bound",
      detail: `The network fee rose above the bound that was approved. ${NOTHING_SIGNED} Review the deposit again to see the new fee.`,
    };
  }
  return {
    kind: "chain_unavailable",
    detail: `The deposit could not be prepared on Robinhood Chain. ${NOTHING_SIGNED} Try again in a moment.`,
  };
}

/** The approved shape {@link executeDeposit} signs: never re-derived from live state. */
export interface ApprovedDeposit {
  readonly from: string;
  readonly to: string;
  readonly amountWei: bigint;
  readonly feeBound: StagedFeeExposureLimit;
  readonly expiresAtMs: number;
}

export interface ExecuteDepositHooks {
  /**
   * The caller's own authority, re-asked in the pre-sign gate (may read
   * durable state; runs before the key exists). `null` = still holds.
   */
  readonly extraGate?: (request: FinalSignedRequest) => Promise<VexCloudRefusal | null>;
  /**
   * The caller's own authority, re-asked in the final check (LOCAL only, no
   * network, no database), given the exact request about to be signed.
   * `null` = still holds.
   */
  readonly extraFinal?: (request: FinalSignedRequest) => VexCloudRefusal | null;
  /** Called once, after every check passed and right before the key is loaded (the `submitted` audit step). */
  readonly onSigning?: () => Promise<void>;
}

/**
 * Sign and send one approved deposit, after re-checking every bound field.
 * The caller holds {@link withWalletReservation} for `approved.from`.
 */
export async function executeDeposit(
  deps: DepositDeps,
  approved: ApprovedDeposit,
  signal: AbortSignal,
  hooks: ExecuteDepositHooks = {},
): Promise<VexCloudOutcome<VexCloudSubmitDepositResult>> {
  if (signal.aborted) return refused("cancelled", `Cancelled. ${NOTHING_SIGNED}`);
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const from = getAddress(approved.from);
  const to = getAddress(approved.to);
  const amountWei = approved.amountWei;
  const data = transferCalldata(to, amountWei);
  const { expiresAtMs, feeBound } = approved;

  let chain: Erc20TransferPort;
  try {
    chain = deps.chain();
  } catch {
    return refused("chain_unavailable", `Robinhood Chain is not reachable from this build. ${NOTHING_SIGNED}`);
  }

  /** Set by the pre-sign gate from its fresh account read; read by the final check, which makes no call. */
  let linkedAtGate = false;

  /** THE GATE before the key. Every bound field is checked again here. */
  const onBeforeSign = async (request: FinalSignedRequest): Promise<void> => {
    if (deps.now().getTime() >= expiresAtMs) gate("proposal_expired", `This deposit approval expired while it was being prepared. ${NOTHING_SIGNED}`);
    if (!deps.isExecutionReady()) gate("execution_not_ready", `Vex is not ready to sign right now. ${NOTHING_SIGNED}`);
    if (!deps.isVaultUnlocked()) gate("vault", `Vex is locked. Unlock Vex, then deposit again. ${NOTHING_SIGNED}`);
    if (findWallet(deps, from) === undefined) gate("wallet_not_in_inventory", `That wallet is no longer in this app. ${NOTHING_SIGNED}`);
    const pinned = deps.pinnedDepositAddress();
    if (pinned === null || pinned.toLowerCase() !== to.toLowerCase()) {
      gate("deposit_address_mismatch", `The deposit address built into Vex changed after the deposit was reviewed. ${NOTHING_SIGNED}`);
    }
    if (
      request.to?.toLowerCase() !== VEX_TOKEN_ADDRESS.toLowerCase()
      || request.value !== 0n
      || request.data?.toLowerCase() !== data.toLowerCase()
    ) {
      gate("proposal_changed", `The transaction about to be signed is not the deposit that was reviewed. ${NOTHING_SIGNED}`);
    }
    const account = await deps.api.readAccount(bearer.value, signal);
    if (!account.ok) {
      const refusal = await backendRefusal<never>(deps, account.failure);
      if (!refusal.ok) throw new GateRefusal(refusal.refusal);
    } else {
      const mismatch = pinRefusal(pinned, account.value.deposit_address);
      if (mismatch !== null && !mismatch.ok) throw new GateRefusal(mismatch.refusal);
      if (!isLinkedTo(account.value, from)) {
        gate("sender_not_linked", `That wallet is no longer linked to your Vex Inference account. ${NOTHING_SIGNED} Sign in again under Settings, Vex Inference to link it.`);
      }
      linkedAtGate = true;
      const minimum = minimumOf(account.value);
      if (!minimum.ok) throw new GateRefusal(minimum.refusal);
      if (amountWei < minimum.value.minimumWei) {
        gate(
          "below_minimum",
          `At the current rate this amount is under the ${formatMicroUsd(minimum.value.minimumMicroUsd)} minimum (${formatVexExact(minimum.value.minimumWei)} VEX). ${NOTHING_SIGNED}`,
        );
      }
    }
    let vexWei: bigint;
    let nativeWei: bigint;
    try {
      vexWei = await chain.readVexBalance(from, signal, "pending");
      nativeWei = await chain.readNativeBalance(from);
    } catch {
      gate("chain_unavailable", `The wallet balance could not be read right before signing. ${NOTHING_SIGNED}`);
    }
    if (vexWei < amountWei) {
      gate("insufficient_funds", `This wallet now holds ${formatVexExact(vexWei)} VEX, less than the ${formatVexExact(amountWei)} VEX approved. ${NOTHING_SIGNED}`);
    }
    const exposure = request.gas * (request.maxFeePerGas ?? request.gasPrice ?? feeBound.maxFeePerGas);
    if (nativeWei < exposure) {
      gate("insufficient_funds", `This wallet does not hold enough ETH for the network fee. ${NOTHING_SIGNED}`);
    }
    if (hooks.extraGate !== undefined) {
      const refusal = await hooks.extraGate(request);
      if (refusal !== null) throw new GateRefusal(refusal);
    }
    if (signal.aborted) gate("cancelled", `Cancelled. ${NOTHING_SIGNED}`);
  };

  /**
   * THE FINAL CHECK, immediately before the signature and after every
   * preparation await (the key decryption and the nonce read included).
   * Local only: no network call happens here, so nothing can change between
   * this verdict and the bytes being signed.
   */
  const onFinalCheck = async (request: FinalSignedRequest): Promise<void> => {
    if (signal.aborted) gate("cancelled", `Cancelled. ${NOTHING_SIGNED}`);
    if (deps.now().getTime() >= expiresAtMs) gate("proposal_expired", `This deposit approval expired while it was being prepared. ${NOTHING_SIGNED}`);
    if (!deps.isVaultUnlocked()) gate("vault", `Vex is locked. Unlock Vex, then deposit again. ${NOTHING_SIGNED}`);
    if (!deps.isExecutionReady()) gate("execution_not_ready", `Vex is not ready to sign right now. ${NOTHING_SIGNED}`);
    if (findWallet(deps, from) === undefined) gate("wallet_not_in_inventory", `That wallet is no longer in this app. ${NOTHING_SIGNED}`);
    if (!linkedAtGate) gate("sender_not_linked", `That wallet's link to your Vex Inference account was not confirmed. ${NOTHING_SIGNED}`);
    const pinned = deps.pinnedDepositAddress();
    if (pinned === null || pinned.toLowerCase() !== to.toLowerCase()) {
      gate("deposit_address_mismatch", `The deposit address built into Vex changed after the deposit was reviewed. ${NOTHING_SIGNED}`);
    }
    const extra = hooks.extraFinal?.(request) ?? null;
    if (extra !== null) throw new GateRefusal(extra);
  };

  let signingRecorded = false;
  const loadPrivateKey = async (): Promise<Hex> => {
    if (!deps.isVaultUnlocked()) gate("vault", `Vex is locked. Unlock Vex, then deposit again. ${NOTHING_SIGNED}`);
    const entry = findWallet(deps, from);
    if (entry === undefined) gate("wallet_not_in_inventory", `That wallet is no longer in this app. ${NOTHING_SIGNED}`);
    if (!signingRecorded && hooks.onSigning !== undefined) {
      signingRecorded = true;
      await hooks.onSigning();
    }
    return deps.loadPrivateKey(entry);
  };

  const staged: { hash: Hex | null } = { hash: null };
  let outcome: StagedBroadcastOutcome;
  try {
    outcome = await chain.broadcastTransfer({
      from,
      data,
      feeBound,
      onBeforeSign,
      onFinalCheck,
      loadPrivateKey,
      onHashStaged: (txHash) => {
        staged.hash = txHash;
      },
    });
  } catch (cause) {
    // `signStageBroadcast` throws only BEFORE the send: nothing was broadcast.
    const refusal = classifyPreBroadcastThrow(cause);
    if (staged.hash !== null) {
      // Defensive: a throw with a staged hash would contradict that contract.
      // The honest answer is the pending one, never a failure.
      return { ok: true, value: await settle(deps, bearer.value, staged.hash, "pending", false, signal) };
    }
    return { ok: false, refusal };
  }

  if (outcome.kind === "confirmed") {
    const proven = proveErc20Transfer({
      logs: outcome.receipt.logs,
      tokenAddress: VEX_TOKEN_ADDRESS,
      from,
      to,
      expectedAmountRaw: amountWei,
    });
    return { ok: true, value: await settle(deps, bearer.value, outcome.txHash, "confirmed", proven !== null, signal) };
  }
  if (outcome.kind === "reverted") {
    return { ok: true, value: { status: "reverted", txHash: outcome.txHash, transferProven: false, notified: false } };
  }
  // Ambiguous: sent, outcome unknown. It stays pending and is never re-sent.
  return { ok: true, value: await settle(deps, bearer.value, outcome.txHash, "pending", false, signal) };
}

/** Tell Vex Inference about the hash. Best effort: the watcher finds the transfer on chain either way. */
async function settle(
  deps: DepositDeps,
  bearer: string,
  txHash: Hex,
  status: "confirmed" | "pending",
  transferProven: boolean,
  signal: AbortSignal,
): Promise<VexCloudSubmitDepositResult> {
  let notified = false;
  try {
    // The caller's cancel must not stop the hint for a transaction that already exists.
    const hint = await deps.api.notifyDeposit(bearer, txHash, signal.aborted ? new AbortController().signal : signal);
    notified = hint.ok;
  } catch {
    notified = false;
  }
  return { status, txHash, transferProven, notified };
}
