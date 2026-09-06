/**
 * pools.fun launch IPC contract (domain `poolsLaunch`) — the boundary between
 * the untrusted renderer and the process that can sign.
 *
 * THE LAW OF THIS FILE is `token-launch.ts`'s law, restated for a second
 * launchpad: the renderer never holds keys, never signs, and never names an
 * amount that becomes a spend. It sends LOGICAL inputs (what to launch) and, at
 * stage 2, the opaque `fingerprintId` it was given. MAIN derives the money — it
 * reads the gateway's dynamic deployment fee, composes `msg.value`, runs the
 * calldata verifier and binds the authorization. Every object is `.strict()`, so
 * an extra money-shaped key is rejected rather than ignored.
 *
 * ── THE ONE DELIBERATE CARVE-OUT: `feeRecipient` ──────────────────────────
 * This contract DOES carry a recipient on `prepare`, and that is not an
 * oversight to "fix" back. Owner decision (2026-08-18): the system pins the fee
 * recipient to the session wallet on every AGENT launch, and the agent-facing
 * tools have no recipient parameter at all — but the MANUAL form lets the user
 * choose one, exactly as the pools.fun site does, and that choice is authorized
 * by the form itself (form-is-the-approval). It is a LOGICAL input naming who
 * receives a future fee stream, never a fee, value or gas figure reaching a
 * transaction. Main resolves it and echoes back the address, which the form
 * makes the user confirm before Deploy.
 *
 * ── AMOUNTS ───────────────────────────────────────────────────────────────
 * Every amount is a `PoolsAmount`: a raw integer string PLUS the decimals needed
 * to read it, plus the asset it is denominated in. Never a bare number and never
 * a pre-formatted display string — `"1047061"` is 1.05 at six decimals and
 * 0.00105 at nine, and a DTO that omits the decimals is a thousandfold error
 * waiting for a reader to guess (rules/90). There is deliberately NO merged
 * "total": `transactionValue` is exactly `msg.value`, the Vex fee is charged
 * after the launch confirms, and gas is a BOUND. Summing them would present a
 * ceiling and a commitment as one number.
 *
 * `prebuy.amountHuman` travels as the plain decimal the USER TYPED. It is
 * converted once, inside main's prepare, against the pair's on-chain decimals.
 * The renderer must not pre-scale it, and main must not treat it as raw.
 */

import { z } from "zod";
import { rejectForbiddenTokenMetadataText } from "@vex-lib/token-metadata-text-policy.js";
import {
  TOKEN_METADATA_NAME_MAX,
  TOKEN_METADATA_SYMBOL_MAX,
} from "@vex-lib/token-metadata-limits.js";
import { evmAddressSchema } from "./wallets.js";

/** A raw amount: non-negative decimal digits only. No sign, point or exponent. */
const rawAmountSchema = z
  .string()
  .regex(/^\d+$/, "must be a raw non-negative integer amount");

/** Opaque ids. The renderer never parses them; it echoes what it was given. */
const opaqueIdSchema = z.string().min(1).max(128);

/** An https URL. `javascript:`/`data:` can never become a valid value here. */
const httpsUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https:// URL");

/**
 * A human-typed decimal amount. Bounded and shape-checked only: the renderer
 * states what the user typed, and main converts it against on-chain decimals.
 */
const humanAmountSchema = z
  .string()
  .max(64)
  .regex(/^\d+(\.\d+)?$/, "must be a plain decimal amount");

/**
 * A metadata field written to the token's public identity.
 *
 * The forbidden-character policy runs on the RAW string, before any length
 * check, exactly as `token-launch.ts` does it: trimming first is what silently
 * erased a leading newline once, and the launch then proceeded with text nobody
 * had approved.
 */
function onChainMetadataText(field: string) {
  return z.string().check((ctx) => {
    const refusal = rejectForbiddenTokenMetadataText(field, ctx.value);
    if (refusal) ctx.issues.push({ code: "custom", input: ctx.value, message: refusal });
  });
}

/**
 * The pairing options the launch factory allows.
 *
 * `stock` names a KIND and not an asset: it is always accompanied by
 * `pairedStockAddress`, because one of 194 listed tokenised stocks cannot be
 * identified from the word "stock". Which stocks are launchable, and how each is
 * priced, is the factory's answer at the anchored block - no list of them lives
 * in this app.
 */
