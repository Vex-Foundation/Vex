/**
 * The DESKTOP two-stage launch: `prepare`, `deploy`, `cancel`.
 *
 * These are the implementations behind three of the published runtime-contract
 * function types, and they are bound to those types so main and the runtime
 * cannot drift.
 *
 * WHY TWO STAGES. The token's final address is only knowable once the image is
 * pinned (image -> metadataUri -> salt -> CREATE2 address), so the address the
 * user approves has to come from a REAL prepare rather than a prediction. Stage
 * 1 uploads the image once, prepares, and runs all 13 verifier points; it
 * authorizes nothing and signs nothing. Stage 2 consumes the opaque handle,
 * takes the C0 authorization over that exact calldata+value fingerprint, and
 * hands the staged broadcaster those bytes and nothing else.
 *
 * THE FORM IS THE APPROVAL. Deploy's authorization kind is `user_submit`: the
 * human saw the final token address, the resolved recipient and the exact costs,
 * and clicked. There is no approval card for this path and there must never be
 * two consent surfaces for one launch.
 *
 * NO CEILINGS APPLY HERE, deliberately. The mission ceilings bound UNATTENDED
 * spending against a host-authored contract; a human clicking Deploy is not that
 * situation, exactly as on the agent form path.
 *
 * WHAT STAGE 2 DOES NOT DO IS RE-PREPARE. A second prepare pins a second
 * persistent IPFS object and mines a DIFFERENT salt, so it would describe a
 * different token at a different address. The verification that stands is the
 * one that ran immediately before the entry was stored, over the exact bytes the
 * fingerprint names.
 */

import { getAddress, type Address, type Hex } from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { POOLS_CHAIN_ID } from "@tools/pools-fun/constants.js";
import type { PoolsVerifierViolation } from "@tools/pools-fun/launch/verifier-types.js";
import { openLaunchSigningClients } from "../../shared/launch-signing-clients.js";
import type { ProtocolExecutionContext } from "../../types.js";
import {
  buildPoolsLaunchPlan,
  type BuildPoolsLaunchPlanResult,
  type PoolsLaunchPlan,
} from "../handlers/launch/execute/plan.js";
import {
  authorizeAndConsumePoolsLaunch,
  newPoolsLaunchIds,
  settlePoolsLaunchFailure,
} from "../handlers/launch/execute/authorize.js";
import { broadcastPoolsLaunch } from "../handlers/launch/execute/broadcast.js";
import { readDesktopLaunchInputs } from "./desktop-inputs.js";
import {
  consumePreparedLaunch,
  dropPreparedLaunch,
  storePreparedLaunch,
} from "./fingerprint-store.js";
import type {
  CancelPoolsLaunch,
  DeployPoolsLaunch,
  PoolsAmount,
  PoolsLaunchOutcome,
  PoolsLaunchRefusalKind,
  PreparePoolsLaunch,
} from "./runtime-contract.js";

/** Native ETH, as every amount on this lane identifies it. */
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const NATIVE_DECIMALS = 18;

/**
 * How long a verified fingerprint stays usable.
 *
 * Shorter than the gateway's own deadline on purpose: the deployment fee is
 * dynamic, and a quote a user sat on for a quarter of an hour is a quote worth
 * re-taking rather than signing.
 */
const FINGERPRINT_WINDOW_MS = 10 * 60 * 1000;

function refusal<T>(kind: PoolsLaunchRefusalKind, message: string): PoolsLaunchOutcome<T> {
  return { ok: false, refusal: { kind, message } };
}

function nativeAmount(rawWei: bigint): PoolsAmount {
  return {
    rawWei: rawWei.toString(),
    decimals: NATIVE_DECIMALS,
    assetAddress: NATIVE_ADDRESS,
    assetSymbol: "ETH",
  };
}

/**
 * The signing clients for a desktop deploy.
 *
 * The published `PoolsLaunchSession` carries a session id and an address, not a
 * wallet resolution - so the signer is resolved through the trusted default
 * path (main is the only caller) and then CROSS-CHECKED against the address the
 * plan was verified for. That check is the point: it is what stops a wallet
 * switch between prepare and Deploy from signing a launch that was proven,
 * priced and balance-checked for somebody else's address.
 */
function openDesktopSigner(
  chainConfig: NonNullable<ReturnType<typeof getLocalChain>>,
): ReturnType<typeof openLaunchSigningClients> {
  return openLaunchSigningClients(
    { walletResolution: { source: "default" }, walletPolicy: { kind: "none" } } as ProtocolExecutionContext,
    chainConfig,
  );
}

