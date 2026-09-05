/**
 * THE RUNTIME CONTRACT for pools.fun launches and fee claims.
 *
 * This is the surface the Electron MAIN process calls (`vex-app/src/main/ipc/
 * pools-launch.ts`, domain `poolsLaunch`). It is published as its own module,
 * ahead of the implementation, because the desktop lane and the runtime lane are
 * built in parallel and a contract discovered late is a contract negotiated
 * through rework.
 *
 * WHAT THIS MODULE IS. Types, and the function TYPES the implementations must
 * satisfy. The implementations land in sibling files under `./` and are
 * re-exported from `../launch.ts`; they are bound to these types, so a drift
 * between what main expects and what the runtime returns is a compile error
 * rather than a runtime surprise.
 *
 * TWO PROPERTIES THE SHAPES ENFORCE, both of them money-path rules:
 *
 *  1. NO FEE, VALUE, RECIPIENT, DEADLINE OR GAS FIELD IS AN INPUT. Everything
 *     the user or the agent supplies is a LOGICAL input (what to launch), never
 *     a number that reaches a transaction. The fee recipient is the one nuance:
 *     the agent path has no recipient field at all (the system pins the session
 *     wallet), and the MANUAL form path may carry a user-chosen recipient, which
 *     is authorized by the form itself and echoed back resolved. See
 *     `PoolsLaunchRecipientChoice`.
 *  2. EVERY AMOUNT TRAVELS WITH ITS DECIMALS. `PoolsAmount` has no bare number
 *     anywhere: a raw string plus the decimals needed to read it, because
 *     "1047061" is 1.05 at six decimals and 0.00105 at nine (rule 90). USD
 *     figures are absent entirely rather than estimated here.
 *
 * TWO STAGES, AND WHY. `prepare` resolves the image to bytes when it came from
 * the locker, uploads it ONCE (the upload endpoint is rate limited to roughly
 * one call a minute, so it happens here and its URL is reused across any
 * reprepare), calls the provider's prepare endpoint, and runs the FULL calldata
 * verifier; it authorizes nothing and signs nothing. `deploy` takes the opaque fingerprint that prepare
 * produced, re-runs the verifier against it, takes the C0 authorization over
 * that exact calldata+value fingerprint, and stages the broadcast. The split
 * exists because the launch's final token address is only knowable after the
 * image is pinned (image -> metadataUri -> salt -> address), so the address the
 * user approves must come from a real prepare, not from a prediction.
 */

import type { Address, Hex } from "viem";

// ── Amounts ─────────────────────────────────────────────────────────────────

/**
 * A raw amount and the decimals needed to read it. Never a bare number, and
 * never a display string on its own: the renderer formats from these two, so
 * there is exactly one place the scaling can be got wrong and it is covered by
 * tests.
 */
export interface PoolsAmount {
  /** Smallest units, exact, as a decimal string. */
  readonly rawWei: string;
  readonly decimals: number;
  /** The asset the amount is denominated in. Native ETH uses the zero sentinel. */
  readonly assetAddress: Address;
  /** Display symbol, for the renderer's label only. Never parsed. */
  readonly assetSymbol: string;
}

// ── Stage 1: prepare + verify ───────────────────────────────────────────────

/** Which paired asset the new pool trades against. Stocks are not launchable today. */
export type PoolsPairedAsset = "weth" | "usdg";

/**
 * Who receives the creator fee stream.
 *
 * `session_wallet` is the ONLY value an agent path may produce - the system
 * pins it, and the agent-facing tools have no recipient parameter at all, which
 * is what keeps the fee-guard untripped. The other two are manual-form only,
 * and both are resolved to an address that the form shows and the user confirms
 * BEFORE Deploy.
 */
export type PoolsLaunchRecipientChoice =
  | { readonly kind: "session_wallet" }
  | { readonly kind: "address"; readonly address: Address }
  | { readonly kind: "x_username"; readonly username: string };