export const poolsPairedAssetSchema = z.enum(["weth", "usdg", "stock"]);

/** Which asset a fees-to-holders token pays its holders in. The launchpad's own enum. */
export const poolsHolderRewardsModeSchema = z.enum(["token", "paired", "both"]);

/**
 * Decimals per paired asset, used ONLY to refuse an amount the asset cannot
 * represent. NOTHING is converted at this boundary: main converts once, against
 * the pair's decimals read on-chain.
 */
const PAIRED_ASSET_DECIMALS: Readonly<Record<z.infer<typeof poolsPairedAssetSchema>, number>> = {
  weth: 18,
  usdg: 6,
  /**
   * Every tokenised stock on this launchpad is 18 decimals, and this bound is
   * used ONLY to refuse an amount no stock could represent. It is deliberately
   * the LOOSEST honest bound rather than a per-stock table: this app does not
   * know which stock is selected until main reads the factory, and a wrong
   * per-asset guess here would refuse a legitimate amount. A prebuy is refused
   * on a stock pair anyway - the gateway takes a native dev buy only against
   * WETH - so nothing money-bearing rests on this number.
   */
  stock: 18,
};

/**
 * Who receives the creator fee stream. See the carve-out above.
 *
 * `session_wallet` is what an agent path produces and what the manual form
 * defaults to; the other two are manual-form only and are both resolved to an
 * address main echoes back for confirmation.
 */
export const poolsRecipientChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session_wallet") }).strict(),
  z.object({ kind: z.literal("address"), address: evmAddressSchema }).strict(),
  /**
   * THE TOKEN'S OWN HOLDERS, and no address at all.
   *
   * IRREVERSIBLE AND LOCKED AT LAUNCH: the launchpad deploys a rewards
   * distributor during the launch transaction, and the creator earns nothing
   * from trading fees for the life of the token. It carries no address and
   * cannot: the transaction names the gateway's own sentinel constant, which
   * main reads live from that gateway and refuses if it differs. That is why
   * this is the one recipient choice the renderer cannot get wrong.
   */
  z
    .object({ kind: z.literal("holders"), mode: poolsHolderRewardsModeSchema })
    .strict(),
  z
    .object({
      kind: z.literal("x_username"),
      // X's own limit. Shape only — main resolves it and is the authority.
      username: z
        .string()
        .min(1)
        .max(15)
        .regex(/^@?\w{1,15}$/)
        /**
         * A HALF-TYPED ADDRESS IS NOT A USERNAME.
         *
         * `\w` covers digits and letters, so `0x123` — a truncated or mistyped
         * address — matches the username shape. Accepting it would resolve a
         * typo to whoever happens to own that handle, and this field decides
         * where a token's trading fees go PERMANENTLY. There is no recovery from
         * getting it wrong, so the boundary refuses the ambiguity outright
         * rather than guessing which the user meant.
         *
         * The renderer applies the same rule for immediate feedback, but that
         * copy is UX: the renderer is untrusted here, and this is the contract.
         */
        .refine(
          (value) => !/^@?0x/i.test(value),
          "looks like a wallet address rather than an X username; enter the full address instead",
        ),
    })
    .strict(),
]);

/**
 * Where the launch image comes from, mirroring the runtime's own union.
 *
 * A DISCRIMINATED UNION, not a pair of optional fields, so "both sources at
 * once" is UNREPRESENTABLE rather than merely refused. That ambiguity is the
 * exact shape that blanked a real funded launch: two image fields travelled,
 * the provider honoured one and dropped the other in silence. A union cannot
 * express the bug.
 *
 * Both branches are `.strict()`: a `url` carrying an `imageId`, or the reverse,
 * is rejected rather than half-read.
 */
export const poolsLaunchImageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: httpsUrlSchema }).strict(),
  z.object({ kind: z.literal("locker"), imageId: opaqueIdSchema }).strict(),
]);

/**
 * The logical launch inputs.
 *
 * The provider's own field is `imageUrl`. It accepts `image`, answers HTTP 200
 * and SILENTLY DROPS it, which is what left a real funded launch with no
 * picture (probed 2026-08-18). Whatever source the user picked, the runtime is
 * what finally sends `imageUrl`; this contract only says WHERE the picture
 * comes from.
 */
