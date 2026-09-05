/**
 * pools.fun (api.bankr.bot) wire types.
 *
 * Every field is grounded in captured bytes (`src/__tests__/pools-fun/fixtures/
 * live-captures/`), not in provider docs - there are none. The tolerant-reader
 * split (rule 90) is encoded in the optionality: identity and provenance fields
 * are required, every display number is nullable.
 *
 * TRAPS proven live and baked into these types:
 * - `decimals` and `totalSupply` are NULL on every `platform=poolsfun` row and
 *   PRESENT on `platform=sushi` rows (18 / a raw string). A reader that assumes
 *   either shape breaks on half the market, and neither value is trusted for a
 *   financial decision - decimals are read on-chain.
 * - `poolId` is a 20-byte ADDRESS on pools.fun and sushi rows (it is the Sushi
 *   V3 pool). The same key is a 32-byte Uniswap-V4 pool id on the Bankr/Doppler
 *   rows the API returns when `platform` is omitted, which is one more reason
 *   the client never omits it.
 * - `pairedAsset` is `weth` | `usdg` | `stock`; a `stock` row also carries
 *   `pairedStock: {address, symbol}` (measured live on AAPL Cat).
 * - Prices, volumes, market cap and price changes are DISPLAY-GRADE floats with
 *   no decimals metadata. They never reach a trade decision; kyberswap quotes
 *   are the financial truth.
 */

import type { PoolsPlatform, PoolsRowPlatform } from "./constants.js";

/** The stock a `pairedAsset: "stock"` row is paired against. */
export interface PoolsPairedStock {
  address: string;
  symbol: string;
}

/**
 * One `/discover` row.
 *
 * `tokenAddress`, `poolId`, `platform`, `pairedAsset` and `deployedAt` are the
 * identity/provenance set and are strict. `decimals` and `totalSupply` are kept
 * on the type because the wire carries them, but they are display-tolerant and
 * are deliberately NOT projected into any tool output.
 */
export interface PoolsToken {
  tokenAddress: string;
  poolId: string;
  /** Pinned: a validated row is always a Robinhood row (see `validation/token.ts`). */
  chain: "robinhood";
  /** A row's launcher is never the `all` SELECTOR - see `PoolsRowPlatform`. */
  platform: PoolsRowPlatform;
  pairedAsset: string;
  pairedStock: PoolsPairedStock | null;
  name: string | null;
  symbol: string | null;
  /** Null on every pools.fun row; 18 on sushi rows. Never a financial input. */
  decimals: number | null;
  /** Raw string on sushi rows, null on pools.fun rows. Never a financial input. */
  totalSupply: string | null;
  imageUri: string | null;
  deployerAddress: string | null;
  deployerXUsername: string | null;
  feeRecipientAddress: string | null;
  feeRecipientXUsername: string | null;
  tweetUrl: string | null;
  websiteUrl: string | null;
  /** ISO timestamp of the launch. Strict - it is what `maxAgeHours` is read against. */
  deployedAt: string;
  lastTradeAt: string | null;
  lastPriceEth: number | null;
  lastPriceUsd: number | null;
  marketCapUsd: number | null;
  vol1m: number | null;
  vol5m: number | null;
  vol1h: number | null;
  vol6h: number | null;
  vol24h: number | null;
  txCount24h: number | null;
  priceChange1m: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange6h: number | null;
  priceChange24h: number | null;
  /**
   * The provider's own claim that this token carries a Vex attestation.
   *
   * PRESENT ONLY WHEN TRUE on the wire (4 rows of a 100-row page, 2026-09-04),
   * so the absence of the key is "the launchpad makes no such claim", never
   * "the launchpad says no". Typed `boolean | null` and normalised to `null`
   * when absent so that the difference survives into the projection.
   *
   * It is the LAUNCHPAD's statement about its own index, not a Vex-side proof:
   * the authority for an attestation Vex made is Vex's own attest record.
   */
  vexAttested: boolean | null;
  /**
   * Which legs a fees-to-holders token streams to its holders, as the launchpad
   * labels it: `token`, `paired` or `both`. Absent on tokens that did not opt in.
   *
   * DISPLAY-GRADE, AND DELIBERATELY NOT AN ENUM HERE. The MODE authority is the
   * `DistributorDeployed(token, distributor, uint8 rewardMode)` event emitted by
   * the suite's HolderRewardsDeployer (plan v3 section 9); this field is the
   * provider's echo of it, and `pools__holder_rewards_get` reports any
   * disagreement in words rather than silently preferring one.
   */
  holderRewardsMode: string | null;
  /**
   * The distributor contract the launchpad names for this token. Equal to the
   * row's `feeRecipientAddress` on every row that carries it (measured).
   *
   * Still an ECHO: the on-chain answer is the deployer's event, and the read
   * tool cross-checks this value against it.
   */
  holderRewardsDistributor: string | null;
  /**
   * The launchpad's own brand check, present only on rows it flags:
   * `{status: "unofficial", revision: n}`. The pools.fun web app renders it as a
   * "Not official" warning badge, so it is a WARNING about brand collision and
   * not a property of the token's contract.
   */
  poolsFunBrand: PoolsFunBrand | null;
  /**
   * The launchpad's flag that the tokenised stock this token is paired against
   * is illiquid. Present only when true (1 row of 100, measured).
   *
   * DISPLAY ONLY, and it has NO launch-time authority (plan v3 section 9): a
   * pair that is not yet listed has no liquidity history to be flagged from, so
   * an absent flag is not a liquidity promise.
   */
  pairedStockIlliquid: boolean | null;
}

