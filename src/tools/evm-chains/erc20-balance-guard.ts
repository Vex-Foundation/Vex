/**
 * Shared preflight for ERC-20 debits made by protocol routers.
 *
 * TWO OUTCOMES, NEVER ONE. A wallet that is SHORT and a wallet whose balance
 * COULD NOT BE READ are different facts with different remedies, and collapsing
 * them is the failure rule 04 names and contract C2.3 forbids: "reduce the
 * amount" is wrong advice for an RPC that timed out, and "retry" is wrong
 * advice for an empty wallet. The guard therefore reads through
 * `observeErc20SourceBalance`, which returns the read as a first-class outcome,
 * and gives each of the two its own refusal.
 *
 * The token address is always included in an error. Contract and provider
 * metadata is untrusted, so any optional display label is bounded and stripped
 * to a safe display-only character set before it reaches agent-visible output.
 *
 * WHAT THIS GUARD IS NOT. It is not sign-time authority. It runs before an
 * approval or a router call so gas is not burned on a `transferFrom` that
 * cannot succeed; the chain stays authoritative, and the authoritative debit
 * read belongs to the pre-sign window (contract C2.6).
 */

import { formatUnits, type Address } from "viem";

import type { SourceBalanceRead } from "@vex-agent/tools/protocols/quote-authority/spendability-contract.js";

import { ErrorCodes, VexError } from "../../errors.js";
import type { BalanceBlockTag, Erc20ReadClient } from "./erc20-reads.js";
import { observeErc20SourceBalance } from "./source-balance-observation.js";

export type Erc20BalanceClient = Erc20ReadClient;

export interface Erc20BalanceRequest {
  readonly token: Address;
  readonly owner: Address;
  readonly required: bigint;
  readonly decimals: number;
  readonly label?: string;
  /**
   * The chain the read is about, carried into the observation because a balance
   * statement that lost its chain is a statement about nothing (contract C2.4).
   * The callers that predate spendability omit it and the observation then says
   * `0`, which is visibly not a chain id rather than quietly the wrong one.
   */
  readonly chainId?: number;
  /**
   * The block to read at. DEFAULTS TO `latest`, which is the state this
   * preflight has always read: gaining a structured outcome must not silently
   * move twelve production callers onto a different block. `latest` is what a
   * node serves for an `eth_call` with no block parameter, and all eighteen
   * chains the swap venues serve were measured accepting both tags on
   * 2026-08-31.
   *
   * A spendability-gated lane passes `pending` - the only tag that subtracts
   * the wallet's own in-flight spending, and therefore the only one a SPEND may
   * be authorized from (contract C2.4). This preflight is not that
   * authorization; the authoritative read lives in the pre-sign window.
   */
  readonly blockTag?: BalanceBlockTag;
}

function sanitizeDisplayLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const safe = label.replace(/[^A-Za-z0-9 _.-]/g, "").slice(0, 16).trim();
  return safe || undefined;
}

/**
 * The wallet's balance could not be READ.
 *
 * Its own type and its own code, because the answer differs from a shortfall's:
 * nothing is known about the funds, so nothing may be inferred about them and
 * the operation fails closed. `readCause` is the producer's structural class
 * (`EVM_BALANCE_READ_CAUSES`), never provider text - uncontrolled RPC payload
 * does not travel into agent-visible output.
 */
export class Erc20BalanceUnavailableError extends VexError {
  readonly readCause: string;

  constructor(token: Address, displayName: string, readCause: string) {
    super(
      ErrorCodes.RPC_ERROR,
      `Could not read the balance of token ${token}${displayName} on this chain, so nothing was `
      + "attempted. This is a failed read, not a statement that the wallet is short.",
      "Retry once the chain endpoint answers, or check the balance with `ChainRead` (action "
      + "erc20_balance) first.",
    );
    this.name = "Erc20BalanceUnavailableError";
    this.readCause = readCause;
  }
}

/**
 * Fail before an approval or router call when the selected wallet lacks the
 * required ERC-20 input balance, or when that balance cannot be read.
 *
 * RETURNS THE READ IT MADE. A caller that also needs the observation (a
 * spendability leg, an approval card) reuses this one instead of taking a
 * second: two reads are two moments, and a card showing a different number than
 * the one that gated the call is a card nobody can check.
 */
export async function ensureErc20Balance(
  client: Erc20BalanceClient,
  request: Erc20BalanceRequest,
): Promise<SourceBalanceRead> {
  const read = await observeErc20SourceBalance(client, {
    chainId: request.chainId ?? 0,
    wallet: request.owner,
    token: request.token,
    assetAddress: request.token,
    decimals: request.decimals,
    symbol: null,
    blockTag: request.blockTag ?? "latest",
  });

  const label = sanitizeDisplayLabel(request.label);
  const displayName = label ? ` (${label})` : "";

  if (!read.ok) {
    throw new Erc20BalanceUnavailableError(request.token, displayName, read.cause);
  }

  const balance = BigInt(read.observation.balanceRaw);
  if (balance >= request.required) return read;

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
      + "If you believe a recent buy delivered it, verify on-chain with `ChainRead` (action erc20_balance) before retrying.",
      "Verify the on-chain balance with `ChainRead` (action erc20_balance) instead of retrying the same amount.",
    );
  }

  throw new VexError(
    ErrorCodes.INSUFFICIENT_BALANCE,
    `Insufficient balance for token ${request.token}${displayName}: have ${formatUnits(balance, request.decimals)}, requested ${requested}.`,
    "Reduce the amount to at most the wallet balance and retry.",
  );
}
