/**
 * Main-side POOLS.FUN LAUNCH owner — the module the IPC handlers call.
 *
 * Repo law: IPC handlers do not import `@vex-agent` directly, so this layer owns
 * the DTO mapping and the runtime calls and the handler file stays a thin,
 * auditable boundary that validates, authorizes, logs and returns `Result`. Same
 * shape as `main/token-launch/index.ts`, for the same reasons.
 *
 * WHAT MAIN OWNS HERE, in C0 terms: the SESSION and the WALLET. `PoolsLaunchSession`
 * is derived on THIS side from the session id in the validated payload — the
 * renderer never names a wallet address, and there is no field in the contract
 * through which it could. Everything that becomes a spend (the gateway's dynamic
 * deployment fee, `msg.value`, the calldata) is derived deeper still, inside the
 * runtime's verifier.
 *
 * THE RENDERER'S TYPED AMOUNT is the one user-authored number that crosses:
 * `prebuy.amountHuman`, the plain decimal the user typed. It is converted ONCE,
 * inside the runtime's prepare, against the pair's on-chain decimals. It is
 * never treated as raw here and never pre-scaled by the renderer.
 */

import type {
  PoolsAmount as RuntimePoolsAmount,
  PoolsLaunchImage,
  PoolsLaunchInputs,
  PoolsLaunchRefusal,
  PoolsLaunchSession,
} from "@vex-agent/tools/protocols/pools/launch/runtime-contract.js";
import type {
  PoolsAmount,
  PoolsClaimedFees,
  PoolsClaimPreview,
  PoolsDeployedLaunch,
  PoolsLaunchFormInput,
  PoolsLaunchMyLaunchesResult,
  PoolsLaunchGetAwaitingResult,
  PoolsPreparedLaunch,
} from "@shared/schemas/pools-launch.js";
import { getSessionWalletScope } from "../database/sessions-db.js";
import { getPoolsLaunchRuntime, type PoolsLaunchRuntime } from "./runtime.js";

/** A refusal in main's own vocabulary, carrying the runtime's real message. */
export interface PoolsLaunchRefusalOutcome {
  readonly kind: PoolsLaunchRefusal["kind"] | "no_wallet";
  readonly detail: string;
}

export type PoolsLaunchOperationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: PoolsLaunchRefusalOutcome };

/**
 * Resolve the session's wallet, or refuse.
 *
 * WALLET SCOPE IS SERVER-RESOLVED, always. The renderer sends a session id and
 * nothing else; the address comes from the session's own selection, and its keys
 * never come near this read.
 */
async function resolveSession(
  sessionId: string,
): Promise<PoolsLaunchOperationOutcome<PoolsLaunchSession>> {
  const scope = await getSessionWalletScope(sessionId);
  if (!scope.ok) {
    return {
      ok: false,
      refusal: {
        kind: "wallet_unavailable",
        detail:
          "Vex could not read this session's wallet selection. Check that Vex services are "
          + "running and try again. Nothing was signed.",
      },
    };
  }
  const evm = scope.data.evm;
  if (evm === null) {
    return {
      ok: false,
      refusal: {
        kind: "no_wallet",
        detail:
          "No EVM wallet is selected for this session, so there is no account to launch from. "
          + "Pick one in the session's wallet card and try again.",
      },
    };
  }
  return {
    ok: true,
    value: { sessionId, walletAddress: evm.address as `0x${string}` },
  };
}

/**
 * Run one runtime call with the session and runtime already resolved.
 *
 * The runtime answers `{ok, value|refusal}` and never throws across the
 * boundary, so a THROW here is our own bug, not a refusal — it is left to the
 * handler's catch, which reports it structurally without leaking a message.
 */
async function withRuntime<T>(
  sessionId: string,
  call: (
    runtime: PoolsLaunchRuntime,
    session: PoolsLaunchSession,
  ) => Promise<
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: PoolsLaunchRefusal }
  >,
): Promise<PoolsLaunchOperationOutcome<T>> {
  const session = await resolveSession(sessionId);
  if (!session.ok) return session;

  const outcome = await call(getPoolsLaunchRuntime(), session.value);
  return outcome.ok
    ? { ok: true, value: outcome.value }
    : { ok: false, refusal: { kind: outcome.refusal.kind, detail: outcome.refusal.message } };
}

/** A runtime amount → the wire DTO. Raw and decimals always travel together. */
function toAmount(amount: RuntimePoolsAmount): PoolsAmount {
  return {
    rawWei: amount.rawWei,
    decimals: amount.decimals,
    assetAddress: amount.assetAddress,
    assetSymbol: amount.assetSymbol,
  };
}

