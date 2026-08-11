/**
 * Shared preflight for ERC-20 debits made by protocol routers.
 *
 * The token address is always included in an error. Contract and provider
 * metadata is untrusted, so any optional display label is bounded and stripped
 * to a safe display-only character set before it reaches agent-visible output.
 */

import { formatUnits, type Address } from "viem";

import { ErrorCodes, VexError } from "../../errors.js";
import { readErc20Balance, type Erc20ReadClient } from "./erc20-reads.js";

export type Erc20BalanceClient = Erc20ReadClient;

export interface Erc20BalanceRequest {
  readonly token: Address;
  readonly owner: Address;
  readonly required: bigint;
  readonly decimals: number;
  readonly label?: string;
}

function sanitizeDisplayLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const safe = label.replace(/[^A-Za-z0-9 _.-]/g, "").slice(0, 16).trim();
  return safe || undefined;
}

/**
 * Fail before an approval or router call when the selected wallet lacks the
 * required ERC-20 input balance. The chain remains authoritative at execution
 * time; this avoids spending gas on a known-over-balance transferFrom revert.
 */
export async function ensureErc20Balance(
  client: Erc20BalanceClient,
  request: Erc20BalanceRequest,
): Promise<void> {
  const balance = await readErc20Balance(client, request.token, request.owner);

  if (balance >= request.required) return;

  const label = sanitizeDisplayLabel(request.label);
  const displayName = label ? ` (${label})` : "";
  const requested = formatUnits(request.required, request.decimals);

  // A zero balance is the one shortfall where "have 0" understated the story:
  // in the live TOM incident (2026-08-10) the agent read it as indexer lag and
  // retried the sale for five minutes. The wallet holding NONE is said in
  // words, with the read that settles it. Every non-zero shortfall keeps its
  // exact previous wording (12 production callers).
  if (balance === 0n) {
    throw new VexError(
      ErrorCodes.INSUFFICIENT_BALANCE,
      `Insufficient balance for token ${request.token}${displayName}: you hold none of this token on this chain, and ${requested} was requested. `
      + "If you believe a recent buy delivered it, verify on-chain with chain_read (action erc20_balance) before retrying.",
      "Verify the on-chain balance with chain_read (action erc20_balance) instead of retrying the same amount.",
    );
  }

  throw new VexError(
    ErrorCodes.INSUFFICIENT_BALANCE,
    `Insufficient balance for token ${request.token}${displayName}: have ${formatUnits(balance, request.decimals)}, requested ${requested}.`,
    "Reduce the amount to at most the wallet balance and retry.",
  );
}
