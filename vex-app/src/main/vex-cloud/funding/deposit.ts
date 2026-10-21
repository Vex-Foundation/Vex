/**
 * The Vex Cloud DEPOSIT owner: a VEX `transfer` on Robinhood Chain (4663)
 * from one of the user's in-app EVM wallets to the deposit address pinned in
 * this build. Reachable only from the `vexCloud` IPC handlers: no agent tool,
 * no mission and no model output can reach it (plan 15.1).
 *
 * THE FORM IS THE APPROVAL (the `poolsLaunch` desktop pattern). `prepare`
 * reads everything fresh and mints a proposal; the card the user approves
 * shows every field of it. `submit` takes the proposal id plus the figures
 * the user saw, CONSUMES the proposal (single use: a double click cannot send
 * twice) and refuses by name when anything differs.
 *
 * WHAT THE APPROVAL BINDS, AND WHERE IT IS CHECKED AGAIN
 *
 * | Field | Bound at prepare | Re-checked before the key exists (`onBeforeSign`) |
 * |---|---|---|
 * | actor | `user` (this IPC path only) | n/a: no other path reaches the owner |
 * | chain | 4663 | the signed request is prepared for the 4663 client |
 * | token | VEX, 18 decimals | the signed `to` is the VEX contract, `value` 0 |
 * | amount (human and wei) | parsed from the typed text | submit echo; signed calldata encodes it; on-chain balance (pending) covers it; still at least the minimum at the backend's CURRENT rate |
 * | from | an inventory wallet LINKED to the signed-in account (fresh `account.wallets`) | submit echo; still in the inventory; still linked (fresh account read); the decrypted key derives it |
 * | to | the pinned address, equal to the backend's | pinned address re-resolved; backend re-read; signed calldata encodes it |
 * | fee bound | from a fresh estimate | `signStageBroadcast` refuses a request above it; the wallet's ETH covers the signed exposure |
 * | expiry, proposal id | minted here | consumed once; expiry re-checked |
 * | vault, runtime | | vault unlocked; execution gate open |
 *
 * WHY THE SENDER MUST BE LINKED. Vex Cloud attributes a deposit by its
 * on-chain sender, which must be a wallet linked to the account
 * (`VexVirtualsCompute/src/deposits/ledger.ts`). VEX from an unlinked wallet
 * lands unattributed (manual recovery), and VEX from a wallet linked to
 * ANOTHER account credits that account. So the sender is checked against
 * the account's fresh `wallets` at prepare and again in the pre-sign gate.
 *
 * THE FINAL CHECK. The pre-sign gate runs before the key exists, and
 * `signStageBroadcast` then still awaits the decryption and a nonce read
 * (`assertReservedNonceMatchesPending`) before it signs. A Stop pressed, an
 * expiry passed, a lock or an inventory change in that window would otherwise
 * be signed over. `onFinalCheck` is the transfer port's
 * `StagedBroadcastHooks.onBeforeSign`: the LAST await before the signature,
 * after every preparation await. It re-checks the caller's signal, the
 * expiry, the vault, the execution gate, the inventory, the gate's linked
 * verdict and the local pin, all locally: no network call happens there.
 *
 * OUTCOMES. A throw anywhere before the send means nothing was broadcast
 * (`signStageBroadcast` contract); it is a refusal. After the send: a
 * successful receipt is `confirmed` (and the Transfer log is proven with the
 * agent send tool's own `proveErc20Transfer`), a reverted one `reverted`, and
 * anything unknown stays `pending`: never re-sent, never reported failed.
 * Vex Cloud is told about the hash (`/v1/deposits/notify`, a hint only: its
 * watcher attributes deposits from the chain, plan section 3).
 *
 * AUDIT. One `asked` line when a submit starts and exactly one `decided`
 * line with its outcome, correlated (the deepseek-harness approval pair).
 * Never an address, a key or a bearer.
 */