/**
 * The renderer's form → the runtime's logical inputs.
 *
 * The image is a near-identity map: the wire union and the runtime union are the
 * same two branches, deliberately, so there is no place here to conflate them or
 * to invent a precedence rule. `null` on the wire becomes `undefined` inward,
 * which is the one way "no image" is spelled — the runtime then reports
 * `imageLanded: false` rather than failing quietly.
 */
function toLaunchInputs(form: PoolsLaunchFormInput): PoolsLaunchInputs {
  const image: PoolsLaunchImage | undefined =
    form.image === null
      ? undefined
      : form.image.kind === "locker"
        ? { kind: "locker", imageId: form.image.imageId }
        : { kind: "url", url: form.image.url };

  return {
    name: form.name,
    symbol: form.symbol,
    pairedAsset: form.pairedAsset,
    image,
    tweetUrl: form.tweetUrl ?? undefined,
    websiteUrl: form.websiteUrl ?? undefined,
    prebuy: form.prebuy === null ? undefined : { amountHuman: form.prebuy.amountHuman },
    // The schema proved the SHAPE of the address; the runtime's type wants the
    // template literal. Narrowing here keeps the assertion in one place instead
    // of spreading `0x${string}` through the wire DTOs.
    feeRecipient:
      form.feeRecipient.kind === "address"
        ? { kind: "address", address: form.feeRecipient.address as `0x${string}` }
        : form.feeRecipient,
  };
}

// ── The seven operations ────────────────────────────────────────────────────

export async function preparePoolsLaunch(input: {
  readonly sessionId: string;
  readonly form: PoolsLaunchFormInput;
}): Promise<PoolsLaunchOperationOutcome<PoolsPreparedLaunch>> {
  const inputs = toLaunchInputs(input.form);
  return withRuntime(input.sessionId, async (runtime, session) => {
    const outcome = await runtime.prepare(session, inputs);
    if (!outcome.ok) return outcome;
    const prepared = outcome.value;
    return {
      ok: true,
      value: {
        fingerprintId: prepared.fingerprintId,
        predictedTokenAddress: prepared.predictedTokenAddress,
        predictedPoolAddress: prepared.predictedPoolAddress,
        resolvedFeeRecipient: prepared.resolvedFeeRecipient,
        pairedAsset: prepared.pairedAsset,
        pairedAssetAddress: prepared.pairedAssetAddress,
        costs: {
          deploymentFee: toAmount(prepared.costs.deploymentFee),
          prebuy:
            prepared.costs.prebuy === undefined ? null : toAmount(prepared.costs.prebuy),
          vexFee: toAmount(prepared.costs.vexFee),
          gasBound: toAmount(prepared.costs.gasBound),
          transactionValue: toAmount(prepared.costs.transactionValue),
        },
        metadataUri: prepared.metadataUri,
        imageLanded: prepared.imageLanded,
        expiresAt: prepared.expiresAt,
      },
    };
  });
}

export async function deployPoolsLaunch(input: {
  readonly sessionId: string;
  readonly fingerprintId: string;
}): Promise<PoolsLaunchOperationOutcome<PoolsDeployedLaunch>> {
  return withRuntime(input.sessionId, async (runtime, session) => {
    const outcome = await runtime.deploy(session, { fingerprintId: input.fingerprintId });
    if (!outcome.ok) return outcome;
    const launched = outcome.value;
    return {
      ok: true,
      value: {
        tokenAddress: launched.tokenAddress,
        poolAddress: launched.poolAddress,
        txHash: launched.txHash,
        activityId: launched.activityId,
        resolvedFeeRecipient: launched.resolvedFeeRecipient,
        // Main authors the sentence the dialog shows verbatim. It names the
        // token and the recipient because those are the two facts a user needs
        // to check afterwards; the hash is reachable from the activity row.
        message:
          `Launched ${launched.tokenAddress}. Trading fees go to `
          + `${launched.resolvedFeeRecipient}.`,
      },
    };
  });
}

export async function cancelPoolsLaunch(input: {
  readonly sessionId: string;
  readonly fingerprintId: string;
}): Promise<PoolsLaunchOperationOutcome<{ readonly cancelled: boolean }>> {
  return withRuntime(input.sessionId, (runtime, session) =>
    runtime.cancel(session, { fingerprintId: input.fingerprintId }),
  );
}

