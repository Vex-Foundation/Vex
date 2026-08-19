/**
 * The sweep's VOCABULARY: what a launch-receipt lookup is asked, and what the
 * chain may answer.
 *
 * Split out of `../launch-identity-repair.ts` because both the sweep and its
 * production wiring depend on these shapes, and a type both halves import must
 * not live inside either of them.
 */

import type {
  PoolsLaunchIntentFields,
  TokenLaunchIntentProtocol,
} from "@vex-agent/db/repos/token-launch-intents.js";

export interface LaunchReceiptLookupInput {
  readonly chainId: number;
  readonly txHash: string;
  /** The creator to cross-check `TokenCreated` against — never a stranger's create in the same receipt. */
  readonly walletAddress: string;
  /**
   * WHICH LAUNCHPAD this intent belongs to (migration 082).
   *
   * The two launchpads emit different events from different contracts and
   * attribute a launch differently — on the pools.fun gateway path the FACTORY
   * names the gateway as creator, so its decoder binds identity through
   * `GatewayLaunch.launcher` instead. Dispatching the trench decoder at a
   * pools.fun receipt does not merely fail, it fails SILENTLY as "no decodable
   * event", which this sweep correctly treats as ambiguity and re-checks
   * forever. So the protocol travels with the lookup and the decoder is chosen,
   * never inferred.
   */
  readonly protocol: TokenLaunchIntentProtocol;
  /**
   * The AUTHORIZED pools.fun plan, already parsed and complete, or `null`.
   *
   * `null` on a trench intent — and also on a pools intent whose stored plan is
   * incomplete, which is DECLINED rather than decoded loosely: accepting a token
   * address on weaker evidence during recovery than at launch time is the wrong
   * way round, because recovery is where a wrong answer is least likely to be
   * noticed.
   */
  readonly poolsPlan: AuthorizedPoolsLaunchPlan | null;
}

/** The five facts the pools.fun settlement decoder proves a receipt against. */
export interface AuthorizedPoolsLaunchPlan {
  readonly feeRecipient: string;
  readonly pairedAsset: string;
  readonly userSalt: string;
  readonly predictedTokenAddress: string;
  /** The gateway that was authorized, when the row recorded one. */
  readonly gateway: string | null;
}

/**
 * What a confirmed launch receipt proves.
 *
 * `tokenAddress` is the address decoded from `TokenCreated`. A lookup that CAN
 * read the receipt but CANNOT decode the event must return `null` for the whole
 * result rather than a result with an empty address — "the transaction settled"
 * without "and here is the token" is not enough to complete a launch identity,
 * and a half-answer here would be written to the durable index.
 */
export interface LaunchReceiptIdentity {
  readonly tokenAddress: string;
}

/**
 * The THREE answers the chain can give about a staged create, and the reason
 * this is a union rather than a nullable identity.
 *
 * A create that is later proven to have REVERTED emits no `TokenCreated`, so an
 * identity-or-nothing lookup reported it exactly like "not mined yet" — and the
 * intent stayed `broadcast_pending` forever, with the user's launch stuck in a
 * limbo the UI cannot explain. A PROVEN revert is terminal. Everything else
 * (`null`) is ambiguity, and ambiguity is never terminal.
 */
export type LaunchReceiptOutcome =
  | { readonly kind: "created"; readonly identity: LaunchReceiptIdentity }
  | { readonly kind: "reverted" }
  /**
   * NO NODE CAN ACCOUNT FOR THIS HASH: no receipt, and another transaction from
   * the same wallet has already used its nonce. The owner's live case — a launch
   * hash still unknown to the RPC ~24 h after broadcast, reported by this sweep
   * exactly like "not mined yet" and therefore re-checked forever.
   *
   * IT IS NOT A FAILURE AND IT IS NOT TERMINAL HERE. It establishes only that
   * THIS hash has no receipt; a replacement reusing the nonce may have carried
   * the same calldata and created the token, and correlating that is strictly
   * more work than this sweep does.
   *
   * WHY THIS SWEEP DOES NOT TERMINALIZE IT. The `superseded_unproven` transition
   * is CLAIM FENCED — `markSupersededUnproven` requires the pending lane's
   * `evm_claim_token` — and the launch's sibling `agent_activity` row is already
   * covered by that lane, which holds the claim and owns both A6 clocks. A
   * second writer for one terminal transition is exactly the stale-over-fresh
   * race the fence exists to prevent. So this sweep CLASSIFIES, and the lane
   * TERMINALIZES.
   */
  | { readonly kind: "superseded" };

export interface LaunchIdentityRepairDeps {
  /**
   * The ONLY dependency this sweep may have. Read-only: a receipt lookup that
   * reports the mined status and, on success, decodes `TokenCreated`. Never a
   * send/broadcast/sign capability.
   *
   * `null` means "no answer yet" — not yet mined, a transient RPC error, an
   * unreadable receipt, or a SUCCESSFUL receipt with no decodable
   * `TokenCreated`. All of those leave the intent `broadcast_pending`.
   *
   * THE NOT-YET-MINED CASE MAY ALSO THROW, and that is the ordinary shape: viem
   * raises `TransactionReceiptNotFoundError` for a hash with no receipt, so the
   * commonest healthy answer arrives as an exception. `lookupOutcome` classifies
   * it — the sweep's control flow is the same quiet `null` either way, but the
   * OBSERVABILITY differs: not-yet-mined is silent, everything else warns once.
   * A launch broadcast four minutes ago is not an incident, and logging it as
   * one every 30 s forever is what buried the real failures.
   */
  readonly resolveLaunchOutcome: (
    input: LaunchReceiptLookupInput,
  ) => Promise<LaunchReceiptOutcome | null>;
}