import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import type { VexError } from "@shared/ipc/result.js";
import type {
  VexCloudDepositProposal,
  VexCloudDepositWalletsResult,
  VexCloudPrepareDepositInput,
  VexCloudSubmitDepositInput,
  VexCloudSubmitDepositResult,
} from "@shared/schemas/vex-cloud-funding.js";
import {
  formatMicroUsd,
  formatVexExact,
  microUsdToWeiCeil,
  parseRateX18,
  parseVexAmountText,
  VEX_CLOUD_CHAIN_ID,
  VEX_DECIMALS,
  VEX_SYMBOL,
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
import { proveErc20Transfer } from "@vex-agent/tools/internal/wallet/send/transfer-settlement.js";
import { log } from "../../logger/index.js";
import type { VexCloudAccountResponse, VexCloudApi } from "../api-client.js";
import { refused, type VexCloudOutcome, type VexCloudRefusal } from "../outcome.js";
import { backendRefusal, requireBearer, type SessionPort } from "./backend-call.js";
import type { Erc20TransferPort } from "@tools/evm-chains/erc20-transfer-port.js";
import { ProposalStore, type StoredProposal } from "./proposal-store.js";

/** How long an approval card stays valid: long enough to read, short enough that the fee bound and rate stay current. */
export const DEPOSIT_PROPOSAL_TTL_MS = 120_000;

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

export interface DepositDeps extends SessionPort {
  readonly api: Pick<VexCloudApi, "readAccount" | "notifyDeposit">;
  readonly chain: () => Erc20TransferPort;
  readonly listEvmWallets: () => readonly WalletInventoryEntry[];
  readonly isVaultUnlocked: () => boolean;
  readonly isExecutionReady: () => boolean;
  /** Re-resolved at prepare AND inside the pre-sign gate. */
  readonly pinnedDepositAddress: () => string | null;
  /** Decrypt the entry's key; throws `SIGNER_MISMATCH` when it does not derive the entry's address. */
  readonly loadPrivateKey: (entry: WalletInventoryEntry) => Promise<Hex>;
  readonly now: () => Date;
}

interface DepositEntry extends StoredProposal {
  readonly proposal: VexCloudDepositProposal;
  readonly feeBound: StagedFeeExposureLimit;
}

let proposals = new ProposalStore<DepositEntry>();
/** Single flight per wallet: one deposit signs at a time for a wallet. */
const inFlight = new Set<string>();

/** Test-only reset so suites cannot leak proposals or in-flight marks into each other. */
export function __resetDepositStateForTests(): void {
  inFlight.clear();
  proposals = new ProposalStore<DepositEntry>();
}

function transferCalldata(to: Address, amountWei: bigint): Hex {
  return encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [to, amountWei] });
}

function findWallet(deps: DepositDeps, address: string): WalletInventoryEntry | undefined {
  return deps.listEvmWallets().find((entry) => entry.address.toLowerCase() === address.toLowerCase());
}

/** Linked to the signed-in account, per the account's own fresh `wallets`. */
function isLinkedTo(account: VexCloudAccountResponse, address: string): boolean {
  return account.wallets.some((wallet) => wallet.address.toLowerCase() === address.toLowerCase());
}

const SENDER_NOT_LINKED_DETAIL =
  "That wallet is not linked to your Vex Cloud account, so a deposit from it would not reach your balance. Nothing was signed. Sign in again under Settings, Vex Cloud to link it, or pick a linked wallet.";

function amountRefusal(reason: "empty" | "format" | "too_precise" | "zero"): VexCloudOutcome<never> {
  switch (reason) {
    case "empty":
      return refused("invalid_amount", "Enter an amount of VEX to deposit.");
    case "zero":
      return refused("invalid_amount", "Enter an amount above zero.");
    case "too_precise":
      return refused("invalid_amount", "VEX has 18 decimals; enter at most 18 digits after the point.");
    case "format":
      return refused("invalid_amount", "Enter the amount as digits with at most one point, for example 125.5, without separators.");
  }
}

const RATE_UNAVAILABLE_DETAIL =
  "Vex Cloud has no current VEX price, so the $5 minimum cannot be checked. Nothing was signed; try again in a few minutes.";