/**
 * The launchpad's brand verdict on a row.
 *
 * `status` is kept as a string rather than a literal union: the only value
 * measured is `"unofficial"`, and a second verdict the provider invents must
 * reach the agent as the provider's own word instead of taking the page down.
 */
export interface PoolsFunBrand {
  status: string;
  revision: number | null;
}

/** A `/discover` page: rows plus the opaque cursor for the next one. */
export interface PoolsDiscoverPage {
  results: PoolsToken[];
  /** `null` on the last page (and on an empty result). */
  nextCursor: string | null;
}

/**
 * One candle, already lifted out of the wire's positional array.
 *
 * The wire sends `[unixSeconds, open, high, low, close, volumeUsd]`. A
 * positional array reaching the agent is a misread waiting to happen, so the
 * validator names the members here and nothing downstream sees the tuple.
 */
export interface PoolsCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

/** `/discover/{token}/ohlcv` response. */
export interface PoolsCandles {
  candles: PoolsCandle[];
  pool: { address: string; network: "robinhood" } | null;
  pair: { baseSymbol: string | null; quoteSymbol: string | null } | null;
}

// -- Launch preparation (gateway path) -------------------------------

/**
 * The identities the launchpad will resolve a fee recipient FROM.
 *
 * The provider names these four itself, in the zod error it answers a wrong
 * `type` with (probed 2026-08-19). Vex only ever sends two of them: `wallet` for
 * an address, `x` for a handle a human typed into the manual form. `farcaster`
 * and `ens` are recorded because they are part of the measured contract, not
 * because anything sends them.
 */
export type PoolsFeeRecipientType = "x" | "farcaster" | "ens" | "wallet";

/**
 * The fee recipient AS THE REQUEST CARRIES IT.
 *
 * CHANGED UNDER US on/before 2026-08-19: this field used to be a bare string and
 * is now this object. A bare string is answered HTTP 400 `feeRecipient: Invalid
 * input: expected object, received string`, which made every Vex launch fail -
 * Vex always states the recipient explicitly (owner decision 3), so there was no
 * path that avoided it. See `agents_dm/pools-fun-live/artifacts/
 * fee-recipient-shape-probe.json` for the enumerated sweep that recovered the
 * schema.
 */
export interface PoolsPrepareFeeRecipient {
  readonly type: PoolsFeeRecipientType;
  /** An address for `wallet`, a handle for `x` - whatever `type` names. */
  readonly value: string;
}

/**
 * The fee recipient AS THE RESPONSE RETURNS IT: the launchpad's resolution.
 *
 * `address` is FINANCIALLY CONSUMED - it is what the verifier's point 4 holds
 * the signed tuple to, and on the X-handle path it is the only statement of
 * where the fee stream goes - so it is strict. `display` is a truncated label
 * for a UI (`"0x33eF…d2fA"`) and is tolerated absent, per the module's
 * tolerant-reader split.
 */
export interface PoolsResolvedFeeRecipient {
  readonly address: string;
  readonly display: string | null;
}

/**
 * The paired asset AS THE PREPARE RESPONSE RETURNS IT - an object, where the
 * request sends a bare string name (`"weth"` / `"usdg"`).
 *
 * NOTHING CONSUMES THIS. Which asset the launch actually pairs against is proven
 * from the decoded TUPLE against the caller's expectation (verifier point 5), so
 * this block is informational only and every field but the address is display-
 * tolerant. It is typed because the validator must not throw on it, which is
 * what it did while this was declared a string.
 */