export const poolsLaunchFormSchema = z
  .object({
    name: onChainMetadataText("name").min(1).max(TOKEN_METADATA_NAME_MAX),
    symbol: onChainMetadataText("symbol").min(1).max(TOKEN_METADATA_SYMBOL_MAX),
    pairedAsset: poolsPairedAssetSchema,
    /**
     * WHICH tokenised stock, required when `pairedAsset` is `stock` and refused
     * on any other pair (see the refinement below). `null` on a WETH or USDG
     * launch, spelled exactly one way.
     */
    pairedStockAddress: evmAddressSchema.nullable(),
    /**
     * The picture, from the locker or from a URL. `null` means NO image, spelled
     * exactly one way — the runtime then reports `imageLanded: false` rather
     * than failing quietly.
     *
     * A locker id is OPAQUE and the agent can never mint one; it can only name
     * an id a read tool listed. The runtime resolves it to bytes through the
     * shared image lane and uploads it once.
     */
    image: poolsLaunchImageSchema.nullable(),
    tweetUrl: httpsUrlSchema.nullable(),
    websiteUrl: httpsUrlSchema.nullable(),
    /** Absent, not zero, when no prebuy was asked for. */
    prebuy: z.object({ amountHuman: humanAmountSchema }).strict().nullable(),
    feeRecipient: poolsRecipientChoiceSchema,
  })
  .strict()
  /**
   * THE PREBUY MUST BE REPRESENTABLE IN THE PAIRED ASSET.
   *
   * USDG has six decimals and WETH eighteen, so `1.0000001` is a real amount
   * against one and an untypeable one against the other. Left to travel, the
   * extra digit is resolved by a conversion the user never sees — and a silently
   * truncated money field is a WRONG AMOUNT, not a formatting detail. The
   * boundary refuses it while the user can still fix it (rules/90).
   */
  .refine(
    (form) => {
      if (form.prebuy === null) return true;
      const fraction = form.prebuy.amountHuman.split(".")[1] ?? "";
      return fraction.length <= PAIRED_ASSET_DECIMALS[form.pairedAsset];
    },
    {
      error: "more decimal places than the paired asset can represent",
      path: ["prebuy", "amountHuman"],
    },
  )
  /**
   * A STOCK PAIR NAMES A KIND; THE ADDRESS NAMES THE ASSET.
   *
   * Both directions are refused rather than defaulted. A stock pair with no
   * address identifies nothing, and 194 stocks are launchable - there is no
   * sensible default. An address on a non-stock pair is an input the user
   * believes took effect, and a launch that ignored it would trade against a
   * different asset than the one they picked, permanently.
   */
  .refine(
    (form) => (form.pairedAsset === "stock") === (form.pairedStockAddress !== null),
    {
      error:
        "a stock-paired launch must name which stock, and a stock address belongs only on a stock pair",
      path: ["pairedStockAddress"],
    },
  );

// ── Inputs ──────────────────────────────────────────────────────────────────

export const poolsLaunchPrepareInputSchema = z
  .object({ sessionId: opaqueIdSchema, form: poolsLaunchFormSchema })
  .strict();

export const poolsLaunchDeployInputSchema = z
  .object({ sessionId: opaqueIdSchema, fingerprintId: opaqueIdSchema })
  .strict();

export const poolsLaunchCancelInputSchema = z
  .object({ sessionId: opaqueIdSchema, fingerprintId: opaqueIdSchema })
  .strict();

export const poolsLaunchMyLaunchesInputSchema = z
  .object({
    sessionId: opaqueIdSchema,
    limit: z.number().int().min(1).max(100).optional(),
    /** Runs a claim simulation per row. Costs provider reads, so it is opt-in. */
    includeClaimable: z.boolean().optional(),
  })
  .strict();

export const poolsLaunchGetAwaitingInputSchema = z
  .object({ sessionId: opaqueIdSchema })
  .strict();