export async function previewPoolsClaim(input: {
  readonly sessionId: string;
  readonly tokenAddress: string;
}): Promise<PoolsLaunchOperationOutcome<PoolsClaimPreview>> {
  return withRuntime(input.sessionId, async (runtime, session) => {
    const outcome = await runtime.previewClaim(session, {
      tokenAddress: input.tokenAddress as `0x${string}`,
    });
    if (!outcome.ok) return outcome;
    const preview = outcome.value;
    return {
      ok: true,
      value: {
        tokenAddress: preview.tokenAddress,
        tokenLeg: toAmount(preview.tokenLeg),
        pairedLeg: toAmount(preview.pairedLeg),
        alreadyCollected: {
          tokenLeg: toAmount(preview.alreadyCollected.tokenLeg),
          pairedLeg: toAmount(preview.alreadyCollected.pairedLeg),
        },
        gasBound: toAmount(preview.gasBound),
      },
    };
  });
}

export async function claimPoolsFees(input: {
  readonly sessionId: string;
  readonly tokenAddress: string;
}): Promise<PoolsLaunchOperationOutcome<PoolsClaimedFees>> {
  return withRuntime(input.sessionId, async (runtime, session) => {
    const outcome = await runtime.claim(session, {
      tokenAddress: input.tokenAddress as `0x${string}`,
    });
    if (!outcome.ok) return outcome;
    const claimed = outcome.value;
    return {
      ok: true,
      value: {
        tokenAddress: claimed.tokenAddress,
        txHash: claimed.txHash,
        activityId: claimed.activityId,
        tokenLeg: toAmount(claimed.tokenLeg),
        pairedLeg: toAmount(claimed.pairedLeg),
        // BOTH legs are named. A claim that reported one asset would hide half
        // of what the user just received.
        message:
          `Claimed ${claimed.tokenLeg.rawWei} ${claimed.tokenLeg.assetSymbol} and `
          + `${claimed.pairedLeg.rawWei} ${claimed.pairedLeg.assetSymbol} (raw amounts).`,
      },
    };
  });
}

export async function listPoolsMyLaunches(input: {
  readonly sessionId: string;
  readonly limit?: number | undefined;
  readonly includeClaimable?: boolean | undefined;
}): Promise<PoolsLaunchOperationOutcome<PoolsLaunchMyLaunchesResult>> {
  return withRuntime(input.sessionId, async (runtime, session) => {
    const outcome = await runtime.myLaunches(session, {
      limit: input.limit,
      includeClaimable: input.includeClaimable,
    });
    if (!outcome.ok) return outcome;
    return {
      ok: true,
      value: {
        wallet: outcome.value.wallet,
        launches: outcome.value.launches.map((row) => ({
          tokenAddress: row.tokenAddress,
          poolAddress: row.poolAddress,
          name: row.name,
          symbol: row.symbol,
          pairedAsset: row.pairedAsset,
          launchedAt: row.launchedAt,
          txHash: row.txHash,
          feeRecipient: row.feeRecipient,
          // ABSENT becomes NULL, and null means NOT MEASURED — never "nothing
          // to claim". Collapsing the two would tell a user with unclaimed fees
          // that they have none.
          claimable:
            row.claimable === undefined
              ? null
              : {
                  tokenLeg: toAmount(row.claimable.tokenLeg),
                  pairedLeg: toAmount(row.claimable.pairedLeg),
                },
        })),
      },
    };
  });
}

/**
 * The launch form an agent drafted and is parked on, or `null`.
 *
 * `null` is the ORDINARY case and is returned as a SUCCESS. An idle session is
 * not an error, and mapping "nothing waiting" onto a refusal would make every
 * poll of a quiet session look like a failure.
 */
export async function getAwaitingPoolsLaunchForm(input: {
  readonly sessionId: string;
}): Promise<PoolsLaunchOperationOutcome<PoolsLaunchGetAwaitingResult>> {
  return withRuntime<PoolsLaunchGetAwaitingResult>(input.sessionId, async (runtime, session) => {
    const outcome = await runtime.getAwaiting(session);
    if (!outcome.ok) return outcome;
    const awaiting = outcome.value;
    if (awaiting === null) return { ok: true, value: { awaiting: null } };
    return {
      ok: true,
      value: {
        awaiting: {
          intentId: awaiting.intentId,
          expiresAt: awaiting.expiresAt,
          proposed: {
            name: awaiting.proposed.name,
            symbol: awaiting.proposed.symbol,
            pairedAsset: awaiting.proposed.pairedAsset,
            image: awaiting.proposed.image,
            tweetUrl: awaiting.proposed.tweetUrl,
            websiteUrl: awaiting.proposed.websiteUrl,
            prebuyAmountHuman: awaiting.proposed.prebuy?.amountHuman,
          },
        },
      },
    };
  });
}