/** Map a planning refusal onto the closed set of kinds the IPC layer already renders. */
function planRefusalKind(result: Extract<BuildPoolsLaunchPlanResult, { ok: false }>): PoolsLaunchRefusalKind {
  if (result.code === "verifier_refused") return verifierRefusalKind(result.violations ?? []);
  switch (result.code) {
    case "prepare_refused":
    case "anchors_unreadable":
    case "gas_unestimable":
      return "provider_unavailable";
    case "calldata_undecodable":
    case "simulation_failed":
      return "verifier_refused";
    // Unreachable on this path - the desktop form takes no mission ceilings -
    // but mapped rather than defaulted, so adding a ceiling here is a decision
    // rather than an accident.
    case "ceiling_refused":
      return "claim_ceiling_exceeded";
    default:
      return "verifier_refused";
  }
}

/**
 * Which named kind a verifier refusal is, so the app can render the RIGHT state.
 *
 * Read from the structured violations rather than from the message: "your wallet
 * cannot cover this" and "this pair is no longer allowlisted" are different
 * situations with different remedies, and sniffing prose for them would be a
 * parser nobody declared.
 */
function verifierRefusalKind(violations: readonly PoolsVerifierViolation[]): PoolsLaunchRefusalKind {
  const points = new Set(violations.map((violation) => violation.point));
  if (points.has("balance_covers_total")) return "insufficient_funds";
  if (points.has("paired_asset_allowlisted")) return "pair_not_allowlisted";
  return "verifier_refused";
}

// ── Stage 1 ─────────────────────────────────────────────────────────────────

