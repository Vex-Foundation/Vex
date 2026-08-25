/**
 * The Khalani staged-leg MODEL — the vocabulary every other `bridge-executor/`
 * module speaks: what a planned leg is, what a staged broadcast hands back, and
 * what the caller must persist between signing and sending.
 *
 * Types only, plus the one pure function (`khalaniLegNativeValueCall`) that
 * defines the call a leg's native-value authorization is bound to. It lives
 * here rather than in the planner or the signer because BOTH must compute the
 * identical tuple — see its own doc.
 */

import type { Address, Hex } from "viem";
import type { NativeValueAuthorization } from "@tools/evm-chains/native-value-authorization/index.js";
import type { ApprovedSpender } from "@tools/evm-chains/erc20-approval.js";

export type KhalaniLegRole = "allowance_reset" | "allowance" | "bridge_deposit" | "bridge_fee";

/**
 * WHY the leg carries a purpose separate from its role: before migration 050
 * the Vex fee leg was recorded under the `allowance` `event_role`, so the role
 * alone could not tell a real approval apart from the fee transfer. The
 * dedicated `bridge_fee` role now can, but callers still branch on this
 * purpose — it is the one discriminator that also covers the Solana fee leg
 * while it is still an unbuilt descriptor (`kind: "solana_fee"`), before any
 * role-bearing row exists. Collapsing the two is a follow-up cleanup, not part
 * of the 050 change.
 */
export type KhalaniLegPurpose = "bridge" | "vex_fee";

/**
 * The three receipt-log fields the deposit-evidence rule reads. Declared here
 * rather than imported from the agent runtime so this leaf keeps its one-way
 * import direction (`vex-agent` → `tools`, never the reverse); the shape is the
 * one every viem log already has.
 */
export interface KhalaniReceiptLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/**
 * What a deposit leg proves about the principal it carries, decided by the
 * PLANNER because only it knows which `DepositPlan` variant produced the leg.
 * It never establishes the amount on its own: it names the token, the proven
 * recipients and (for a Vex-built transfer) the exact amount encoded, so the
 * confirm site can look for THAT transfer in the receipt.
 */
export type KhalaniDepositEvidence =
  | {
      /** A Vex-composed ERC-20 `transfer` (a `TRANSFER` deposit plan). */
      readonly kind: "vex_built_erc20_transfer";
      readonly token: Address;
      readonly recipient: Address;
      readonly amountRaw: bigint;
    }
  | {
      /** A Vex-composed native transfer: the signed `value` IS the principal. */
      readonly kind: "vex_built_native_transfer";
      readonly valueWei: bigint;
    }
  | {
      /**
       * Provider calldata (a `CONTRACT_CALL` plan). Nothing about the amount is
       * known offline. The call target is always authorized to receive the
       * input; an approved spender is authorized only for the token its OWN
       * approval named, which is why the pair travels together - an approval for
       * token B says nothing about where token A may go.
       */
      readonly kind: "provider_contract_call";
      readonly callTarget: Address;
      readonly approvedSpenders: readonly ApprovedSpender[];
    };


/**
 * The three staged outcomes — mirrors the EVM `signStageBroadcast` contract.
 *
 * `settledAtBlock` is the confirmed EVM leg's receipt block, which the caller
 * threads into the NEXT leg as its read-after-write anchor
 * (`dependent-leg-gas-estimate.ts`). `null` for Solana legs, mirroring the
 * `nonce: null` discriminant `KhalaniStageHandles` already uses for that
 * family — a Solana plan has no EVM block to anchor on.
 */
export type KhalaniStagedOutcome =
  | {
      readonly kind: "confirmed";
      readonly txHash: string;
      readonly settledAtBlock: bigint | null;
      /**
       * The confirmed EVM receipt's logs: the ONLY evidence a deposit leg's
       * executed ERC-20 amount may come from
       * (`@vex-agent/tools/protocols/bridge-deposit-evidence.ts`). Carried out
       * of the receipt this signer already awaited rather than re-fetched by
       * the caller: a second `eth_getTransactionReceipt` would read the same
       * immutable receipt at the cost of one more RPC round trip. `null` for a
       * Solana leg, which has no EVM receipt.
       */
      readonly receiptLogs: readonly KhalaniReceiptLog[] | null;
    }
  | { readonly kind: "reverted"; readonly txHash: string }
  | { readonly kind: "ambiguous"; readonly txHash: string; readonly stage: "send" | "confirm" };

