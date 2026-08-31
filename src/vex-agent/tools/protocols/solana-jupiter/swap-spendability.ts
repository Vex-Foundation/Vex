/**
 * The Jupiter half of spendability: turn Solana chain reads into the two legs
 * `quote-authority/spendability.ts` judges.
 *
 * WHY IT LIVES HERE and not beside the reads. `src/tools` may not import
 * `src/vex-agent`, and the shared evaluator, the shortfall vocabulary and the
 * chain-id constant all live on the agent side. So
 * `tools/solana-ecosystem/jupiter/jupiter-swaps/spendability.ts` owns the RPC
 * work and the debit arithmetic, and this module owns the composition into the
 * one evaluator every venue shares. There is no second verdict here.
 *
 * ONE DERIVATION, TWO WINDOWS. The quote handler and the pre-sign hook call the
 * SAME observer over the SAME kind of message, so the number a person approves
 * and the number the signature is refused on cannot drift apart by
 * construction. What differs is only WHEN it runs and what a shortfall does:
 * at quote time it records an ineligible row, at pre-sign it refuses.
 */

import type { Connection, PublicKey, VersionedMessage } from "@solana/web3.js";

import {
  measureJupiterNativeDebit,
  readNativeLamports,
  readSplSpendability,
  type JupiterNativeDebit,
  type SolanaSplSpendability,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/spendability.js";
import {
  SOLANA_NATIVE_PERSISTED_ADDRESS,
  type SolanaSwapInputAsset,
} from "@tools/solana-ecosystem/shared/solana-asset-identity.js";
import { SOL_DECIMALS } from "@tools/solana-ecosystem/shared/solana-constants.js";

import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../constants/solana-chain.js";
import { formatRawAmount } from "../amount-display.js";
import { VexError, ErrorCodes } from "../../../../errors.js";
import {
  evaluateSpendability,
  formatShortfall,
  type SpendabilityAssetCheck,
} from "../quote-authority/spendability.js";
import type { QuoteEligibility } from "../quote-authority/eligibility.js";
import type { SpendabilityPreview } from "../quote-authority/spendability-contract.js";

/** The native asset's symbol, as every Solana row spells it. */
const NATIVE_SYMBOL = "SOL";

/**
 * Solana has commitments, not block tags. `processed` is the one that reflects
 * the wallet's newest, not-yet-confirmed activity, which is the property
 * contract C2.4 requires of a spend-time read, so it is the observation this
 * lane reports as `pending`. Nothing else may be: a `confirmed` figure can
 * still include lamports an unconfirmed transfer has committed.
 */
const PENDING_EQUIVALENT = "pending" as const;

/** The bounded cause classes this lane may attach to `balance_unavailable`. */
export type JupiterSpendabilityCause =
  | "spl_account_state_unreadable"
  | "source_balance_read_failed"
  | "native_balance_read_failed"
  | "native_debit_unattributable";

export interface JupiterSpendabilityObservation {
  readonly source: SpendabilityAssetCheck;
  readonly native: SpendabilityAssetCheck;
  /** The measured native debit, or `null` when it could not be measured. */
  readonly debit: JupiterNativeDebit | null;
  /** The SPL source split, when the input side is an SPL balance. */
  readonly splSource: SolanaSplSpendability | null;
}

export interface ObserveJupiterSpendabilityParams {
  readonly connection: Connection;
  /** The taker, as the swap will send it to `/build`. */
  readonly owner: string;
  readonly signer: PublicKey;
  /** The exact message whose signature is being authorized. */
  readonly message: VersionedMessage;
  /** Which balance the input side spends (contract C4.1). */
  readonly inputAsset: SolanaSwapInputAsset;
  /** The provider's own `inAmount` - Vex's 25 bps is already inside it. */
  readonly principalRaw: string;
  readonly inputSymbol: string | null;
  /** The input token's decimals from resolution, used only when no account states one. */
  readonly inputDecimals: number;
}

/**
 * Read both legs for one assembled swap.
 *
 * Never throws for a chain-read failure: an unreadable balance is a FIRST-CLASS
 * outcome that becomes `balance_unavailable`, which fails closed on both the
 * quote and the pre-sign path. Reads run sequentially - the politeness budget
 * on a wallet's own RPC is not a place to fan out.
 */
export async function observeJupiterSwapSpendability(
  params: ObserveJupiterSpendabilityParams,
): Promise<JupiterSpendabilityObservation> {
  const { connection, owner, inputAsset, principalRaw } = params;

  let debit: JupiterNativeDebit | null = null;
  let debitCause: JupiterSpendabilityCause | null = null;
  try {
    debit = await measureJupiterNativeDebit({
      connection,
      message: params.message,
      signer: params.signer,
    });
  } catch {
    debitCause = "native_debit_unattributable";
  }

  let lamports: string | null = null;
  try {
    lamports = await readNativeLamports(connection, owner);
  } catch {
    lamports = null;
  }

  const nativeAsset = {
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    address: SOLANA_NATIVE_PERSISTED_ADDRESS,
    symbol: NATIVE_SYMBOL,
  };
  const observedAt = new Date().toISOString();

  const native: SpendabilityAssetCheck = {
    symbol: NATIVE_SYMBOL,
    // The whole native debit: the principal when SOL itself is spent (it rides
    // in as the wrap transfer), the exact message fee, the certified tip, every
    // wallet-paid account rent, and the measured follow-up reserve.
    requiredRaw: debit?.totalLamports ?? "0",
    read:
      debit === null
        ? { ok: false, asset: nativeAsset, cause: debitCause ?? "native_debit_unattributable" }
        : lamports === null
          ? { ok: false, asset: nativeAsset, cause: "native_balance_read_failed" }
          : {
              ok: true,
              observation: {
                wallet: owner,
                asset: nativeAsset,
                blockTag: PENDING_EQUIVALENT,
                balanceRaw: lamports,
                decimals: SOL_DECIMALS,
                balance: formatRawAmount(lamports, SOL_DECIMALS),
                observedAt,
              },
            },
  };

  if (inputAsset.kind === "native") {
    // ONE read serves both legs (contract C2.5): the principal is paid in
    // lamports and so is every fee, so the source leg asks the smaller question
    // of the same balance - can the principal alone be sent.
    return {
      source: {
        symbol: NATIVE_SYMBOL,
        requiredRaw: principalRaw,
        read:
          lamports === null
            ? { ok: false, asset: nativeAsset, cause: "native_balance_read_failed" }
            : {
                ok: true,
                observation: {
                  wallet: owner,
                  asset: nativeAsset,
                  blockTag: PENDING_EQUIVALENT,
                  balanceRaw: lamports,
                  decimals: SOL_DECIMALS,
                  balance: null,
                  observedAt,
                },
              },
      },
      native,
      debit,
      splSource: null,
    };
  }

  const splAsset = {
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    address: inputAsset.mint,
    symbol: params.inputSymbol,
  };
  let spl: SolanaSplSpendability | null = null;
  try {
    spl = await readSplSpendability(connection, owner, inputAsset.mint);
  } catch {
    spl = null;
  }

  const splCause: JupiterSpendabilityCause | null =
    spl === null
      ? "source_balance_read_failed"
      : spl.malformedOrUnknownAccounts > 0
        ? "spl_account_state_unreadable"
        : null;

  return {
    source: {
      symbol: params.inputSymbol,
      requiredRaw: principalRaw,
      read:
        spl === null || splCause !== null
          ? { ok: false, asset: splAsset, cause: splCause ?? "source_balance_read_failed" }
          : {
              ok: true,
              observation: {
                wallet: owner,
                asset: splAsset,
                blockTag: PENDING_EQUIVALENT,
                // ONLY initialized, non-frozen atoms. Frozen ones are held and
                // reported, and they can never fund a swap.
                balanceRaw: spl.spendableAmountRaw,
                decimals: spl.decimals ?? params.inputDecimals,
                balance: formatRawAmount(spl.spendableAmountRaw, spl.decimals ?? params.inputDecimals),
                observedAt,
              },
            },
    },
    native,
    debit,
    splSource: spl,
  };
}

/**
 * Judge one observation with the shared evaluator.
 *
 * `routeEligibility` is what the ROUTE already earned. Jupiter's `/build`
 * carries no USD legs, so this lane hands in the executable verdict its own
 * route facts support and lets the evaluator decide only the spendability half.
 */
export function judgeJupiterSpendability(
  observation: JupiterSpendabilityObservation,
  routeEligibility: QuoteEligibility,
): { readonly eligibility: QuoteEligibility; readonly preview: SpendabilityPreview | undefined } {
  return evaluateSpendability({
    routeEligibility,
    source: observation.source,
    native: observation.native,
  });
}

/**
 * The refusal an ineligible verdict becomes in the PRE-SIGN window.
 *
 * States the same three figures the approval card carried - required, held,
 * missing - so a person who consented to a quote can see exactly which of them
 * changed underneath it.
 */
export function preSignSpendabilityRefusal(eligibility: QuoteEligibility): VexError | null {
  switch (eligibility.kind) {
    case "insufficient_balance":
      return new VexError(
        ErrorCodes.SOLANA_INSUFFICIENT_BALANCE,
        `Refusing to sign: the wallet no longer holds enough to fund this swap. Required ${formatShortfall(eligibility.required)},`
          + ` spendable ${formatShortfall(eligibility.current)}, short ${formatShortfall(eligibility.missing)}.`,
        "Nothing was signed or broadcast. Fund the wallet or re-quote a smaller amount.",
      );
    case "gas_reserve_insufficient":
      return new VexError(
        ErrorCodes.SOLANA_INSUFFICIENT_BALANCE,
        `Refusing to sign: the wallet cannot cover this swap's full native cost. Required ${formatShortfall(eligibility.required)}`
          + ` lamports (fee, tip, account rent and the follow-up reserve included), held ${formatShortfall(eligibility.current)},`
          + ` short ${formatShortfall(eligibility.missing)}.`,
        "Nothing was signed or broadcast. Add SOL to the wallet, or lower tipLamports, and re-quote.",
      );
    case "balance_unavailable":
      return new VexError(
        ErrorCodes.SOLANA_RPC_ERROR,
        `Refusing to sign: this swap's cost could not be verified before signing (${eligibility.cause}).`,
        "Nothing was signed or broadcast. This is a fail-closed refusal; retry the quote.",
      );
    default:
      return null;
  }
}
