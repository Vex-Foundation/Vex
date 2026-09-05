/**
 * The C0 authorization record for a pools.fun launch.
 *
 * SAME IDEA AS TRENCH, ONE DIFFERENT GATE, and the difference is the whole
 * reason this file exists rather than reusing `trench/handlers/launch/
 * authorization.ts`.
 *
 * Trench builds its own calldata, so it can re-derive the entire plan from first
 * principles immediately before signing and compare it field by field; that
 * re-derivation IS its last gate. pools.fun cannot do that. Its calldata comes
 * from the provider's `prepare`, and a second prepare pins a second persistent
 * IPFS object and mines a DIFFERENT salt - which changes the metadata URI, the
 * salt, and therefore the token's address. A re-derivation would describe a
 * DIFFERENT LAUNCH, so comparing against it would either refuse every honest
 * launch or, worse, quietly authorize the second one.
 *
 * WHAT REPLACES IT is the order plus the fingerprint:
 *
 *   upload once -> prepare -> THE 13-POINT VERIFIER -> (only on ok) authorize
 *   the exact calldata+value fingerprint -> broadcast THAT fingerprint.
 *
 * The verifier runs immediately before the authorization exists, over the exact
 * bytes; the authorization names those bytes by hash; the broadcaster is handed
 * nothing else. Nothing between them re-asks the provider for anything. An
 * automatic reprepare after this point would mean broadcasting something other
 * than what was approved, which is why reprepare is confined to the window
 * before an authorization exists.
 *
 * The single-use property is unchanged and is not weakened here: it is the
 * `consumeIfAuthorizedWith` CAS in the intents repo, the only thing standing
 * between one launch and two.
 *
 * THE PERSISTED RECORD IS AUDIT, NOT THE GATE - identically to the trench agent
 * paths. Nothing reads `authorization_json` back to decide anything on this
 * path. It exists so a reviewer can reconstruct months later exactly what was
 * authorized: which token at which address, which pair, which fee at which
 * block, which recipient, which bytes.
 */

import type { Address, Hex } from "viem";

import type { Permission } from "@vex-agent/engine/types.js";

/** Everything a pools.fun launch authorization binds. */
export interface PoolsLaunchAuthorizationBinding {
  // ── what is being created ──
  readonly name: string;
  readonly symbol: string;
  /** The metadata document the launch pins. Its URI is what determines the salt. */
  readonly metadataUri: string;
  /** The URL sent as `imageUrl`, or `null` when the launch carries no image. */
  readonly imageUrl: string | null;
  /** The locker id the bytes came from, when they did. */
  readonly imageId: string | null;

  // ── where ──
  readonly chainId: number;
  readonly gateway: Address;
  readonly pairedAsset: "weth" | "usdg" | "stock";
  readonly pairedAssetAddress: Address;
  /** The address these exact bytes produce, agreed by three independent derivations. */
  readonly predictedTokenAddress: Address;
  readonly userSalt: Hex;

  // ── the money, decomposed ──
  /** The gateway's fee, read at {@link anchorBlockNumber}. It is dynamic. */
  readonly deploymentFeeWei: string;
  /** The NATIVE prebuy, in wei. `"0"` for none. */
  readonly prebuyWei: string;
  /** `deploymentFeeWei + prebuyWei`, exactly - and exactly `msg.value`. */
  readonly msgValueWei: string;
  /** Vex's 25 bps fee: a SEPARATE later transfer, never inside `msg.value`. */
  readonly vexFeeWei: string;
  /** The CEILING on network cost the balance gate was run against, not an estimate to spend. */
  readonly gasBoundWei: string;
  readonly anchorBlockNumber: string;

  // ── who gets paid, and who launched ──
  /**
   * The recipient EXACTLY as the signed tuple carries it.
   *
   * On a holders launch this is the gateway's `FEES_TO_HOLDERS*` SENTINEL, which
   * is not an address anybody owns and is NOT what the receipt will name: the
   * gateway resolves it to the distributor it deploys during the launch, and
   * emits that. So the sentinel is the SIGNED fact and {@link holderRewards}
   * carries the intent it expressed; the resolved distributor is a SETTLEMENT
   * fact and is recorded only once a receipt has proven it.
   */
  readonly feeRecipient: Address;
  /**
   * The holder-rewards INTENT this launch was authorized under, or `null` for an
   * ordinary launch whose fee stream goes to an address.
   *
   * Two fields rather than one, because they answer different questions and only
   * one of them is on chain yet: `mode` is what the human agreed to ("holders,
   * paid in the paired asset"), and `sentinel` is the constant that expresses it
   * in the bytes that were signed. Recording only the mode would leave the audit
   * unable to say which sentinel was signed; recording only the sentinel would
   * leave a reader decoding a constant to recover a product decision.
   */
  readonly holderRewards:
    | { readonly mode: "token" | "paired" | "both"; readonly sentinel: Address }
    | null;
  readonly walletAddress: Address;

  // ── the exact transaction ──
  readonly calldata: Hex;
  /** `nativeValueCallFingerprint` over (chainId, to, calldata, value). THE gate. */
  readonly callFingerprint: Hex;

  readonly sessionId: string;
  /** Permission AT AUTHORIZATION TIME - not at execution time. */
  readonly permission: Permission;
}

/**
 * Mission evidence that authorized an unattended launch, so a later audit sees
 * what bounded it.
 */
export interface PoolsLaunchMissionProvenance {
  readonly missionId: string;
  readonly missionRunId: string;
  readonly maxLaunchValueRaw: string | null;
  readonly maxLaunchCount: number | null;
}

export type PoolsLaunchAuthorization =
  | {
      /**
       * THE FORM IS THE APPROVAL. A human filled the two-stage form, saw the
       * final token address, the resolved fee recipient and the exact costs,
       * and clicked Deploy. That click is the spend consent - there is no
       * approval card for this tool, by design.
       *
       * It binds the SAME fields as every other variant, because whatever
       * authorized the spend, the audit answer to "what exactly was authorized"
       * must have one shape. What it does NOT do is become a gate: the bytes
       * were verified in stage 1 and the fingerprint is what stage 2 signs.
       */
      readonly kind: "user_submit";
      readonly binding: PoolsLaunchAuthorizationBinding;
      /** When the human clicked Deploy. */
      readonly submittedAt: string;
    }
  | {
      readonly kind: "full_autonomy";
      readonly binding: PoolsLaunchAuthorizationBinding;
      readonly provenance: PoolsLaunchMissionProvenance;
      readonly authorizedAt: string;
    }
  | {
      readonly kind: "session_full";
      readonly binding: PoolsLaunchAuthorizationBinding;
      /** When the handler authorized it. The binding carries the permission. */
      readonly authorizedAt: string;
    };

/**
 * Compose `msg.value` and REFUSE unless it is the exact bigint sum.
 *
 * No tolerance, deliberately: there is no mechanism that would make a launch's
 * own two components miss their sum by a little, and slack on a value comparison
 * is how an unexplained charge rides along (rule 90). The verifier's point 11
 * proves the SAME equality against the provider's `value`; this is the value Vex
 * itself expects, computed before the response is trusted for anything.
 */
export function composePoolsLaunchValue(deploymentFeeWei: bigint, prebuyWei: bigint): bigint {
  if (deploymentFeeWei <= 0n) {
    throw new Error("Refusing to launch: the launchpad's deployment fee resolved to zero or negative.");
  }
  if (prebuyWei < 0n) {
    throw new Error("Refusing to launch: the prebuy is negative.");
  }
  return deploymentFeeWei + prebuyWei;
}
