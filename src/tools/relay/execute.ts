/**
 * Relay bridge executor — validate the WHOLE quote, then sign every step in
 * order, then poll to terminal.
 *
 * FAIL-CLOSED ORDERING (fund safety): validation and broadcasting are strictly
 * separated into two phases. PHASE 1 pre-validates EVERY step of the quote (kind,
 * per-step chainId ∈ {origin, destination}, from == the selected wallet, tx
 * calldata shape) with ZERO broadcasts. Only if the whole quote passes does PHASE
 * 2 broadcast the pre-validated transactions strictly in order. A single invalid
 * step — even the LAST one — aborts the whole bridge before any funds move, so a
 * valid early step can never leave funds mid-bridge on a quote that is rejected
 * further down.
 *
 * Wallet clients resolve via the INCLUSIVE chain resolver (2b): Robinhood 4663
 * uses the local registry client (honours the user RPC override + Multicall3);
 * every other chain uses the Khalani dynamic client. Only `kind: "transaction"`
 * steps are signed — a `signature` (permit) step is REJECTED in v1 (bounded
 * signing surface, mirroring Khalani's PERMIT2 block).
 */

import {
  getAddress,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

import { resolveInclusiveEvmChain } from "@tools/evm-chains/resolver.js";
import { getLocalEvmClients } from "@tools/evm-chains/evm-client.js";
import { waitForSuccessfulReceipt } from "@tools/evm-chains/receipt-guard.js";
import {
  createDynamicPublicClient,
  createDynamicWalletClient,
} from "@tools/khalani/evm-client.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { VexError, ErrorCodes } from "../../errors.js";
import logger from "../../utils/logger.js";
import { getRelayClient } from "./client.js";
import { RELAY_TERMINAL_STATUSES, type RelayQuoteResponse } from "./types.js";

interface EvmClients {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
}

async function resolveStepClients(chainId: number, privateKey: Hex): Promise<EvmClients> {
  const resolved = await resolveInclusiveEvmChain(String(chainId));
  if (resolved.family !== "eip155") {
    throw new VexError(ErrorCodes.RELAY_UNSUPPORTED_CHAIN, `Relay step chain ${chainId} is not an EVM chain.`);
  }
  if (resolved.source === "local") {
    return getLocalEvmClients(resolved.config, privateKey);
  }
  return {
    publicClient: createDynamicPublicClient(resolved.khalaniChain, resolved.khalaniChains),
    walletClient: createDynamicWalletClient(resolved.khalaniChain, resolved.khalaniChains, privateKey),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded status-poll budget: relay soft-confirms fast, but we never block a turn
// indefinitely. On timeout we return the last non-terminal status (the capture
// records it as pending — the intent is still live on Relay).
const POLL_MAX_MS = 60_000;
const POLL_INITIAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 8_000;

async function pollToTerminal(requestId: string): Promise<string> {
  const client = getRelayClient();
  const started = Date.now();
  let interval = POLL_INITIAL_MS;
  let status = "pending";
  while (Date.now() - started < POLL_MAX_MS) {
    await delay(interval);
    try {
      const res = await client.getIntentStatus(requestId);
      status = res.status;
      if (RELAY_TERMINAL_STATUSES.has(status)) return status;
    } catch (err) {
      logger.warn("relay.bridge.status_poll_failed", {
        reason: err instanceof VexError ? err.code : "unknown",
      });
    }
    interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
  }
  return status;
}

export interface RelayExecuteArgs {
  quote: RelayQuoteResponse;
  signer: ChainWallet;
  originChainId: number;
  destinationChainId: number;
}

/** One broadcast transaction paired with the chain it was broadcast on. */
export interface RelayTransaction {
  readonly chainId: number;
  readonly hash: string;
}

export interface RelayExecuteResult {
  txHashes: string[];
  /**
   * Per-tx records carrying the chain each hash was broadcast on. Additive
   * alongside `txHashes` (kept for compatibility): a Relay bridge spans the
   * origin AND destination chains, so a chain-less `txHashes[]` cannot map every
   * hash to an explorer. `transactions[i].hash === txHashes[i]` by construction.
   */
  transactions: RelayTransaction[];
  requestId: string | null;
  finalStatus: string;
}

/**
 * A single transaction pre-validated in PHASE 1 and ready to broadcast in PHASE
 * 2. `to`/`value` are already canonicalized (`getAddress`/`BigInt`), so PHASE 2
 * never re-parses untrusted quote fields — a parse failure aborts BEFORE any
 * broadcast, not between broadcasts.
 */
interface PlannedRelayTx {
  readonly stepId: string;
  readonly chainId: number;
  readonly to: `0x${string}`;
  readonly data: Hex;
  readonly value: bigint;
}

/**
 * PHASE 1 — pre-validate EVERY step of the quote with ZERO broadcasts. Returns
 * the ordered list of transactions to broadcast plus the intent requestId. Any
 * invalid step (unsupported kind, chainId outside {origin, destination}, sender
 * mismatch, malformed calldata) THROWS here, so the caller never broadcasts a
 * partially-valid quote.
 */
function planRelayBridge(
  quote: RelayQuoteResponse,
  expectedFrom: `0x${string}`,
  originChainId: number,
  destinationChainId: number,
): { planned: PlannedRelayTx[]; requestId: string | null } {
  const allowedChains = new Set([originChainId, destinationChainId]);
  const planned: PlannedRelayTx[] = [];
  let requestId: string | null = null;

  for (const step of quote.steps) {
    if (step.requestId && !requestId) requestId = step.requestId;
    if (step.kind !== "transaction") {
      throw new VexError(
        ErrorCodes.RELAY_UNSUPPORTED_STEP,
        `Relay step "${step.id}" (${step.kind}) is not supported. Only transaction steps are signed in v1.`,
      );
    }
    for (const item of step.items) {
      const data = item.data;
      if (!data) continue;
      if (!allowedChains.has(data.chainId)) {
        throw new VexError(
          ErrorCodes.RELAY_STEP_CHAIN_MISMATCH,
          `Relay step targets chain ${data.chainId}, which is neither the origin (${originChainId}) nor destination (${destinationChainId}).`,
        );
      }
      if (data.from && getAddress(data.from) !== expectedFrom) {
        throw new VexError(
          ErrorCodes.RELAY_BRIDGE_FAILED,
          "Relay step sender does not match the selected wallet.",
        );
      }
      // Canonicalize the calldata shape NOW (before any broadcast). A malformed
      // `to`/`value` throws here, aborting the whole bridge fail-closed rather
      // than after an earlier step has already moved funds.
      let to: `0x${string}`;
      let value: bigint;
      try {
        to = getAddress(data.to);
      } catch {
        throw new VexError(ErrorCodes.RELAY_BRIDGE_FAILED, `Relay step "${step.id}" has a malformed recipient address.`);
      }
      try {
        value = BigInt(data.value);
      } catch {
        throw new VexError(ErrorCodes.RELAY_BRIDGE_FAILED, `Relay step "${step.id}" has a malformed transaction value.`);
      }
      planned.push({ stepId: step.id, chainId: data.chainId, to, data: data.data as Hex, value });
    }
  }

  return { planned, requestId };
}

/**
 * Validate the WHOLE quote (PHASE 1), broadcast every pre-validated transaction
 * in order (PHASE 2), then poll to a terminal state (bounded). Returns the
 * broadcast tx hashes + the intent requestId + the final status observed. A
 * PHASE-1 validation failure produces a clean error with ZERO broadcasts.
 */
export async function executeRelayBridge(args: RelayExecuteArgs): Promise<RelayExecuteResult> {
  const { quote, signer, originChainId, destinationChainId } = args;
  if (signer.family !== "eip155") {
    throw new VexError(ErrorCodes.RELAY_BRIDGE_FAILED, "Relay bridge requires an EVM signing wallet.");
  }
  const privateKey = signer.privateKey as Hex;
  const expectedFrom = getAddress(signer.address);

  // ── PHASE 1: pre-validate every step. No broadcasts happen until this returns. ──
  const { planned, requestId } = planRelayBridge(quote, expectedFrom, originChainId, destinationChainId);

  // ── PHASE 2: broadcast the pre-validated transactions strictly in order. ──
  const transactions: RelayTransaction[] = [];
  for (const tx of planned) {
    const { publicClient, walletClient } = await resolveStepClients(tx.chainId, privateKey);
    const hash = await walletClient.sendTransaction({
      account: walletClient.account,
      chain: walletClient.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    await waitForSuccessfulReceipt(publicClient, hash, {
      code: ErrorCodes.RELAY_BRIDGE_FAILED,
      what: `Relay step "${tx.stepId}"`,
      hint: "No further steps were broadcast. Check the transaction hash before re-quoting or retrying.",
    });
    // Pair each hash with the chain it was broadcast on (fund safety already
    // constrained tx.chainId to {origin, destination} in PHASE 1).
    transactions.push({ chainId: tx.chainId, hash });
    logger.info("relay.bridge.step_broadcast", { stepId: tx.stepId, chainId: tx.chainId });
  }

  const finalStatus = requestId ? await pollToTerminal(requestId) : "pending";
  return { txHashes: transactions.map((t) => t.hash), transactions, requestId, finalStatus };
}