/**
 * THE DISMISSAL of an agent-requested form, addressed by the `intentId` the
 * awaiting DTO handed the renderer.
 *
 * A DIFFERENT OBJECT from `poolsLaunchCancelInputSchema` above, and the reason
 * this is a second channel rather than a widened one: that cancel takes the
 * verified `fingerprintId` of a PREPARED launch, this one ends a DRAFT and wakes
 * the agent turn parked on it. A union would let a renderer address the wrong
 * stage with the wrong id and be told nothing about it.
 *
 * The id is OPAQUE and was minted main-side; the renderer echoes what it was
 * given. Session-scoped like every other launch channel, so an intent belonging
 * to another session misses rather than being cancelled from here. There is no
 * fee, value, gas, wallet or recipient field, because nothing this operation
 * does can move money.
 */
export const poolsLaunchCancelAwaitingFormInputSchema = z
  .object({ sessionId: opaqueIdSchema, intentId: opaqueIdSchema })
  .strict();

export const poolsClaimInputSchema = z
  .object({ sessionId: opaqueIdSchema, tokenAddress: evmAddressSchema })
  .strict();

// ── Results ─────────────────────────────────────────────────────────────────

/** A raw amount and everything needed to read it. Never a bare number. */
export const poolsAmountSchema = z
  .object({
    rawWei: rawAmountSchema,
    decimals: z.number().int().min(0).max(36),
    assetAddress: evmAddressSchema,
    assetSymbol: z.string().min(1).max(32),
  })
  .strict();

export const poolsCostBreakdownSchema = z
  .object({
    deploymentFee: poolsAmountSchema,
    prebuy: poolsAmountSchema.nullable(),
    vexFee: poolsAmountSchema,
    /** A CEILING the authorization is taken against, never a point estimate. */
    gasBound: poolsAmountSchema,
    /** `msg.value` exactly. Excludes the Vex fee and gas. */
    transactionValue: poolsAmountSchema,
  })
  .strict();

export const poolsPreparedLaunchSchema = z
  .object({
    fingerprintId: opaqueIdSchema,
    predictedTokenAddress: evmAddressSchema,
    predictedPoolAddress: evmAddressSchema,
    /**
     * The recipient EXACTLY as the calldata carries it.
     *
     * On a holder-rewards launch this is the gateway's SENTINEL, which is not a
     * wallet and is not where the fees end up - the gateway resolves it to the
     * distributor it deploys during the launch. `holderRewards` below is what
     * says so, and the confirmation screen renders THAT rather than presenting a
     * sentinel as somebody's address.
     */
    resolvedFeeRecipient: evmAddressSchema,
    /** Present exactly when the fee stream was directed to the holders. */
    holderRewards: z
      .object({ mode: poolsHolderRewardsModeSchema, sentinel: evmAddressSchema })
      .strict()
      .optional(),
    pairedAsset: poolsPairedAssetSchema,
    pairedAssetAddress: evmAddressSchema,
    /**
     * The hash of the EXACT bytes the Deploy click will sign, over
     * `(chainId, to, calldata, value)`.
     *
     * Shown because it is the identity of what is being authorized: every other
     * figure on the confirmation screen is a rendering of these bytes, and this
     * is the one value that changes if any of them do.
     */
    callFingerprint: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    costs: poolsCostBreakdownSchema,
    /**
     * The published metadata document, as the PROVIDER reports it.
     *
     * Deliberately not allowlisted to `https:` — the hosting scheme is the
     * backend's choice and refusing an unfamiliar one would fail the whole
     * prepare over a display field. But it is provider-authored text crossing
     * into the renderer, so the schemes that EXECUTE are refused outright: this
     * value is one careless `href` away from being a sink, and the refusal costs
     * nothing a real metadata URI would ever need (rules/06).
     */
    metadataUri: z
      .string()
      .max(2048)
      .refine(
        (value) => !/^\s*(javascript|data|vbscript):/i.test(value),
        "must not carry an executable URL scheme",
      ),
    /**
     * Whether the image actually landed in the published metadata. LOAD-BEARING:
     * `false` means the provider took the request and dropped the picture, and
     * the form must say so before the user deploys a token that will render
     * blank everywhere.
     */
    imageLanded: z.boolean(),
    /** After this, the fingerprint is refused and a fresh prepare is required. */
    expiresAt: z.string().min(1).max(64),
    /**
     * WHY it expires then, because the three possible clocks differ by two
     * orders of magnitude and a countdown with no cause is unactionable: a
     * SIGNED_STOCK pair's backend-signed price quote lives for seconds
     * (`quote_window`), the calldata's own deadline bounds every launch
     * (`gateway_deadline`), and Vex's own window exists because the deployment
     * fee moves (`vex_window`).
     */
    expiryReason: z.enum(["quote_window", "gateway_deadline", "vex_window"]),
  })
  .strict();

