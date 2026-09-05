import { getAddress } from "viem";
import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import type { LighterTxFromL1Response } from "@tools/lighter/types.js";
import * as intents from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import * as nonceState from "@vex-agent/db/repos/lighter-nonce-state.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import {
  resolveSelectedAddress,
  resolveSigningWallet,
} from "@vex-agent/tools/internal/wallet/resolve.js";
import {
  configureLighterFeeAuthorizationService,
  type LighterFeeAuthorizationExecutionInput,
  type LighterFeeAuthorizationResult,
} from "@vex-agent/tools/protocols/lighter/fee-authorization-execution.js";
import {
  inspectLighterFeeAuthorization,
  prepareLighterFeeAuthorization,
  readLighterFeeAuthorizationSetup,
  type LighterFeeAuthorizationObserved,
} from "./fee-authorization-preparation.js";
import { signApprovedLighterFeeAuthorization } from "./fee-authorization-signing.js";

type Intent = intents.LighterFeeAuthorizationIntentRow;
const SIGNED_TX_TTL_MS = 4 * 60_000;
const EXPIRY_SAFETY_MS = 60_000;

export interface LighterFeeAuthorizationExecutionDeps {
  readonly client: Pick<
    LighterClient,
    "getNextNonce" | "sendTx" | "changeAccountTier" | "getTx"
  >;
  readonly readIntent: typeof intents.findLighterFeeAuthorizationIntent;
  readonly readSetup: typeof readLighterFeeAuthorizationSetup;
  readonly transition: typeof transition;
  readonly reserveSigning: typeof reserveSigning;
  readonly recordNonce: typeof nonceState.recordExecutionObserved;
  readonly releaseNonce: typeof nonceState.releaseReservation;
  readonly resolveWallet: typeof resolveSigningWallet;
  readonly selectedAddress: typeof resolveSelectedAddress;
  readonly sign: typeof signApprovedLighterFeeAuthorization;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly attempts: number;
}

function defaultDeps(): LighterFeeAuthorizationExecutionDeps {
  return {
    client: getLighterClient(),
    readIntent: intents.findLighterFeeAuthorizationIntent,
    readSetup: readLighterFeeAuthorizationSetup,
    transition,
    reserveSigning,
    recordNonce: nonceState.recordExecutionObserved,
    releaseNonce: nonceState.releaseReservation,
    resolveWallet: resolveSigningWallet,
    selectedAddress: resolveSelectedAddress,
    sign: signApprovedLighterFeeAuthorization,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts: 5,
  };
}

async function transition(
  intent: Intent,
  nextState: intents.LighterFeeAuthorizationState,
  details: { readonly txHash?: string; readonly failureReason?: string } = {},
): Promise<Intent> {
  const updated = await withSessionControlLock(intent.sessionId, (client) =>
    intents.transitionLighterFeeAuthorizationWith(client, {
      intentId: intent.intentId,
      sessionId: intent.sessionId,
      expectedStates: [intent.executionState],
      nextState,
      ...details,
    }),
  );
  if (!updated)
    throw new Error(
      "Fee authorization changed during execution. Check its status before retrying.",
    );
  return updated;
}

async function reserveSigning(
  intent: Intent,
  expiryMs: number,
): Promise<Intent> {
  return withTransaction(async (client) => {
    const nonce = await nonceState.reserveObservedWith(client, {
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      reservationId: `lighter-fees:${intent.intentId}`,
    });
    if (
      !nonce ||
      nonce.status !== "reserved" ||
      nonce.reservedNonce === null ||
      nonce.reservationId !== `lighter-fees:${intent.intentId}`
    ) {
      throw new Error(
        "Another Lighter transaction owns this account's next nonce. Check its status before fee setup.",
      );
    }
    const updated = await intents.transitionLighterFeeAuthorizationWith(
      client,
      {
        intentId: intent.intentId,
        sessionId: intent.sessionId,
        expectedStates: ["approved", "tier_ready"],
        nextState: "signing",
        nonceValue: nonce.reservedNonce,
        txExpiryMs: expiryMs,
      },
    );
    if (!updated)
      throw new Error(
        "The fee authorization could not reserve its signing attempt.",
      );
    return updated;
  });
}

