/**
 * A durable `wallet_wrap_intents` row whose stored digest and stored card are
 * the ones its own bound fields produce.
 *
 * A helper module, not a spec: it exists so the revalidation tests can start
 * from a row that is genuinely CONSISTENT and then break exactly one thing.
 * Starting from a hand-written row would prove nothing, because the refusal
 * under test could be firing on an unrelated inconsistency the fixture happened
 * to carry.
 */

import { WRAP_PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-wrap-intent.js";
import type { WalletWrapIntent } from "@vex-agent/db/repos/wallet-wrap-intents.js";
import type { WrapDirection } from "@vex-agent/tools/internal/wallet/wrap/calldata.js";
import { deriveWrapTransaction } from "@vex-agent/tools/internal/wallet/wrap/calldata.js";
import { renderWrapPreview } from "@vex-agent/tools/internal/wallet/wrap/preview.js";
import { computeWrapProposalDigest } from "@vex-agent/tools/internal/wallet/wrap/proposal-digest.js";
import { getWrappedNativeContract } from "@tools/evm-chains/wrapped-native.js";

/** Base: 8453, whose verified contract this fixture binds. */
export const FIXTURE_CHAIN_ID = 8453;
export const FIXTURE_CHAIN_ALIAS = "base";

export const FIXTURE_FEE_BOUNDS = {
  mode: "eip1559",
  gasLimit: "60000",
  maxFeePerGasWei: "2000000000",
  maxPriorityFeePerGasWei: "1000000000",
  maxTotalFeeWei: "120000000000000",
} as const;

/** The registry's own row for the fixture chain, so the bound identity is the verified one. */
export function fixtureContract(): {
  readonly address: `0x${string}`;
  readonly symbol: string;
  readonly decimals: number;
} {
  const entry = getWrappedNativeContract(FIXTURE_CHAIN_ID);
  if (entry === undefined) {
    throw new Error(`the fixture chain ${FIXTURE_CHAIN_ID} is no longer in the verified registry`);
  }
  return { address: entry.address, symbol: entry.symbol, decimals: entry.decimals };
}

/**
 * A CONSISTENT pending row: payload derived, card rendered and digest computed
 * from the very fields stored beside them.
 */
export function consistentWrapIntent(
  overrides: Partial<WalletWrapIntent> = {},
  options: {
    readonly direction?: WrapDirection;
    readonly amountRaw?: string;
    readonly expiresAt?: string;
  } = {},
): WalletWrapIntent {
  const direction = options.direction ?? "wrap";
  const amountRaw = options.amountRaw ?? "1500000000000000000";
  const expiresAt = options.expiresAt ?? "2099-01-01T00:00:00.000Z";
  const contract = fixtureContract();
  const intentId = "11111111-1111-4111-8111-111111111111";
  const walletAddress = "0x1111111111111111111111111111111111111111";

  const registryEntry = getWrappedNativeContract(FIXTURE_CHAIN_ID);
  if (registryEntry === undefined) throw new Error("missing registry entry");
  const payload = deriveWrapTransaction({
    direction,
    contract: registryEntry,
    amountRaw: BigInt(amountRaw),
  });

  const digestInput = {
    intentId,
    walletAddress,
    chainAlias: FIXTURE_CHAIN_ALIAS,
    chainId: FIXTURE_CHAIN_ID,
    direction,
    contract,
    amountRaw,
    payload,
    feeBounds: FIXTURE_FEE_BOUNDS,
    expiresAt,
  };

  return {
    intentId,
    sessionId: "session-1",
    walletAddress,
    chainAlias: FIXTURE_CHAIN_ALIAS,
    chainId: FIXTURE_CHAIN_ID,
    direction,
    contract,
    amountRaw,
    payload,
    preview: renderWrapPreview(digestInput),
    feeBounds: FIXTURE_FEE_BOUNDS,
    proposalDigest: computeWrapProposalDigest(digestInput).digest,
    proposalDigestVersion: WRAP_PROPOSAL_DIGEST_VERSION,
    status: "pending",
    failureStage: null,
    activityId: null,
    expiresAt,
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}