/**
 * The optional same-transaction prebuy.
 *
 * WETH-native only on the autonomous path - a USDG prebuy needs an ERC-20
 * approval leg and is manual-form only (a named omission, not an oversight).
 * The amount is a HUMAN decimal string here because it is what the user typed;
 * it is converted once, inside prepare, against the pair's on-chain decimals.
 */
export interface PoolsLaunchPrebuy {
  readonly amountHuman: string;
}

/**
 * Where the launch image comes from. A DISCRIMINATED UNION because there are
 * genuinely two sources and they need different work done to them.
 *
 * `locker` is the primary path and the one the desktop form uses: the user picks
 * a picture they staged earlier in the SHARED IMAGE LOCKER (the same locker
 * the locker uses), so what crosses the boundary is an opaque id the agent
 * can never mint - only name one a read tool listed. `prepare` resolves that id
 * to bytes through the EXISTING image lane and uploads them ONCE.
 *
 * `url` is the escape hatch for an already-hosted picture.
 *
 * WHY A UNION RATHER THAN AN OPTIONAL `imageUrl`. The first cut of this contract
 * accepted only a URL, which made the locker path - the actual product premise -
 * unexpressible. The desktop lane could then only refuse a locker pick by name,
 * which is the honest thing to do with an input the runtime cannot honour, but
 * it left the form's main option failing. A union makes both sources first-class
 * and keeps "no image" spelled exactly one way: the field absent.
 */
export type PoolsLaunchImage =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "locker"; readonly imageId: string };

/** The logical launch inputs. Nothing here is a fee, a value, a deadline or gas. */
export interface PoolsLaunchInputs {
  readonly name: string;
  readonly symbol: string;
  readonly pairedAsset: PoolsPairedAsset;
  /**
   * The picture the token launches with, from the locker or from a URL. Absent
   * means no image at all, which the provider accepts and which
   * `PoolsPreparedLaunch.imageLanded` then reports as `false`.
   *
   * WHATEVER THE SOURCE, prepare ends up sending the provider `imageUrl`. That
   * is the field that WORKS: `image` is accepted with HTTP 200 and silently
   * dropped, which is what left the first funded launch rendering blank (probed
   * 2026-08-18, six shapes, one landed; see `PoolsFun.md`).
   */
  readonly image?: PoolsLaunchImage | undefined;
  readonly tweetUrl?: string | undefined;
  readonly websiteUrl?: string | undefined;
  readonly prebuy?: PoolsLaunchPrebuy | undefined;
  readonly feeRecipient: PoolsLaunchRecipientChoice;
}

/**
 * What a launch will cost, leg by leg. Every leg is a `PoolsAmount`, so the
 * renderer never has to know which are native and which are not.
 *
 * `gasBoundWei` is a CEILING, not an estimate: it is the bound the authorization
 * is taken against, so the user approves a maximum rather than a guess.
 */
export interface PoolsLaunchCostBreakdown {
  /** The gateway's deployment fee, read fresh - it is dynamic and has moved 4x in a day. */
  readonly deploymentFee: PoolsAmount;
  /** The prebuy, absent when none was requested. */
  readonly prebuy?: PoolsAmount | undefined;
  /** Vex's integrator fee, charged on the native msg.value basis, after the launch confirms. */
  readonly vexFee: PoolsAmount;
  /** Upper bound on network cost. */
  readonly gasBound: PoolsAmount;
  /** `msg.value` exactly: deployment fee + native prebuy. Excludes the Vex fee and gas. */
  readonly transactionValue: PoolsAmount;
}

/**
 * The opaque handle stage 2 consumes.
 *
 * Opaque ON PURPOSE: it names a server-side record holding the verified
 * calldata, the value, and every anchored read the verifier made. The renderer
 * cannot reconstruct or alter a launch from it, which is what stops a tampered
 * round-trip from reaching the signer.
 */
export type PoolsLaunchFingerprintId = string;