function assertObservedIntent(
  intent: Intent,
  observed: LighterFeeAuthorizationObserved,
): void {
  const p = observed.policy,
    t = intent.terms;
  if (
    observed.accountIndex !== intent.accountIndex ||
    observed.apiKeyIndex !== intent.apiKeyIndex ||
    observed.publicKey !== t.publicKey ||
    getAddress(observed.walletAddress) !== getAddress(intent.walletAddress) ||
    p.collectorAccountIndex !== t.collectorAccountIndex ||
    p.collectorL1Address.toLowerCase() !== t.collectorL1Address.toLowerCase() ||
    (!t.revoke &&
      (p.perpsMakerFee !== t.maxPerpsMakerFee ||
        p.perpsTakerFee !== t.maxPerpsTakerFee ||
        p.spotMakerFee !== t.maxSpotMakerFee ||
        p.spotTakerFee !== t.maxSpotTakerFee))
  ) {
    throw new Error(
      "The trading account, collector or fee policy changed after approval. Prepare a fresh fee authorization.",
    );
  }
}

export function assertLighterApprovedFeeTier(
  intent: Intent,
  observed: LighterFeeAuthorizationObserved,
): void {
  if (intent.terms.revoke) return;
  const tier = observed.limits.user_tier.toLowerCase();
  const expected = intent.terms.targetTier ?? intent.terms.currentTier;
  if (
    tier !== expected ||
    (tier !== "plus" && tier !== "premium") ||
    observed.limits.current_maker_fee_tick >
      intent.terms.exchangeMakerFeeTick ||
    observed.limits.current_taker_fee_tick > intent.terms.exchangeTakerFeeTick
  ) {
    throw new Error(
      "Lighter's account tier or exchange fees differ from the approved terms. Review a new fee setup before continuing.",
    );
  }
}

export function lighterFeeAuthorizationObserved(
  intent: Intent,
  observed: LighterFeeAuthorizationObserved,
): boolean {
  const entries = observed.account.approved_integrators;
  if (!Array.isArray(entries)) return false;
  const matching = entries.filter(
    (row) => row.account_index === intent.terms.collectorAccountIndex,
  );
  if (matching.length > 1) return false;
  const entry = matching[0],
    t = intent.terms;
  if (t.revoke)
    return (
      entry === undefined ||
      (entry.approval_expiry === 0 &&
        entry.max_perps_maker_fee === 0 &&
        entry.max_perps_taker_fee === 0 &&
        entry.max_spot_maker_fee === 0 &&
        entry.max_spot_taker_fee === 0)
    );
  return (
    entry !== undefined &&
    entry.approval_expiry === t.authorizationExpiryMs &&
    entry.max_perps_maker_fee === t.maxPerpsMakerFee &&
    entry.max_perps_taker_fee === t.maxPerpsTakerFee &&
    entry.max_spot_maker_fee === t.maxSpotMakerFee &&
    entry.max_spot_taker_fee === t.maxSpotTakerFee
  );
}