export const preparePoolsLaunch: PreparePoolsLaunch = async (session, inputs) => {
  let walletAddress: Address;
  try {
    walletAddress = getAddress(session.walletAddress);
  } catch {
    return refusal("wallet_unavailable", "No usable wallet address was resolved for this session.");
  }

  const read = readDesktopLaunchInputs(inputs, walletAddress);
  if (!read.ok) return refusal("invalid_inputs", read.reason);

  const chainConfig = getLocalChain(POOLS_CHAIN_ID);
  if (!chainConfig) {
    return refusal(
      "provider_unavailable",
      `Robinhood Chain (${POOLS_CHAIN_ID}) is not in the local chain registry, so nothing can be read or signed.`,
    );
  }

  // The signer is opened at STAGE 1 as well, and only for its public client:
  // the plan's balance and gas checks must describe the wallet that will
  // actually sign, and a wallet that cannot be opened should refuse before an
  // image is uploaded and metadata is pinned.
  const signing = openDesktopSigner(chainConfig);
  if (!signing.ok) {
    return refusal("wallet_unavailable", signing.result.output);
  }
  const signerAddress = signing.clients.walletClient.account.address;
  if (getAddress(signerAddress) !== walletAddress) {
    return refusal(
      "wallet_unavailable",
      `This launch is being prepared for ${walletAddress}, but the wallet that would sign it is `
        + `${getAddress(signerAddress)}. Select the launching wallet and try again.`,
    );
  }

  const planned = await buildPoolsLaunchPlan({
    name: read.value.name,
    symbol: read.value.symbol,
    pairedAsset: read.value.pairedAsset,
    image: read.value.image,
    prebuyWei: read.value.prebuyWei,
    prebuyHuman: read.value.prebuyHuman,
    sessionId: session.sessionId,
    walletAddress,
    feeRecipient: read.value.feeRecipient,
    // The form's Deploy click is the authority; the permission snapshot the
    // binding records is the one that click carries.
    permission: "full",
    publicClient: signing.clients.publicClient,
    ...(read.value.tweetUrl === undefined ? {} : { tweetUrl: read.value.tweetUrl }),
    ...(read.value.websiteUrl === undefined ? {} : { websiteUrl: read.value.websiteUrl }),
  });
  if (!planned.ok) return refusal(planRefusalKind(planned), planned.reason);

  const plan = planned.plan;
  const expiresAtMs = Date.now() + FINGERPRINT_WINDOW_MS;
  const fingerprintId = storePreparedLaunch({
    sessionId: session.sessionId,
    walletAddress,
    plan,
    expiresAtMs,
  });

  return {
    ok: true,
    value: {
      fingerprintId,
      predictedTokenAddress: plan.binding.predictedTokenAddress,
      predictedPoolAddress: plan.predictedPoolAddress,
      resolvedFeeRecipient: plan.binding.feeRecipient,
      pairedAsset: read.value.pairedAsset,
      pairedAssetAddress: plan.binding.pairedAssetAddress,
      costs: {
        deploymentFee: nativeAmount(BigInt(plan.binding.deploymentFeeWei)),
        ...(read.value.prebuyWei === null ? {} : { prebuy: nativeAmount(read.value.prebuyWei) }),
        vexFee: nativeAmount(BigInt(plan.binding.vexFeeWei)),
        gasBound: nativeAmount(BigInt(plan.binding.gasBoundWei)),
        transactionValue: nativeAmount(plan.call.valueWei),
      },
      metadataUri: plan.metadataUri,
      imageLanded: plan.imageLanded,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  };
};

// ── Stage 2 ─────────────────────────────────────────────────────────────────

export const deployPoolsLaunch: DeployPoolsLaunch = async (session, inputs) => {
  // SINGLE USE. The entry is taken OUT of the store here, so a replayed handle,
  // a second Deploy click, a cancelled launch, a lapsed one, and another
  // session's launch all arrive at this same refusal - which is deliberate: a
  // distinct answer for the last of those would confirm that it exists.
  const entry = consumePreparedLaunch(session.sessionId, inputs.fingerprintId);
  if (entry === null) {
    return refusal(
      "fingerprint_expired",
      "This prepared launch is no longer available: it was already deployed, cancelled, or it expired. "
        + "Nothing was signed. Prepare the launch again to get a fresh quote - the launchpad's deployment fee "
        + "moves, so a stale one would fail anyway.",
    );
  }

  const chainConfig = getLocalChain(POOLS_CHAIN_ID);
  if (!chainConfig) {
    return refusal("provider_unavailable", `Robinhood Chain (${POOLS_CHAIN_ID}) is not in the local chain registry.`);
  }

  const signing = openDesktopSigner(chainConfig);
  if (!signing.ok) return refusal("wallet_unavailable", signing.result.output);
  const signerAddress = getAddress(signing.clients.walletClient.account.address);
  if (signerAddress !== entry.walletAddress) {
    // The plan was verified, priced and balance-checked FOR a specific wallet.
    // Signing it with another one would sign a transaction nothing had proven.
    return refusal(
      "wallet_unavailable",
      `This launch was prepared for ${entry.walletAddress}, but the active signing wallet is ${signerAddress}. `
        + "Nothing was signed. Switch back to the launching wallet, or prepare the launch again.",
    );
  }

  const plan: PoolsLaunchPlan = entry.plan;
  const ids = newPoolsLaunchIds();
  const consumed = await authorizeAndConsumePoolsLaunch({
    intentId: ids.intentId,
    authorizationId: ids.authorizationId,
    sessionId: session.sessionId,
    missionRunId: null,
    plan,
    authorizationKind: "user_submit",
    ceilings: null,
    authorization: {
      kind: "user_submit",
      binding: plan.binding,
      submittedAt: new Date().toISOString(),
    },
  });
  if (!consumed.ok) return refusal("verifier_refused", consumed.reason);

  const result = await broadcastPoolsLaunch({
    intentId: ids.intentId,
    sessionId: session.sessionId,
    walletAddress: entry.walletAddress,
    plan,
    params: {
      name: plan.binding.name,
      symbol: plan.binding.symbol,
      pairedAsset: plan.binding.pairedAsset,
      source: "desktop_form",
    },
    publicClient: signing.clients.publicClient,
    walletClient: signing.clients.walletClient,
  });

  const data = (result.data ?? {}) as Record<string, unknown>;
  const status = typeof data.status === "string" ? data.status : "unknown";
  const txHash = typeof data.txHash === "string" ? (data.txHash as Hex) : null;

  if (status === "confirmed" && typeof data.tokenAddress === "string" && txHash !== null) {
    return {
      ok: true,
      value: {
        tokenAddress: getAddress(data.tokenAddress),
        poolAddress: getAddress(String(data.poolAddress)),
        txHash,
        activityId: Number(data._executionId),
        resolvedFeeRecipient: plan.binding.feeRecipient,
      },
    };
  }

  // EVERY OTHER OUTCOME IS A REFUSAL WITH THE REAL STORY, never a thrown error
  // and never a success: pending and reverted are different facts, and a launch
  // that may already be mined must say "do not retry" rather than look failed in
  // a way that invites one. The intent row and the activity row carry the
  // durable state; this is only what the click is told.
  if (status === "pending" || status === "confirmed_pending_identity") {
    return refusal(
      "provider_unavailable",
      `${result.output} Your launch is recorded and resolves automatically.`,
    );
  }
  if (status === "reverted") {
    return refusal("verifier_refused", result.output);
  }
  await settlePoolsLaunchFailure(ids.intentId, session.sessionId, "DeployOutcomeUnknown");
  return refusal("provider_unavailable", result.output);
};

// ── Cancel ──────────────────────────────────────────────────────────────────

export const cancelPoolsLaunch: CancelPoolsLaunch = async (session, inputs) => {
  // Dropping a prepared launch is local and total: the entry is gone, so a later
  // Deploy click for the same handle finds nothing. Nothing on-chain happened at
  // stage 1, so there is nothing else to undo - the metadata the prepare pinned
  // stays pinned at the provider, which is the provider's object and not a Vex
  // state.
  const cancelled = dropPreparedLaunch(session.sessionId, inputs.fingerprintId);
  return { ok: true, value: { cancelled } };
};