/**
 * Persisted BEFORE broadcast — `nonce` is a number for EVM, `null` for Solana
 * (B1 nonce matrix). A `null` nonce always carries the fresh Solana blockhash
 * evidence `markActivitySolanaBroadcast` requires (W5 §2/R2b): the discriminant
 * on `nonce` mirrors the check every caller already performs
 * (`h.nonce === null`), so the evidence fields narrow in automatically instead
 * of needing a separate tag.
 */
export type KhalaniStageHandles =
  | { readonly txHash: string; readonly fromAddress: string; readonly nonce: number }
  | {
      readonly txHash: string;
      readonly fromAddress: string;
      readonly nonce: null;
      readonly recentBlockhash: string;
      readonly lastValidBlockHeight: number;
    };

export interface KhalaniStageHooks {
  /** Reserve an EVM nonce durably before signing. Unused for Solana legs. */
  readonly onNonceReserved: (request: {
    readonly fromAddress: Hex;
    readonly chainId: number;
    readonly nodePendingNonce: number;
  }) => Promise<number>;
  /** Persist the computed hash/signature (`markActivityBroadcast`) — a throw aborts BEFORE any broadcast. */
  readonly onHashStaged: (handles: KhalaniStageHandles) => Promise<void>;
  /** Bookkeeping after the RPC accepts the submission (`markBroadcastAccepted`) — a throw here does NOT roll back. */
  readonly onAccepted: () => Promise<void>;
}

export interface NormalizedEvmTx {
  readonly to: Address;
  readonly data?: Hex;
  readonly value?: bigint;
  /**
   * Khalani's gas figure is a HINT that can only RAISE the signed limit, never
   * lower it below our own headroomed estimate, and never past the Vex-owned
   * ceiling (`gasLimitForProviderHintedCall`). The nonce hint is honored as-is;
   * fees are left to viem's estimator (parity with the swap staged path).
   */
  readonly gas?: bigint;
  readonly nonce?: number;
  /** If Khalani declared a sender, it MUST equal the signing wallet (fail-closed). */
  readonly expectedFrom?: Address;
}

/**
 * One planned Vex-signed broadcast leg derived (no signing) from a
 * `DepositPlan`.
 *
 * `nativeValue` is REQUIRED on every EVM leg and is the authorization for that
 * leg's `tx.value`: `signStageEvmLeg` re-checks it against the transaction it
 * is about to serialize and refuses on any mismatch, so a leg cannot reach the
 * signer without one. The planner is network-free, so a PROVIDER-supplied value
 * starts out `unclassified` — `authorizeKhalaniLegNativeValue`
 * (`../deposit-native-value.ts`) is what upgrades it with a proof, and a leg
 * that is never upgraded is refused rather than signed.
 */
export type KhalaniStagedLeg =
  | {
      readonly role: KhalaniLegRole;
      readonly purpose: KhalaniLegPurpose;
      readonly family: "eip155";
      readonly isDeposit: boolean;
      readonly kind: "evm";
      readonly tx: NormalizedEvmTx;
      readonly nativeValue: NativeValueAuthorization;
      /** Present on the DEPOSIT leg only: what its confirm site may look for. */
      readonly depositEvidence?: KhalaniDepositEvidence;
    }
  | { readonly role: KhalaniLegRole; readonly purpose: KhalaniLegPurpose; readonly family: "solana"; readonly isDeposit: boolean; readonly kind: "solana"; readonly base64Tx: string }
  /**
   * The Solana Vex fee leg, still unbuilt: materialized inside
   * `signStageKhalaniLeg` (see `./leg-signing.ts`) because it needs the mint's
   * owner program and the treasury ATA's existence, and the planner is
   * network-free.
   */
  | {
      readonly role: KhalaniLegRole;
      readonly purpose: "vex_fee";
      readonly family: "solana";
      readonly isDeposit: false;
      readonly kind: "solana_fee";
      readonly mint: string;
      readonly feeRaw: bigint;
    };

/** The Vex integrator fee to append as the FINAL leg. `feeRaw` must be positive. */
export interface KhalaniVexFeeLeg {
  /** The source-chain token/mint the user is bridging — the fee is taken from it. */
  readonly tokenAddress: string;
  readonly feeRaw: bigint;
}

/**
 * The call an EVM leg's native-value authorization covers. Kept in ONE place so
 * the tuple the planner classifies and the tuple `signStageEvmLeg` re-checks
 * can never drift apart — a fingerprint computed over two different shapes
 * would refuse every honest leg.
 */
export function khalaniLegNativeValueCall(chainId: number, tx: NormalizedEvmTx) {
  return { chainId, to: tx.to, data: tx.data, valueWei: tx.value ?? 0n } as const;
}