export const poolsDeployedLaunchSchema = z
  .object({
    tokenAddress: evmAddressSchema,
    poolAddress: evmAddressSchema,
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    activityId: z.number().int(),
    resolvedFeeRecipient: evmAddressSchema,
    /** Main's own sentence about what happened. Rendered verbatim. */
    message: z.string().min(1).max(2000),
  })
  .strict();

export const poolsClaimPreviewSchema = z
  .object({
    tokenAddress: evmAddressSchema,
    tokenLeg: poolsAmountSchema,
    pairedLeg: poolsAmountSchema,
    /**
     * What the locker says was ALREADY COLLECTED. Never a claimable total: the
     * mappings read 0/0 while a simulation returned a real amount, so labelling
     * them "claimable" would tell the user there is nothing to claim.
     */
    alreadyCollected: z
      .object({ tokenLeg: poolsAmountSchema, pairedLeg: poolsAmountSchema })
      .strict(),
    gasBound: poolsAmountSchema,
  })
  .strict();

export const poolsClaimedFeesSchema = z
  .object({
    tokenAddress: evmAddressSchema,
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    activityId: z.number().int(),
    tokenLeg: poolsAmountSchema,
    pairedLeg: poolsAmountSchema,
    message: z.string().min(1).max(2000),
  })
  .strict();

export const poolsMyLaunchRowSchema = z
  .object({
    tokenAddress: evmAddressSchema,
    poolAddress: evmAddressSchema.nullable(),
    name: z.string().max(256).nullable(),
    symbol: z.string().max(64).nullable(),
    pairedAsset: z.string().max(32),
    launchedAt: z.string().max(64),
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable(),
    feeRecipient: evmAddressSchema.nullable(),
    /**
     * NULL means NOT MEASURED, never "nothing to claim". The distinction is the
     * difference between "we did not look" and "we looked and it was empty".
     */
    claimable: z
      .object({ tokenLeg: poolsAmountSchema, pairedLeg: poolsAmountSchema })
      .strict()
      .nullable(),
  })
  .strict();

export const poolsLaunchMyLaunchesResultSchema = z
  .object({ wallet: evmAddressSchema, launches: z.array(poolsMyLaunchRowSchema) })
  .strict();

export const poolsAwaitingLaunchFormSchema = z
  .object({
    intentId: opaqueIdSchema,
    expiresAt: z.string().min(1).max(64),
    /** Whatever the agent proposed, for the form to pre-fill. All optional. */
    proposed: z
      .object({
        name: z.string().max(TOKEN_METADATA_NAME_MAX).optional(),
        symbol: z.string().max(TOKEN_METADATA_SYMBOL_MAX).optional(),
        pairedAsset: poolsPairedAssetSchema.optional(),
        /**
         * WHICH tokenised stock the agent proposed. Present only on a `stock`
         * pair, validated by the SAME address schema the deploy path uses, and
         * never invented: absent means the form opens with an empty box rather
         * than with an address nobody chose.
         */
        pairedStockAddress: evmAddressSchema.optional(),
        image: poolsLaunchImageSchema.optional(),
        tweetUrl: httpsUrlSchema.optional(),
        websiteUrl: httpsUrlSchema.optional(),
        prebuyAmountHuman: humanAmountSchema.optional(),
      })
      .strict(),
  })
  .strict();

/**
 * `null` is the ORDINARY case — no form is waiting. It is deliberately not a
 * refusal: an idle session is not an error, and mapping it onto an error code
 * would turn every poll of a quiet session into a visible failure.
 */
export const poolsLaunchGetAwaitingResultSchema = z
  .object({ awaiting: poolsAwaitingLaunchFormSchema.nullable() })
  .strict();

export const poolsLaunchCancelResultSchema = z
  .object({ cancelled: z.boolean() })
  .strict();

/**
 * What the dismissal did, in two booleans that answer different questions.
 *
 * `cancelled: false` is a SUCCESS, not a failure: the form was submitted or
 * swept in the same instant, so there was nothing live left to cancel and
 * whoever won that race owns the parked call's one result.
 * `resumedAgentTurn` reports whether the agent's turn was ACTUALLY woken, never
 * that a wake was attempted - a busy lease leaves the turn owed and the
 * launch-form expiry sweep's durable floor finds it again.
 */