/** Stage-1 result: everything the two-stage form's confirm screen shows. */
export interface PoolsPreparedLaunch {
  readonly fingerprintId: PoolsLaunchFingerprintId;
  /**
   * The FINAL token address this exact calldata produces, agreed by the
   * gateway's `computeTokenAddress`, the provider's prediction, and an
   * `eth_call` of the launch itself. Not a preview's guess.
   */
  readonly predictedTokenAddress: Address;
  readonly predictedPoolAddress: Address;
  /** The RESOLVED recipient address, whatever choice produced it. Shown before Deploy. */
  readonly resolvedFeeRecipient: Address;
  readonly pairedAsset: PoolsPairedAsset;
  readonly pairedAssetAddress: Address;
  readonly costs: PoolsLaunchCostBreakdown;
  /** The metadata document the launch pins, so the form can show what was published. */
  readonly metadataUri: string;
  /** Whether the image actually landed in that metadata - a provider trap, surfaced. */
  readonly imageLanded: boolean;
  /** When the verified fingerprint stops being usable and a fresh prepare is required. */
  readonly expiresAt: string;
}

// ── Stage 2: deploy ─────────────────────────────────────────────────────────

export interface PoolsDeployInputs {
  readonly fingerprintId: PoolsLaunchFingerprintId;
}

/** A launch that reached the network. */
export interface PoolsDeployedLaunch {
  readonly tokenAddress: Address;
  readonly poolAddress: Address;
  readonly txHash: Hex;
  /** The activity row the desktop follows for confirmation. */
  readonly activityId: number;
  readonly resolvedFeeRecipient: Address;
}

// ── Claims ──────────────────────────────────────────────────────────────────

/**
 * Both legs a claim pays out, from an `eth_call` simulation of
 * `collectAndClaim` as the session wallet.
 *
 * The simulation is the ONLY honest source: the locker's
 * `claimableToken`/`claimablePaired` mappings show fees ALREADY COLLECTED and
 * read 0/0 while a simulation returned a real paired amount, so they are
 * labelled "already collected" and never presented as "claimable".
 */
export interface PoolsClaimPreview {
  readonly tokenAddress: Address;
  /** The launched token's leg. */
  readonly tokenLeg: PoolsAmount;
  /** The paired asset's leg - the one the mission floor is measured against. */
  readonly pairedLeg: PoolsAmount;
  /** What the locker says was already collected previously. Never a claimable total. */
  readonly alreadyCollected: { readonly tokenLeg: PoolsAmount; readonly pairedLeg: PoolsAmount };
  /** Upper bound on the network cost of actually claiming. */
  readonly gasBound: PoolsAmount;
}

export interface PoolsClaimInputs {
  readonly tokenAddress: Address;
}

export interface PoolsClaimedFees {
  readonly tokenAddress: Address;
  readonly txHash: Hex;
  /** ONE activity row carrying BOTH output legs (migration 082 `pools_claim`). */
  readonly activityId: number;
  readonly tokenLeg: PoolsAmount;
  readonly pairedLeg: PoolsAmount;
}

// ── Listing surfaces ────────────────────────────────────────────────────────

/** One of the session wallet's own pools.fun launches. */
export interface PoolsMyLaunchRow {
  readonly tokenAddress: Address;
  readonly poolAddress: Address | null;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly pairedAsset: string;
  readonly launchedAt: string;
  readonly txHash: Hex | null;
  /** Where the fee stream goes, so user and agent always know. */
  readonly feeRecipient: Address | null;
  /**
   * Present only when a claim simulation was run for this row. Absent means NOT
   * MEASURED - never "nothing to claim".
   */
  readonly claimable?: { readonly tokenLeg: PoolsAmount; readonly pairedLeg: PoolsAmount } | undefined;
}

export interface PoolsMyLaunchesResult {
  readonly wallet: Address;
  readonly launches: readonly PoolsMyLaunchRow[];
}

/**
 * A launch form the agent asked the human to fill, waiting for them.
 *
 * `null` means there is nothing awaiting - the ordinary case, and deliberately
 * not an error.
 */
export interface PoolsAwaitingLaunchForm {
  readonly intentId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
  /** Whatever the agent proposed, for the form to pre-fill. */
  readonly proposed: Partial<PoolsLaunchInputs>;
}