export interface PoolsPreparedPairedAsset {
  readonly address: string;
  readonly kind: string | null;
  readonly symbol: string | null;
  readonly decimals: number | null;
}

/**
 * The prepare request, as the provider actually accepts it.
 *
 * `imageUrl` is the field that WORKS. `image` is accepted with HTTP 200 and
 * silently dropped - the pinned metadata simply has no image key, which is what
 * left the first funded launch rendering blank (probed 2026-08-18, six shapes,
 * only this one landed). The wire name and the metadata key deliberately
 * differ: the backend rewrites this URL into an `ipfs://` CID under `image`.
 */
export interface PoolsPrepareRequest {
  readonly tokenName: string;
  readonly pairedAsset: string;
  readonly expectedDeploymentFeeWei: string;
  readonly expectedGatewayVersion: number;
  readonly creatorAddress: string;
  readonly tokenSymbol?: string | undefined;
  readonly imageUrl?: string | undefined;
  readonly tweetUrl?: string | undefined;
  readonly websiteUrl?: string | undefined;
  /** The identity to pay, as `{type, value}`. See `PoolsPrepareFeeRecipient`. */
  readonly feeRecipient?: PoolsPrepareFeeRecipient | undefined;
  readonly pairedStockAddress?: string | undefined;
  readonly devBuyEth?: string | undefined;
  readonly devBuyAmount?: string | undefined;
}

/**
 * The prepare response: ready-to-sign `Gateway.launch(tuple)` calldata plus the
 * mirrored fields the verifier cross-checks the decoded tuple against.
 *
 * NOTHING here is trusted. Every field is re-proven against the decoded
 * calldata and against the chain before signing - that is the entire point of
 * the verifier, and it is why these are typed as data to check rather than
 * values to use.
 */
export interface PoolsPrepareResponse {
  /** `true` means the quote is stale and the whole prepare must be redone. */
  readonly requiresReprepare: boolean;
  readonly to: string;
  readonly data: string;
  /**
   * The native value to send, NORMALISED to a decimal wei string.
   *
   * The wire sends this one amount HEX-encoded (`"0x3bc7def507320"`) while every
   * other amount on this response is decimal - the provider builds it with a
   * transaction serialiser. The validator normalises rather than propagating
   * that split: a hex string sitting beside decimal wei figures in a refusal
   * message is exactly the misread rule 90 forbids.
   */
  readonly value: string;
  readonly predictedTokenAddress: string;
  readonly predictedPoolAddress: string;
  readonly salt: string;
  readonly metadataUri: string;
  readonly devBuyMinOut: string;
  readonly devBuyAmountIn: string;
  readonly deploymentFeeWei: string;
  readonly nativeDevBuyWei: string;
  readonly deadline: string;
  /** Informational; the pair that is PROVEN is the tuple's. See the interface. */
  readonly pairedAsset: PoolsPreparedPairedAsset;
  readonly tokenSymbol: string;
  /** The RESOLVED recipient - an `x` request comes back as the address it named. */
  readonly feeRecipient: PoolsResolvedFeeRecipient;
}

/** `/pools-fun/launches/config` - the gateway fee, which is DYNAMIC. */
export interface PoolsLaunchConfig {
  readonly deploymentFeeWei: string;
  readonly gatewayVersion: number;
}

/** `/pools-fun/launches/upload-image` - the multipart upload's answer. */
export interface PoolsImageUpload {
  readonly url: string;
}

/** `/pools-fun/launches/dev-buy-quote` - an indicative prebuy fill at initial FDV. */
export interface PoolsDevBuyQuote {
  readonly devBuyAmountIn: string;
  readonly devBuyAmountOut: string;
  readonly totalSupply: string;
}

// -- Request param types ---------------------------------------------

/**
 * `/discover` params. `platform` is REQUIRED on purpose: the provider's default
 * (no param) is a different launchpad entirely, so the trap is made structurally
 * impossible rather than documented.
 */
export interface PoolsDiscoverParams {
  platform: PoolsPlatform;
  sortBy?: string;
  order?: string;
  limit?: number;
  cursor?: string;
  query?: string;
  live?: boolean;
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  minVolUsd?: number;
  volTimeframe?: string;
  minTxCount24h?: number;
  maxAgeHours?: number;
  deployerAddress?: string;
  feeRecipientAddress?: string;
  /**
   * Keep only rows the launchpad marks `vexAttested`.
   *
   * ONLY `true` IS SENDABLE. The provider accepts the literal string `"true"`
   * and answers anything else - including `false` - with HTTP 400
   * `Invalid input: expected "true"` (measured 2026-09-04). So this is an
   * opt-in switch: `false`/absent means the filter is not applied, and there is
   * no way to ask for the complement.
   */
  vexAttested?: boolean;
  /**
   * Keep only rows that stream fees to holders. Same `"true"`-only contract as
   * {@link PoolsDiscoverParams.vexAttested}.
   */
  holderRewards?: boolean;
}

