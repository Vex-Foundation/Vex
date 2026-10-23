/**
 * `vex:vexCloud:*` - Vex Cloud sign-in and account. Funding (deposit,
 * withdraw, cashback, history) lives in `./vex-cloud-funding.ts`; auto
 * top-up is phase 3.
 *
 * THE BOUNDARY THIS CONTRACT DEFENDS. The renderer holds no key, no session
 * bearer and no message to sign. It sends the set of in-app EVM wallets the
 * user saw beside the consent, and main refuses if the inventory it signs
 * with differs from that set: the consent binds to exactly the wallets on
 * screen. Main builds and signs the EIP-4361 messages itself, stores the
 * bearer in the vault, and hands back only public account facts.
 *
 * MONEY TRAVELS WHOLE. Every balance is a raw integer string in wei with its
 * decimals and symbol beside it; the USD figure is the backend's own integer
 * micro-USD estimate at its rate, or `null` when no fresh rate exists. Nothing
 * here is a float or a preformatted string.
 */

import { z } from "zod";
import { evmAddressSchema } from "./wallets.js";

/** The in-app EVM wallet cap per family (owner decision D6). */
export const VEX_CLOUD_MAX_LOCAL_WALLETS = 3;
/** Generous bound on a remote account's linked set (the backend links at most 8 per request). */
export const VEX_CLOUD_MAX_LINKED_WALLETS = 32;

const isoTimestampSchema = z.string().datetime({ offset: true });
/** Raw integer amount: digits only, no sign, point or exponent. */
const rawIntegerSchema = z.string().regex(/^[0-9]{1,78}$/, "must be a raw non-negative integer");

export const vexCloudAmountSchema = z
  .object({
    /** Raw amount in wei. */
    wei: rawIntegerSchema,
    decimals: z.literal(18),
    symbol: z.literal("VEX"),
    /** Backend estimate in integer micro-USD at its current rate; null without a fresh rate. */
    usdMicroEstimate: rawIntegerSchema.nullable(),
  })
  .strict();
export type VexCloudAmount = z.infer<typeof vexCloudAmountSchema>;

export const vexCloudBalancesSchema = z
  .object({
    available: vexCloudAmountSchema,
    provisional: vexCloudAmountSchema,
    reserved: vexCloudAmountSchema,
    pendingWithdrawal: vexCloudAmountSchema,
    claimable: vexCloudAmountSchema,
    /**
     * Cashback earned on provisional spend, released when that deposit
     * finalizes: pending, NOT claimable. `null` from a backend that does not
     * report it.
     */
    cashbackPending: vexCloudAmountSchema.nullable(),
  })
  .strict();
export type VexCloudBalances = z.infer<typeof vexCloudBalancesSchema>;

export const vexCloudRateSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(true),
      /** Rate source label from the backend (`fixed` locally, `twap` in production). */
      source: z.string().regex(/^[a-z0-9_]{1,32}$/),
      observedAt: isoTimestampSchema,
      ageSeconds: z.number().int().nonnegative(),
      /**
       * VEX wei per micro-USD as the backend's exact decimal string (up to 18
       * fractional digits); `@shared/vex-cloud-money.js` `parseRateX18` reads it.
       */
      vexWeiPerMicroUsd: z.string().regex(/^[0-9]{1,60}(\.[0-9]{1,18})?$/),
      /** The backend uses this rate for new decisions strictly before this instant. */
      validUntil: isoTimestampSchema,
    })
    .strict(),
  z
    .object({
      available: z.literal(false),
      /** Why there is no rate (`stale`, `warming`, ...), from the backend. */
      reason: z.string().regex(/^[a-z0-9_]{1,64}$/),
    })
    .strict(),
]);
export type VexCloudRate = z.infer<typeof vexCloudRateSchema>;

export const vexCloudLinkedWalletSchema = z
  .object({
    address: evmAddressSchema,
    linkedAt: isoTimestampSchema,
  })
  .strict();

/**
 * The backend's money limits, raw: micro-USD integers, and the remaining
 * daily withdrawal in wei. `null` where the backend sends none (the daily
 * figures while its rate is unavailable, or a backend that predates them).
 */
export const vexCloudLimitsSchema = z
  .object({
    minDepositMicroUsd: rawIntegerSchema,
    minWithdrawMicroUsd: rawIntegerSchema,
    provisionalCapMicroUsd: rawIntegerSchema,
    withdrawDailyLimitMicroUsd: rawIntegerSchema.nullable(),
    withdrawDailyRemainingWei: rawIntegerSchema.nullable(),
  })
  .strict();