// ── Refusals ────────────────────────────────────────────────────────────────

/**
 * Why a call was refused, as a NAMED kind.
 *
 * Deliberately a closed union of kinds rather than a code: the IPC layer maps
 * these onto the EXISTING `VEX_ERROR_CODES` surface exactly as
 * `main/ipc/token-launch.ts` already does (two of its kinds map onto
 * `internal.unexpected` on purpose). P3 mints NO new wire code; a kind that
 * genuinely cannot be expressed by an existing one is a stop-and-ask, not a new
 * entry.
 *
 * Suggested mapping, matching the existing handler's reasoning:
 *   `invalid_inputs`         -> the input-validation code the domain already uses
 *   `wallet_unavailable`     -> `wallet.*` (no wallet / locked)
 *   `insufficient_funds`     -> `wallet.insufficient_funds`
 *   `pair_not_allowlisted`   -> `internal.unexpected` (our on-chain read refused it)
 *   `verifier_refused`       -> `internal.unexpected` (message carries the point that failed)
 *   `fingerprint_expired`    -> `internal.unexpected` (re-prepare; not the user's input)
 *   `provider_unavailable`   -> `internal.unexpected`
 *   `claim_ceiling_exceeded` -> `internal.unexpected` (message names the numbers)
 */
export type PoolsLaunchRefusalKind =
  | "invalid_inputs"
  | "wallet_unavailable"
  | "insufficient_funds"
  | "pair_not_allowlisted"
  | "verifier_refused"
  | "fingerprint_expired"
  | "provider_unavailable"
  | "claim_ceiling_exceeded";

export interface PoolsLaunchRefusal {
  readonly kind: PoolsLaunchRefusalKind;
  /**
   * The REAL cause, agent- and user-facing, already scrubbed. On a verifier
   * refusal this names WHICH of the checks failed, because "refused" alone
   * cannot be acted on.
   */
  readonly message: string;
}

/** Every entry point answers with this shape - never a thrown error across the boundary. */
export type PoolsLaunchOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: PoolsLaunchRefusal };

// ── The entry points main calls ─────────────────────────────────────────────
//
// Function TYPES, not implementations: the implementations land beside this
// file and are bound to these signatures, so main and the runtime cannot drift.

/** Identifies whose launch this is. Never carried in an IPC payload. */
export interface PoolsLaunchSession {
  readonly sessionId: string;
  readonly walletAddress: Address;
}

export type PreparePoolsLaunch = (
  session: PoolsLaunchSession,
  inputs: PoolsLaunchInputs,
) => Promise<PoolsLaunchOutcome<PoolsPreparedLaunch>>;

export type DeployPoolsLaunch = (
  session: PoolsLaunchSession,
  inputs: PoolsDeployInputs,
) => Promise<PoolsLaunchOutcome<PoolsDeployedLaunch>>;

export type CancelPoolsLaunch = (
  session: PoolsLaunchSession,
  inputs: { readonly fingerprintId: PoolsLaunchFingerprintId },
) => Promise<PoolsLaunchOutcome<{ readonly cancelled: boolean }>>;

export type PreviewPoolsClaim = (
  session: PoolsLaunchSession,
  inputs: PoolsClaimInputs,
) => Promise<PoolsLaunchOutcome<PoolsClaimPreview>>;

export type ClaimPoolsFees = (
  session: PoolsLaunchSession,
  inputs: PoolsClaimInputs,
) => Promise<PoolsLaunchOutcome<PoolsClaimedFees>>;

export type ListPoolsMyLaunches = (
  session: PoolsLaunchSession,
  inputs: { readonly limit?: number | undefined; readonly includeClaimable?: boolean | undefined },
) => Promise<PoolsLaunchOutcome<PoolsMyLaunchesResult>>;

export type GetAwaitingPoolsLaunchForm = (
  session: PoolsLaunchSession,
) => Promise<PoolsLaunchOutcome<PoolsAwaitingLaunchForm | null>>;