/** `/pools-fun/launch-assets` - one launchable tokenised stock. */
export interface PoolsLaunchAsset {
  readonly symbol: string;
  readonly name: string;
  readonly address: string;
}

/**
 * `/pools-fun/launch-assets` - the launchable stock universe.
 *
 * No pagination and no `limit`: the endpoint returns the WHOLE list in one body
 * (194 rows on 2026-09-04) and ignores a `chain` parameter, always answering for
 * Robinhood. `decimals` is not carried by any row.
 */
export interface PoolsLaunchAssets {
  readonly chain: string;
  readonly stocks: readonly PoolsLaunchAsset[];
}

/**
 * `GET /pools-fun/holder-rewards?token=` - the launchpad's view of one
 * fees-to-holders token's distributor.
 *
 * EVERY AMOUNT IS A RAW BASE-UNIT STRING and stays a string: these are uint256
 * values and `Number` would lose them (rule 90). The identity fields
 * (`token`, `distributor`) are strict; everything else is display-tolerant,
 * because this whole object is the provider's ECHO of state whose authority is
 * the distributor contract itself.
 *
 * `wallet` echoes the address the request asked about, or is `null` when none
 * was sent. The client lowercases it first: a mixed-case address with a WRONG
 * EIP-55 checksum makes this endpoint answer HTTP 502 rather than a named 400
 * (measured 2026-09-04, see `PoolsFun.md`).
 */
export interface PoolsHolderRewards {
  readonly token: string;
  readonly distributor: string;
  readonly pairedAsset: string | null;
  readonly pairedSymbol: string | null;
  readonly pairedDecimals: number | null;
  readonly wallet: string | null;
  /** `token` | `paired` | `both` as the provider spells it. An ECHO; the event is the authority. */
  readonly rewardMode: string | null;
  readonly paysCallerBounty: boolean | null;
  readonly conversion: string | null;
  readonly earned: string | null;
  readonly earnedPaired: string | null;
  readonly walletExcluded: boolean | null;
  readonly eligibleSupply: string | null;
  readonly rewardRate: string | null;
  readonly rewardRatePaired: string | null;
  readonly periodFinish: number | null;
  readonly periodFinishPaired: number | null;
  readonly remainingStream: string | null;
  readonly remainingStreamPaired: string | null;
  readonly surplus: string | null;
  readonly surplusPaired: string | null;
  readonly buybackBacklog: string | null;
  readonly lastBuybackAt: number | null;
  readonly pendingFees: { readonly token: string | null; readonly paired: string | null } | null;
  readonly hasWorkToDistribute: boolean | null;
}

/**
 * `POST /pools-fun/holder-rewards/prepare` - the launchpad's own calldata for a
 * holder-reward claim or a permissionless distribute.
 *
 * NOT AUTHORITY, and the type says so by carrying only what a cross-check needs.
 * Vex builds `to` and `data` itself from the verified distributor ABI and the
 * distributor the suite's deployer named; this response is compared against that
 * and a disagreement is a refusal, never an override. Measured 2026-09-04:
 * `action: "distribute"` answers 200 with `data` = `0xe4fc6b6d` and `to` = the
 * distributor, and `action: "claim"` answers HTTP 400 `{"error":"Nothing to
 * claim"}` for a wallet the distributor owes nothing - a provider DECLINE, which
 * is not a disagreement about calldata.
 *
 * The body also echoes the whole `GET /pools-fun/holder-rewards` row; those
 * fields are read from the GET (which is the one place that echo is projected)
 * rather than duplicated here.
 */
export interface PoolsHolderRewardsPrepare {
  /** The contract the provider would send to. Compared against our distributor. */
  readonly to: string;
  /** The calldata the provider would send. Compared byte for byte against ours. */
  readonly data: string;
  /** Wei, as the provider spells it (`"0x0"` measured). Compared against zero. */
  readonly value: string | null;
  /** The action the provider believes it prepared. */
  readonly action: string | null;
  readonly token: string | null;
  readonly distributor: string | null;
}

/** `/discover/{token}/ohlcv` params. */
export interface PoolsCandlesParams {
  tokenAddress: string;
  timeframe: string;
  aggregate?: number;
  limit?: number;
}