export const poolsLaunchCancelAwaitingFormResultSchema = z
  .object({ cancelled: z.boolean(), resumedAgentTurn: z.boolean() })
  .strict();

// ── the push event (main -> renderer) ────────────────────────────────────────

/** Literal kept in sync with the engine `LAUNCH_FORM_EVENT_TYPE`. */
export const LAUNCH_FORM_EVENT_TYPE = "engine.launch.form" as const;

export const launchFormEventKindSchema = z.enum(["requested"]);
export type LaunchFormEventKind = z.infer<typeof launchFormEventKindSchema>;

/**
 * Renderer-facing launch-form event.
 *
 * Mirrors the engine's `LaunchFormEvent`
 * (`src/vex-agent/engine/runtime/launch-form-bus.ts`), emitted only AFTER the
 * `awaiting_user_form` insert has COMMITTED. The renderer treats it purely as an
 * invalidation signal - it reconstructs no draft from the payload and instead
 * re-reads `poolsLaunch.getAwaiting`, with the DB as source of truth.
 *
 * Bounded to ids, an enum and a timestamp: no token name, symbol, description or
 * amount rides this event.
 */
export const launchFormEventSchema = z
  .object({
    type: z.literal(LAUNCH_FORM_EVENT_TYPE),
    sessionId: z.string().uuid(),
    intentId: opaqueIdSchema,
    kind: launchFormEventKindSchema,
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type LaunchFormEvent = z.infer<typeof launchFormEventSchema>;

// ── Inferred types ──────────────────────────────────────────────────────────

export type PoolsPairedAsset = z.infer<typeof poolsPairedAssetSchema>;
export type PoolsHolderRewardsMode = z.infer<typeof poolsHolderRewardsModeSchema>;
export type PoolsLaunchImage = z.infer<typeof poolsLaunchImageSchema>;
export type PoolsRecipientChoice = z.infer<typeof poolsRecipientChoiceSchema>;
export type PoolsLaunchFormInput = z.infer<typeof poolsLaunchFormSchema>;
export type PoolsLaunchPrepareInput = z.infer<typeof poolsLaunchPrepareInputSchema>;
export type PoolsLaunchDeployInput = z.infer<typeof poolsLaunchDeployInputSchema>;
export type PoolsLaunchCancelInput = z.infer<typeof poolsLaunchCancelInputSchema>;
export type PoolsLaunchCancelAwaitingFormInput = z.infer<
  typeof poolsLaunchCancelAwaitingFormInputSchema
>;
export type PoolsLaunchMyLaunchesInput = z.infer<typeof poolsLaunchMyLaunchesInputSchema>;
export type PoolsLaunchGetAwaitingInput = z.infer<typeof poolsLaunchGetAwaitingInputSchema>;
export type PoolsClaimInput = z.infer<typeof poolsClaimInputSchema>;

export type PoolsAmount = z.infer<typeof poolsAmountSchema>;
export type PoolsCostBreakdown = z.infer<typeof poolsCostBreakdownSchema>;
export type PoolsPreparedLaunch = z.infer<typeof poolsPreparedLaunchSchema>;
export type PoolsDeployedLaunch = z.infer<typeof poolsDeployedLaunchSchema>;
export type PoolsClaimPreview = z.infer<typeof poolsClaimPreviewSchema>;
export type PoolsClaimedFees = z.infer<typeof poolsClaimedFeesSchema>;
export type PoolsMyLaunchRow = z.infer<typeof poolsMyLaunchRowSchema>;
export type PoolsLaunchMyLaunchesResult = z.infer<typeof poolsLaunchMyLaunchesResultSchema>;
export type PoolsAwaitingLaunchForm = z.infer<typeof poolsAwaitingLaunchFormSchema>;
export type PoolsLaunchGetAwaitingResult = z.infer<typeof poolsLaunchGetAwaitingResultSchema>;
export type PoolsLaunchCancelResult = z.infer<typeof poolsLaunchCancelResultSchema>;
export type PoolsAwaitingFormCancelResult = z.infer<
  typeof poolsLaunchCancelAwaitingFormResultSchema
>;