/** The minimum at the account's current rate, or the refusal when no valid rate exists. */
function minimumOf(account: VexCloudAccountResponse): VexCloudOutcome<{ readonly rateX18: bigint; readonly minimumWei: bigint; readonly minimumMicroUsd: bigint }> {
  if (!account.rate.available) return refused("rate_unavailable", RATE_UNAVAILABLE_DETAIL);
  const rateX18 = parseRateX18(account.rate.vex_wei_per_micro_usd);
  if (rateX18 === null) return refused("rate_unavailable", RATE_UNAVAILABLE_DETAIL);
  const minimumMicroUsd = BigInt(account.limits.min_deposit_micro_usd);
  return { ok: true, value: { rateX18, minimumMicroUsd, minimumWei: microUsdToWeiCeil(minimumMicroUsd, rateX18) } };
}

function pinRefusal(pinned: string | null, backend: string | null): VexCloudOutcome<never> | null {
  if (pinned === null) {
    return refused("deposits_not_open", "Deposits open soon. This version of Vex has no Vex Cloud deposit address yet, so nothing can be sent.");
  }
  if (backend === null) {
    // The backend has no custody configured: the same state as an empty pin.
    return refused("deposits_not_open", "Deposits are not open yet: Vex Cloud has no deposit address configured. Nothing was sent.");
  }
  if (backend.toLowerCase() !== pinned.toLowerCase()) {
    return refused(
      "deposit_address_mismatch",
      "Funding is disabled: the deposit address built into Vex does not match the one Vex Cloud reports. Nothing was sent. Update Vex, and contact support if this stays.",
    );
  }
  return null;
}

/** The fee bound the user approves: room above a fresh estimate, never an open ceiling. */
export function depositFeeBound(quote: { readonly gasEstimate: bigint; readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }): StagedFeeExposureLimit {
  const gasLimit = (gasLimitWithHeadroom(quote.gasEstimate) * 3n) / 2n;
  const maxFeePerGas = quote.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = quote.maxPriorityFeePerGas * 2n;
  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas, maxNetworkFeeWei: gasLimit * maxFeePerGas };
}

// ── depositWallets ───────────────────────────────────────────────────────

/** The in-app EVM wallets with their live VEX balance; a failed read is `null`, never zero. */
export async function listDepositWallets(deps: DepositDeps, signal: AbortSignal): Promise<VexCloudOutcome<VexCloudDepositWalletsResult>> {
  let chain: Erc20TransferPort;
  try {
    chain = deps.chain();
  } catch {
    return refused("chain_unavailable", "Robinhood Chain is not reachable from this build. Nothing was read.");
  }
  const wallets = await Promise.all(
    deps.listEvmWallets().map(async (entry) => {
      let vexWei: string | null = null;
      try {
        vexWei = (await chain.readVexBalance(getAddress(entry.address), signal)).toString();
      } catch {
        vexWei = null;
      }
      return { address: getAddress(entry.address), label: entry.label, vexWei };
    }),
  );
  if (signal.aborted) return refused("cancelled", "Cancelled. Nothing was read.");
  return { ok: true, value: { chainId: VEX_CLOUD_CHAIN_ID, wallets, readAt: deps.now().toISOString() } };
}

// ── prepare ──────────────────────────────────────────────────────────────