export async function executeApprovedLighterFeeAuthorization(
  input: LighterFeeAuthorizationExecutionInput,
  deps: LighterFeeAuthorizationExecutionDeps = defaultDeps(),
): Promise<LighterFeeAuthorizationResult> {
  let intent = await readOwnedIntent(input, deps);
  if (!["approved", "tier_ready"].includes(intent.executionState))
    return reconcileLighterFeeAuthorization(input, deps);
  if (intent.expiresAt.getTime() <= deps.now())
    throw new Error(
      "The fee approval expired before execution. Prepare a new authorization.",
    );
  let observed = await deps.readSetup(
    {
      ...input,
      environment: intent.environment,
    },
    undefined,
    intent.terms.revoke ? intent : undefined,
  );
  assertObservedIntent(intent, observed);
  assertNotAborted(input);
  const target = intent.terms.targetTier;
  if (target && observed.limits.user_tier.toLowerCase() !== target) {
    if (
      intent.executionState !== "approved" ||
      observed.limits.user_tier.toLowerCase() !== intent.terms.currentTier
    ) {
      throw new Error(
        "The account tier changed after approval. Review a fresh fee authorization.",
      );
    }
    intent = await deps.transition(intent, "tier_change_staged");
    try {
      if (input.abortSignal?.aborted) {
        intent = await deps.transition(intent, "failed", {
          failureReason: "aborted_before_tier_change",
        });
        return result(intent, "failed");
      }
      const changed = await deps.client.changeAccountTier(
        intent.environment,
        { accountIndex: intent.accountIndex, newTier: target },
        observed.auth,
      );
      if (changed.code !== 200) {
        intent = await deps.transition(intent, "failed", {
          failureReason: "tier_change_rejected",
        });
        return result(intent, "failed");
      }
      observed = await deps.readSetup({
        ...input,
        environment: intent.environment,
      });
      assertObservedIntent(intent, observed);
      assertLighterApprovedFeeTier(intent, observed);
      intent = await deps.transition(intent, "tier_ready");
    } catch (error) {
      if (intent.executionState === "tier_change_staged") {
        const status =
          typeof error === "object" && error !== null && "httpStatus" in error
            ? error.httpStatus
            : undefined;
        const rejected =
          (typeof status === "number" && status >= 400 && status < 500) ||
          observed.limits.user_tier.toLowerCase() === target;
        intent = await deps.transition(
          intent,
          rejected ? "failed" : "ambiguous",
          {
            failureReason: rejected
              ? "tier_change_rejected"
              : "tier_change_outcome_unknown",
          },
        );
      }
      return result(
        intent,
        intent.executionState === "failed" ? "failed" : "pending_verification",
      );
    }
  }
  assertLighterApprovedFeeTier(intent, observed);
  if (
    !intent.terms.revoke &&
    !Array.isArray(observed.account.approved_integrators)
  ) {
    throw new Error(
      "Lighter did not return fee-authorization evidence. Nothing was signed.",
    );
  }
  if (intent.expiresAt.getTime() <= deps.now())
    throw new Error(
      "The fee approval expired during verification. Review a fresh approval.",
    );
  assertNotAborted(input);
  const next = await deps.client.getNextNonce(intent.environment, {
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
  });
  if (
    next.code !== 200 ||
    !Number.isSafeInteger(next.nonce) ||
    next.nonce < 0 ||
    next.nonce >= 2 ** 48
  )
    throw new Error("The Lighter transaction nonce could not be verified.");
  const observedNonce = await deps.recordNonce({
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    nonce: next.nonce,
    publicKey: intent.terms.publicKey,
  });
  if (!observedNonce)
    throw new Error(
      "A previous Lighter transaction is unresolved. Check its status before authorizing fees.",
    );
  // Committing this state before signing makes an interrupted attempt strictly
  // reconciliation-only, including crashes before a signed hash is persisted.
  assertNotAborted(input);
  intent = await deps.reserveSigning(intent, deps.now() + SIGNED_TX_TTL_MS);
  let signed: Awaited<ReturnType<typeof signApprovedLighterFeeAuthorization>>;
  try {
    const wallet = deps.resolveWallet(
      input.walletResolution,
      input.walletPolicy,
      "eip155",
    );
    if (wallet.family !== "eip155")
      throw new Error("An EVM wallet is required.");
    assertNotAborted(input);
    signed = await deps.sign({ intent, wallet });
  } catch {
    intent = await deps.transition(intent, "ambiguous", {
      failureReason: "signing_outcome_unknown",
    });
    return result(intent, "pending_verification");
  }
  intent = await deps.transition(intent, "submission_staged", {
    txHash: signed.txHash,
  });
  if (input.abortSignal?.aborted) {
    intent = await deps.transition(intent, "ambiguous", {
      failureReason: "aborted_before_submission",
    });
    return result(intent, "pending_verification");
  }
  try {
    const response = await deps.client.sendTx(intent.environment, {
      txType: signed.txType,
      txInfo: signed.txInfo,
    });
    if (
      response.code !== 200 ||
      response.tx_hash?.toLowerCase().replace(/^0x/, "") !== intent.txHash
    ) {
      intent = await deps.transition(intent, "ambiguous", {
        failureReason: "submission_response_unconfirmed",
      });
    } else {
      intent = await deps.transition(intent, "submitted");
    }
  } catch {
    intent = await deps.transition(intent, "ambiguous", {
      failureReason: "submission_outcome_unknown",
    });
  }
  return reconcileLighterFeeAuthorization(input, deps);
}

