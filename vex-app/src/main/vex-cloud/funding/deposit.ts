/**
 * The Vex Inference funding-page DEPOSIT owner: a VEX `transfer` on Robinhood
 * Chain (4663) from one of the user's in-app EVM wallets to the deposit
 * address pinned in this build. Reachable only from the `vexCloud` IPC
 * handlers. The reads and the signing path are the shared deposit core
 * (`deposit-core.ts`), which the agent deposit owner and the auto top-up
 * executor use with their own authority; this module owns only the form's
 * proposal and its "the form is the approval" authority.
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

import { getAddress } from "viem";
import type {
  VexCloudDepositProposal,
  VexCloudDepositWalletsResult,
  VexCloudPrepareDepositInput,
  VexCloudSubmitDepositInput,
  VexCloudSubmitDepositResult,
} from "@shared/schemas/vex-cloud-funding.js";
import {
  parseVexAmountText,
  VEX_CLOUD_CHAIN_ID,
  VEX_DECIMALS,
  VEX_SYMBOL,
  VEX_TOKEN_ADDRESS,
} from "@shared/vex-cloud-money.js";
import type { StagedFeeExposureLimit } from "@tools/evm-chains/staged-broadcast.js";
import type { Erc20TransferPort } from "@tools/evm-chains/erc20-transfer-port.js";
import { log } from "../../logger/index.js";
import { refused, type VexCloudOutcome } from "../outcome.js";
import {
  __resetDepositCoreForTests,
  executeDeposit,
  findWallet,
  NOTHING_SIGNED,
  planDeposit,
  withWalletReservation,
  type DepositDeps,
} from "./deposit-core.js";
import { ProposalStore, type StoredProposal } from "./proposal-store.js";

/** How long an approval card stays valid: long enough to read, short enough that the fee bound and rate stay current. */
export const DEPOSIT_PROPOSAL_TTL_MS = 120_000;

interface DepositEntry extends StoredProposal {
  readonly proposal: VexCloudDepositProposal;
  readonly feeBound: StagedFeeExposureLimit;
}

let proposals = new ProposalStore<DepositEntry>();

/** Test-only reset so suites cannot leak proposals or in-flight marks into each other. */
export function __resetDepositStateForTests(): void {
  __resetDepositCoreForTests();
  proposals = new ProposalStore<DepositEntry>();
}

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
  // The pin and the wallet come first: they are the refusals a user acts on before an amount.
  if (deps.pinnedDepositAddress() === null) {
    return refused("deposits_not_open", "Deposits open soon. This version of Vex has no Vex Inference deposit address yet, so nothing can be sent.");
  }
  if (findWallet(deps, input.walletAddress) === undefined) {
    return refused("wallet_not_in_inventory", "That wallet is not one of the EVM wallets in this app. Pick a wallet from the list.");
  }
  const amount = parseVexAmountText(input.amountText);
  if (!amount.ok) return amountRefusal(amount.reason);
  const planned = await planDeposit(deps, { walletAddress: input.walletAddress, amountWei: amount.wei }, signal);
  if (!planned.ok) return planned;
  const plan = planned.value;

  const now = deps.now();
  const minted = proposals.mint(now.getTime(), (proposalId) => {
    const proposal: VexCloudDepositProposal = {
      proposalId,
      actor: "user",
      chainId: VEX_CLOUD_CHAIN_ID,
      token: { address: VEX_TOKEN_ADDRESS, symbol: VEX_SYMBOL, decimals: VEX_DECIMALS },
      amountWei: plan.amountWei.toString(),
      from: plan.from,
      to: plan.to,
      feeBound: {
        gasLimit: plan.feeBound.gasLimit.toString(),
        maxFeePerGasWei: plan.feeBound.maxFeePerGas.toString(),
        maxPriorityFeePerGasWei: plan.feeBound.maxPriorityFeePerGas.toString(),
        maxNetworkFeeWei: plan.feeBound.maxNetworkFeeWei.toString(),
        nativeSymbol: "ETH",
        nativeDecimals: 18,
      },
      usdMicroEstimate: plan.usdMicroEstimate.toString(),
      minimumWei: plan.minimum.minimumWei.toString(),
      minimumMicroUsd: plan.minimum.minimumMicroUsd.toString(),
      provisionalCapMicroUsd: plan.account.limits.provisional_cap_micro_usd,
      walletVexWei: plan.walletVexWei.toString(),
      walletNativeWei: plan.walletNativeWei.toString(),
      preparedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DEPOSIT_PROPOSAL_TTL_MS).toISOString(),
    };
    return { proposalId, expiresAtMs: now.getTime() + DEPOSIT_PROPOSAL_TTL_MS, proposal, feeBound: plan.feeBound };
  });
  return { ok: true, value: minted.proposal };
}

// ── submit ───────────────────────────────────────────────────────────────

export async function submitDeposit(
  deps: DepositDeps,
  input: VexCloudSubmitDepositInput,
  signal: AbortSignal,
  correlationId: string,
): Promise<VexCloudOutcome<VexCloudSubmitDepositResult>> {
  // Reserved before the first await, so a second click cannot race the first.
  return withWalletReservation(input.walletAddress, async () => {
    log.info(`[vex-cloud:deposit] asked correlationId=${correlationId}`);
    let decided = "refused";
    try {
      const outcome = await runSubmit(deps, input, signal);
      decided = outcome.ok ? outcome.value.status : `refused:${outcome.refusal.kind}`;
      return outcome;
    } finally {
      log.info(`[vex-cloud:deposit] decided outcome=${decided} correlationId=${correlationId}`);
    }
  });
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
  return executeDeposit(
    deps,
    {
      from: proposal.from,
      to: proposal.to,
      amountWei: BigInt(proposal.amountWei),
      feeBound,
      expiresAtMs: Date.parse(proposal.expiresAt),
    },
    signal,
  );
}