export async function prepareDeposit(
  deps: DepositDeps,
  input: VexCloudPrepareDepositInput,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudDepositProposal>> {
  const pinned = deps.pinnedDepositAddress();
  if (pinned === null) return pinRefusal(null, null) ?? refused("deposits_not_open", "Deposits open soon.");
  const entry = findWallet(deps, input.walletAddress);
  if (entry === undefined) {
    return refused("wallet_not_in_inventory", "That wallet is not one of the EVM wallets in this app. Pick a wallet from the list.");
  }
  const amount = parseVexAmountText(input.amountText);
  if (!amount.ok) return amountRefusal(amount.reason);

  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const read = await deps.api.readAccount(bearer.value, signal);
  if (!read.ok) return backendRefusal(deps, read.failure);
  const account = read.value;
  const mismatch = pinRefusal(pinned, account.deposit_address);
  if (mismatch !== null) return mismatch;
  if (!isLinkedTo(account, entry.address)) return refused("sender_not_linked", SENDER_NOT_LINKED_DETAIL);
  const minimum = minimumOf(account);
  if (!minimum.ok) return minimum;
  if (amount.wei < minimum.value.minimumWei) {
    return refused(
      "below_minimum",
      `The minimum deposit is ${formatMicroUsd(minimum.value.minimumMicroUsd)}, which is ${formatVexExact(minimum.value.minimumWei)} VEX at the current rate. Enter at least that much.`,
    );
  }

  const from = getAddress(entry.address);
  const to = getAddress(pinned);
  const data = transferCalldata(to, amount.wei);
  let chain: Erc20TransferPort;
  let vexWei: bigint;
  let nativeWei: bigint;
  let quote: { gasEstimate: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  try {
    chain = deps.chain();
    vexWei = await chain.readVexBalance(from, signal, "pending");
    if (vexWei < amount.wei) {
      return refused(
        "insufficient_funds",
        `This wallet holds ${formatVexExact(vexWei)} VEX, less than the ${formatVexExact(amount.wei)} VEX you entered. Enter a smaller amount or pick another wallet.`,
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

  const now = deps.now();
  const minted = proposals.mint(now.getTime(), (proposalId) => {
    const proposal: VexCloudDepositProposal = {
      proposalId,
      actor: "user",
      chainId: VEX_CLOUD_CHAIN_ID,
      token: { address: VEX_TOKEN_ADDRESS, symbol: VEX_SYMBOL, decimals: VEX_DECIMALS },
      amountWei: amount.wei.toString(),
      from,
      to,
      feeBound: {
        gasLimit: feeBound.gasLimit.toString(),
        maxFeePerGasWei: feeBound.maxFeePerGas.toString(),
        maxPriorityFeePerGasWei: feeBound.maxPriorityFeePerGas.toString(),
        maxNetworkFeeWei: feeBound.maxNetworkFeeWei.toString(),
        nativeSymbol: "ETH",
        nativeDecimals: 18,
      },
      usdMicroEstimate: weiToMicroUsdFloor(amount.wei, minimum.value.rateX18).toString(),
      minimumWei: minimum.value.minimumWei.toString(),
      minimumMicroUsd: minimum.value.minimumMicroUsd.toString(),
      provisionalCapMicroUsd: account.limits.provisional_cap_micro_usd,
      walletVexWei: vexWei.toString(),
      walletNativeWei: nativeWei.toString(),
      preparedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DEPOSIT_PROPOSAL_TTL_MS).toISOString(),
    };
    return { proposalId, expiresAtMs: now.getTime() + DEPOSIT_PROPOSAL_TTL_MS, proposal, feeBound };
  });
  return { ok: true, value: minted.proposal };
}

// ── submit ───────────────────────────────────────────────────────────────

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

const NOTHING_SIGNED = "Nothing was signed or sent.";

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
      detail: `The network fee rose above the bound you approved. ${NOTHING_SIGNED} Review the deposit again to see the new fee.`,
    };
  }
  return {
    kind: "chain_unavailable",
    detail: `The deposit could not be prepared on Robinhood Chain. ${NOTHING_SIGNED} Try again in a moment.`,
  };
}

export async function submitDeposit(
  deps: DepositDeps,
  input: VexCloudSubmitDepositInput,
  signal: AbortSignal,
  correlationId: string,
): Promise<VexCloudOutcome<VexCloudSubmitDepositResult>> {
  const walletKey = input.walletAddress.toLowerCase();
  // Reserved before the first await, so a second click cannot race the first.
  if (inFlight.has(walletKey)) {
    return refused("already_running", "A deposit from this wallet is already being sent. Wait for it to finish.");
  }
  inFlight.add(walletKey);
  log.info(`[vex-cloud:deposit] asked correlationId=${correlationId}`);
  let decided = "refused";
  try {
    const outcome = await runSubmit(deps, input, signal);
    decided = outcome.ok ? outcome.value.status : `refused:${outcome.refusal.kind}`;
    return outcome;
  } finally {
    inFlight.delete(walletKey);
    log.info(`[vex-cloud:deposit] decided outcome=${decided} correlationId=${correlationId}`);
  }
}

async function runSubmit(
  deps: DepositDeps,
  input: VexCloudSubmitDepositInput,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudSubmitDepositResult>> {
  const found = proposals.consume(input.proposalId, deps.now().getTime());
  if (found.kind === "missing") {
    return refused("proposal_missing", `This deposit was already sent, cancelled or never prepared. ${NOTHING_SIGNED} Review the deposit again.`);
  }
  if (found.kind === "expired") {
    return refused("proposal_expired", `This deposit approval expired. ${NOTHING_SIGNED} Review the deposit again to see current figures.`);
  }
  const { proposal, feeBound } = found.entry;
  if (
    input.walletAddress.toLowerCase() !== proposal.from.toLowerCase()
    || input.amountWei !== proposal.amountWei
  ) {
    return refused("proposal_changed", `The wallet or amount differs from the deposit you reviewed. ${NOTHING_SIGNED} Review the deposit again.`);
  }
  if (signal.aborted) return refused("cancelled", `Cancelled. ${NOTHING_SIGNED}`);

  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const from = getAddress(proposal.from);
  const to = getAddress(proposal.to);
  const amountWei = BigInt(proposal.amountWei);
  const data = transferCalldata(to, amountWei);
  const expiresAtMs = Date.parse(proposal.expiresAt);

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
      gate("deposit_address_mismatch", `The deposit address built into Vex changed after you reviewed the deposit. ${NOTHING_SIGNED}`);
    }
    if (
      request.to?.toLowerCase() !== VEX_TOKEN_ADDRESS.toLowerCase()
      || request.value !== 0n
      || request.data?.toLowerCase() !== data.toLowerCase()
    ) {
      gate("proposal_changed", `The transaction about to be signed is not the deposit you reviewed. ${NOTHING_SIGNED}`);
    }
    const account = await deps.api.readAccount(bearer.value, signal);
    if (!account.ok) {
      const refusal = await backendRefusal<never>(deps, account.failure);
      if (!refusal.ok) throw new GateRefusal(refusal.refusal);
    } else {
      const mismatch = pinRefusal(pinned, account.value.deposit_address);
      if (mismatch !== null && !mismatch.ok) throw new GateRefusal(mismatch.refusal);
      if (!isLinkedTo(account.value, from)) {
        gate("sender_not_linked", `That wallet is no longer linked to your Vex Cloud account. ${NOTHING_SIGNED} Sign in again under Settings, Vex Cloud to link it.`);
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
    if (signal.aborted) gate("cancelled", `Cancelled. ${NOTHING_SIGNED}`);
  };

  /**
   * THE FINAL CHECK, immediately before the signature and after every
   * preparation await (the key decryption and the nonce read included).
   * Local only: no network call happens here, so nothing can change between
   * this verdict and the bytes being signed.
   */
  const onFinalCheck = async (): Promise<void> => {
    if (signal.aborted) gate("cancelled", `Cancelled. ${NOTHING_SIGNED}`);
    if (deps.now().getTime() >= expiresAtMs) gate("proposal_expired", `This deposit approval expired while it was being prepared. ${NOTHING_SIGNED}`);
    if (!deps.isVaultUnlocked()) gate("vault", `Vex is locked. Unlock Vex, then deposit again. ${NOTHING_SIGNED}`);
    if (!deps.isExecutionReady()) gate("execution_not_ready", `Vex is not ready to sign right now. ${NOTHING_SIGNED}`);
    if (findWallet(deps, from) === undefined) gate("wallet_not_in_inventory", `That wallet is no longer in this app. ${NOTHING_SIGNED}`);
    if (!linkedAtGate) gate("sender_not_linked", `That wallet's link to your Vex Cloud account was not confirmed. ${NOTHING_SIGNED}`);
    const pinned = deps.pinnedDepositAddress();
    if (pinned === null || pinned.toLowerCase() !== to.toLowerCase()) {
      gate("deposit_address_mismatch", `The deposit address built into Vex changed after you reviewed the deposit. ${NOTHING_SIGNED}`);
    }
  };

  const loadPrivateKey = async (): Promise<Hex> => {
    if (!deps.isVaultUnlocked()) gate("vault", `Vex is locked. Unlock Vex, then deposit again. ${NOTHING_SIGNED}`);
    const entry = findWallet(deps, from);
    if (entry === undefined) gate("wallet_not_in_inventory", `That wallet is no longer in this app. ${NOTHING_SIGNED}`);
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

/** Tell Vex Cloud about the hash. Best effort: the watcher finds the transfer on chain either way. */
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
