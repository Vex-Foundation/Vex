import { ErrorCodes, VexError } from "../../../../errors.js";
import type { LighterAccountResponse } from "@tools/lighter/types.js";
import { resolveSelectedAddressForRead } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ProtocolExecutionContext } from "../types.js";

/**
 * SWITCH `LIGHTER_SIGNING_OWNERSHIP_RECHECK` (deps override
 * `signingOwnershipRecheck` on the create-order execution deps). Lifecycle
 * and OCO use independent switches with the same judgment.
 *
 * The preview binds an order to the account the SESSION'S selected wallet
 * owns (`resolveSessionBoundPreviewAccountIndex`, through
 * `readUniqueLighterMasterAccount`), so one wallet's session can never sign on
 * another wallet's account. Before this switch that binding was proven only
 * at preview: the approve path checked that the registered API key matches
 * the vault's key, which two wallets with their own keys both pass.
 *
 * ON re-proves it before signing, from the account the post-approval
 * revalidation already reads fresh by index (no extra REST call): that
 * account's `l1_address` must be the session's selected wallet now, and, when
 * Lighter reports the account's type, it must be a master account (type 0),
 * the rule the preview applies. It runs after every existing revalidation
 * check, before the revalidation evidence is written, so every existing
 * refusal keeps its precedence and no signing load or nonce write follows
 * an ownership refusal. The approved pristine row remains until existing
 * expiry recovery retires it; the approve-handler decision CAS cannot replay it.
 *
 * A trusted default context with no EVM wallet configured at all is the one
 * lane the preview lets through without proving ownership (it trades the
 * single saved account instead); the re-check mirrors that and does not
 * refuse it. OFF (`false`) is today's path.
 */
export const LIGHTER_SIGNING_OWNERSHIP_RECHECK = true;

/** The session wallet the approve path executes under, as the preview resolves it. */
export type LighterSigningOwnershipWallet =
  /** The session's selected EVM wallet (or, in a trusted default context, the primary one). */
  | { readonly kind: "wallet"; readonly address: string }
  /** Trusted default context with no EVM wallet configured: the preview proved no ownership either. */
  | { readonly kind: "trusted_default_without_wallet" }
  /** No usable selected wallet now (deselected, removed, drifted, or the session policy refuses it). */
  | { readonly kind: "unavailable" };

/**
 * Resolve the wallet exactly as `resolveSessionBoundPreviewAccountIndex`
 * resolves it at preview, from the approve call's own context.
 */
export function resolveLighterSigningOwnershipWallet(
  context: Pick<ProtocolExecutionContext, "walletResolution" | "walletPolicy">,
): LighterSigningOwnershipWallet {
  try {
    return {
      kind: "wallet",
      address: resolveSelectedAddressForRead(context.walletResolution, context.walletPolicy, "eip155"),
    };
  } catch (error) {
    if (
      context.walletResolution.source === "default"
      && error instanceof VexError
      && error.code === ErrorCodes.WALLET_NOT_CONFIGURED
    ) {
      return { kind: "trusted_default_without_wallet" };
    }
    return { kind: "unavailable" };
  }
}

export const LIGHTER_SIGNING_OWNERSHIP_WALLET_UNAVAILABLE =
  "The wallet selected for this session is no longer available, so Vex could not confirm it still owns this Lighter account. No trading key was loaded and no order was signed or submitted.";
export const LIGHTER_SIGNING_OWNERSHIP_NOT_OWNED =
  "This Lighter account no longer belongs to the selected wallet. No trading key was loaded and no order was signed or submitted.";
export const LIGHTER_SIGNING_OWNERSHIP_NOT_MASTER =
  "This Lighter account is not the selected wallet's master account. No trading key was loaded and no order was signed or submitted.";

export type LighterSigningOwnershipOutcome =
  | { readonly kind: "matched"; readonly accountTypeReported: boolean }
  | { readonly kind: "skipped_trusted_default" }
  | { readonly kind: "refused"; readonly reason: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Judge the fresh account against the session wallet. `wallet` absent means
 * the caller supplied none, which is never a lane that proved ownership, so
 * it refuses like an unavailable wallet.
 */
export function judgeLighterSigningOwnership(input: {
  readonly accountIndex: number;
  readonly account: LighterAccountResponse;
  readonly wallet: LighterSigningOwnershipWallet | undefined;
  /** Lifecycle material is already loaded for read-only auth, before signing. */
  readonly signingMaterialAlreadyLoaded?: boolean;
}): LighterSigningOwnershipOutcome {
  const { wallet } = input;
  const refused = (reason: string): LighterSigningOwnershipOutcome => ({
    kind: "refused",
    reason: input.signingMaterialAlreadyLoaded === true
      ? reason.replace("No trading key was loaded and no order was signed or submitted.", "No lifecycle transaction was signed or submitted.")
      : reason,
  });
  if (wallet?.kind === "trusted_default_without_wallet") return { kind: "skipped_trusted_default" };
  if (wallet === undefined || wallet.kind === "unavailable" || !ADDRESS.test(wallet.address.trim())) {
    return refused(LIGHTER_SIGNING_OWNERSHIP_WALLET_UNAVAILABLE);
  }
  const rows = input.account.accounts.filter((row) => (row.index ?? row.account_index) === input.accountIndex);
  const row = rows.length === 1 ? rows[0] : undefined;
  const owner = typeof row?.l1_address === "string" ? row.l1_address.trim() : "";
  if (row === undefined || !ADDRESS.test(owner) || owner.toLowerCase() !== wallet.address.trim().toLowerCase()) {
    return refused(LIGHTER_SIGNING_OWNERSHIP_NOT_OWNED);
  }
  const accountType: unknown = row.account_type;
  if (accountType === undefined || accountType === null) return { kind: "matched", accountTypeReported: false };
  if (accountType !== 0) return refused(LIGHTER_SIGNING_OWNERSHIP_NOT_MASTER);
  return { kind: "matched", accountTypeReported: true };
}