async function readOwnedIntent(
  input: LighterFeeAuthorizationExecutionInput,
  deps: LighterFeeAuthorizationExecutionDeps,
): Promise<Intent> {
  const intent = await deps.readIntent(input.intentId);
  if (
    !intent ||
    intent.sessionId !== input.sessionId ||
    intent.approvalStatus !== "approved" ||
    !intent.approvalId ||
    getAddress(
      deps.selectedAddress(
        input.walletResolution,
        input.walletPolicy,
        "eip155",
      ),
    ) !== getAddress(intent.walletAddress)
  ) {
    throw new Error(
      "The fee authorization is not approved for this session and selected wallet.",
    );
  }
  return intent;
}

export async function reconcileLighterFeeAuthorization(
  input: LighterFeeAuthorizationExecutionInput,
  deps: LighterFeeAuthorizationExecutionDeps = defaultDeps(),
): Promise<LighterFeeAuthorizationResult> {
  let intent = await readOwnedIntent(input, deps);
  if (intent.executionState === "failed") return result(intent, "failed");
  if (["approved", "tier_ready"].includes(intent.executionState))
    return result(intent, "pending_verification");
  for (let attempt = 0; attempt < deps.attempts; attempt++) {
    if (input.abortSignal?.aborted) break;
    const observed = await deps.readSetup(
      {
        ...input,
        environment: intent.environment,
      },
      undefined,
      intent,
    );
    assertObservedIntent(intent, observed);
    if (intent.nonceValue === null) {
      if (intent.terms.targetTier === observed.limits.user_tier.toLowerCase()) {
        try {
          assertLighterApprovedFeeTier(intent, observed);
        } catch {
          intent = await deps.transition(intent, "failed", {
            failureReason: "exchange_fees_changed",
          });
          return result(intent, "failed");
        }
        intent = await deps.transition(intent, "tier_ready");
      } else if (
        deps.now() > intent.expiresAt.getTime() &&
        observed.limits.user_tier.toLowerCase() === intent.terms.currentTier
      ) {
        intent = await deps.transition(intent, "failed", {
          failureReason: "tier_change_not_confirmed",
        });
        return result(intent, "failed");
      }
      return result(intent, "pending_verification");
    }
    const next = await deps.client.getNextNonce(intent.environment, {
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
    });
    if (next.code !== 200 || !Number.isSafeInteger(next.nonce))
      return result(intent, "pending_verification");
    if (
      intent.txHash !== null &&
      lighterFeeAuthorizationObserved(intent, observed) &&
      BigInt(next.nonce) > BigInt(intent.nonceValue) &&
      Array.isArray(observed.account.approved_integrators)
    ) {
      assertLighterApprovedFeeTier(intent, observed);
      await deps.recordNonce({
        environment: intent.environment,
        accountIndex: intent.accountIndex,
        apiKeyIndex: intent.apiKeyIndex,
        nonce: next.nonce,
        publicKey: intent.terms.publicKey,
      });
      if (intent.executionState !== "active")
        intent = await deps.transition(intent, "active");
      return result(intent, intent.terms.revoke ? "revoked" : "active");
    }
    if (
      intent.txExpiryMs !== null &&
      deps.now() > intent.txExpiryMs + EXPIRY_SAFETY_MS &&
      String(next.nonce) === intent.nonceValue
    ) {
      await deps.releaseNonce({
        environment: intent.environment,
        accountIndex: intent.accountIndex,
        apiKeyIndex: intent.apiKeyIndex,
        reservationId: `lighter-fees:${intent.intentId}`,
        providerNonce: next.nonce,
      });
      intent = await deps.transition(intent, "failed", {
        failureReason: "expired_without_nonce_consumption",
      });
      return result(intent, "failed");
    }
    if (
      intent.txExpiryMs !== null &&
      deps.now() > intent.txExpiryMs + EXPIRY_SAFETY_MS &&
      BigInt(next.nonce) > BigInt(intent.nonceValue) &&
      Array.isArray(observed.account.approved_integrators)
    ) {
      let exactExecuted = false;
      if (intent.txHash) {
        try {
          exactExecuted = exactExecutedFeeTransaction(
            intent,
            await deps.client.getTx(intent.environment, {
              by: "hash",
              value: intent.txHash,
            }),
          );
        } catch {
          /* Exact current allowance and an advanced nonce remain the recovery authority. */
        }
      }
      await deps.recordNonce({
        environment: intent.environment,
        accountIndex: intent.accountIndex,
        apiKeyIndex: intent.apiKeyIndex,
        nonce: next.nonce,
        publicKey: intent.terms.publicKey,
      });
      intent = await deps.transition(intent, "failed", {
        failureReason: exactExecuted
          ? "authorization_changed_after_execution"
          : "authorization_not_confirmed_after_expiry",
      });
      return result(intent, "failed");
    }
    if (attempt + 1 < deps.attempts) await deps.sleep(750);
  }
  return result(intent, "pending_verification");
}