export type VexCloudLimits = z.infer<typeof vexCloudLimitsSchema>;

export const vexCloudAccountSchema = z
  .object({
    accountId: z.string().uuid(),
    /** Paused for review by the backend: inference is refused until cleared. */
    paused: z.boolean(),
    wallets: z.array(vexCloudLinkedWalletSchema).max(VEX_CLOUD_MAX_LINKED_WALLETS).readonly(),
    balances: vexCloudBalancesSchema,
    /**
     * What may leave the account now (only finalized deposits reach it), or
     * `null` from a backend that does not report it yet ("Not available").
     */
    withdrawable: vexCloudAmountSchema.nullable(),
    /** The backend's deposit address, as it reports it; `null` when it has none. */
    depositAddress: evmAddressSchema.nullable(),
    limits: vexCloudLimitsSchema,
    rate: vexCloudRateSchema,
    /** When main read this account from the backend. */
    readAt: isoTimestampSchema,
  })
  .strict();
export type VexCloudAccount = z.infer<typeof vexCloudAccountSchema>;

/**
 * Funding is enabled only when the deposit address pinned in this build
 * equals the backend's (plan 15.6). `not_open`: the build pins none yet, or
 * the backend has none configured ("Deposits open soon"); `mismatch`: the
 * two differ, funding is disabled
 * and the screen says so; `matches`: deposits go to `address`.
 */
export const vexCloudDepositPinSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_open") }).strict(),
  z.object({ state: z.literal("matches"), address: evmAddressSchema }).strict(),
  z
    .object({
      state: z.literal("mismatch"),
      pinned: evmAddressSchema,
      backend: evmAddressSchema,
    })
    .strict(),
]);
export type VexCloudDepositPin = z.infer<typeof vexCloudDepositPinSchema>;

/** The in-app EVM wallets that would sign, checksummed, in inventory order. */
const localWalletsSchema = z.array(evmAddressSchema).max(VEX_CLOUD_MAX_LOCAL_WALLETS).readonly();

// ── account ──────────────────────────────────────────────────────────────

export const vexCloudAccountInputSchema = z.object({}).strict();
export type VexCloudAccountInput = z.infer<typeof vexCloudAccountInputSchema>;

export const vexCloudAccountResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("signed_out"),
      /**
       * `not_signed_in`: no session is stored. `session_expired`: the backend
       * answered 401 and the stored session was removed (a clean signed-out
       * state, never a half one).
       */
      reason: z.enum(["not_signed_in", "session_expired"]),
      localWallets: localWalletsSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("signed_in"),
      account: vexCloudAccountSchema,
      localWallets: localWalletsSchema,
      /** Main's verdict on the deposit address pinned in this build (plan 15.6). */
      depositPin: vexCloudDepositPinSchema,
    })
    .strict(),
]);
export type VexCloudAccountResult = z.infer<typeof vexCloudAccountResultSchema>;

// ── signIn ───────────────────────────────────────────────────────────────

export const vexCloudSignInInputSchema = z
  .object({
    /**
     * The wallets the user saw listed beside the consent. Main signs only
     * when its own inventory is exactly this set (case-insensitive); any
     * difference is refused by name and nothing is signed.
     */
    wallets: z.array(evmAddressSchema).min(1).max(VEX_CLOUD_MAX_LOCAL_WALLETS),
  })
  .strict();
export type VexCloudSignInInput = z.infer<typeof vexCloudSignInInputSchema>;

export const vexCloudSignInResultSchema = z
  .object({
    accountId: z.string().uuid(),
    /** A new account was created by this sign-in. */
    created: z.boolean(),
    /** In-app wallets linked to the account by this sign-in (lowercase). */
    linkedNow: z.array(evmAddressSchema).max(VEX_CLOUD_MAX_LOCAL_WALLETS).readonly(),
    /**
     * The account as read right after sign-in, or `null` when that read
     * failed (the session is stored either way; the next `account` read
     * answers).
     */
    account: vexCloudAccountSchema.nullable(),
  })
  .strict();
export type VexCloudSignInResult = z.infer<typeof vexCloudSignInResultSchema>;

// ── signOut ──────────────────────────────────────────────────────────────

export const vexCloudSignOutInputSchema = z.object({}).strict();
export type VexCloudSignOutInput = z.infer<typeof vexCloudSignOutInputSchema>;

export const vexCloudSignOutResultSchema = z
  .object({
    /** The stored session was removed (true also when none was stored). */
    signedOut: z.literal(true),
  })
  .strict();
export type VexCloudSignOutResult = z.infer<typeof vexCloudSignOutResultSchema>;