function result(
  intent: Intent,
  status: LighterFeeAuthorizationResult["status"],
): LighterFeeAuthorizationResult {
  const message =
    status === "active"
      ? "Lighter confirmed VEX's spot and perpetual fee authorization. Future trades keep their normal approval requirement."
      : status === "revoked"
        ? "Lighter confirmed revocation of VEX's fee authorization."
        : status === "failed"
          ? "Fee setup did not establish the approved authorization. Prepare a fresh approval to continue; VEX did not retry the transaction."
          : intent.executionState === "tier_ready"
            ? "Lighter confirmed the account tier. Prepare fee setup again to approve its remaining authorization."
            : "The fee setup outcome is pending verification. VEX will check provider evidence without signing or submitting again.";
  return {
    source: "vex_lighter_fee_authorization",
    status,
    intentId: intent.intentId,
    executionState: intent.executionState,
    txHash: intent.txHash,
    message,
  };
}

function assertNotAborted(input: LighterFeeAuthorizationExecutionInput): void {
  if (input.abortSignal?.aborted)
    throw new Error("Fee setup was stopped before the next action.");
}

export function exactExecutedFeeTransaction(
  intent: Intent,
  tx: LighterTxFromL1Response,
): boolean {
  if (
    tx.code !== 200 ||
    tx.status !== 3 ||
    tx.type !== 45 ||
    tx.hash.toLowerCase().replace(/^0x/, "") !== intent.txHash ||
    tx.account_index !== intent.accountIndex ||
    tx.api_key_index !== intent.apiKeyIndex ||
    String(tx.nonce) !== intent.nonceValue ||
    tx.expire_at !== intent.txExpiryMs
  )
    return false;
  try {
    const info = JSON.parse(tx.info) as Record<string, unknown>,
      t = intent.terms;
    const expected = {
      AccountIndex: intent.accountIndex,
      ApiKeyIndex: intent.apiKeyIndex,
      Nonce: Number(intent.nonceValue),
      ExpiredAt: intent.txExpiryMs,
      IntegratorAccountIndex: t.collectorAccountIndex,
      MaxPerpsMakerFee: t.maxPerpsMakerFee,
      MaxPerpsTakerFee: t.maxPerpsTakerFee,
      MaxSpotMakerFee: t.maxSpotMakerFee,
      MaxSpotTakerFee: t.maxSpotTakerFee,
      ApprovalExpiry: t.authorizationExpiryMs,
    };
    return (
      info !== null &&
      typeof info === "object" &&
      Object.entries(expected).every(([key, value]) => info[key] === value)
    );
  } catch {
    return false;
  }
}

export function installLighterFeeAuthorizationService(): () => void {
  return configureLighterFeeAuthorizationService({
    inspect: inspectLighterFeeAuthorization,
    prepare: prepareLighterFeeAuthorization,
    execute: executeApprovedLighterFeeAuthorization,
    reconcile: reconcileLighterFeeAuthorization,
  });
}
