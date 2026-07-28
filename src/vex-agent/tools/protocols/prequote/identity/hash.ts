/**
 * Deterministic match-hash over a swap/bridge trade identity (Stage 6c/7/8c/9).
 *
 * The hash is computed IDENTICALLY at record-time and gate-time so the digests
 * collide. This module owns the canonical identity shapes, the per-field
 * canonicalization (address case, amount normalization), and the fixed-order
 * hash material.
 *
 * VENUE-BOUND scheme (LOCKED Wave-2 correction #4): `provider`/venue IS part of
 * the identity — it is the LAST field of both the swap and the bridge hash
 * material. On EVM the provider does NOT derive from `family` (kyberswap and
 * uniswap are both eip155; khalani and relay both bridge), so binding it is what
 * stops a kyberswap quote from authorizing a uniswap execute (or a khalani quote
 * a relay execute) for the same tokens/amount.
 */

import { createHash } from "node:crypto";

import type { PrequoteFamily } from "@vex-agent/db/repos/swap-prequotes.js";

// ── Match-hash ────────────────────────────────────────────────────────────

/**
 * Swap trade identity (Stage 6c/7). `kind: "swap"` is the discriminant tag —
 * Stage 8c made `PrequoteMatchInput` a union so a swap identity and a bridge
 * identity with otherwise-similar values can never collide in the hash.
 *
 * The execute-only money/safety leg (`recipient`/`approveExact`/`slippageBps`)
 * is bound too (Stage 9 security fix). `recipient` (where the output lands) and
 * `approveExact` (allowance behavior) are EVM-execute-only — the swap QUOTE has
 * no such params — so the recorder DEFAULTS them to the executor's omitted-value
 * defaults (recipient → the resolved selected wallet, i.e. output-to-self;
 * approveExact → false). A quote then authorizes an execute ONLY when the
 * execute uses those same defaulted values; an execute that SETS a different
 * recipient/approveExact produces a different digest → the gate blocks. Solana
 * has neither concept (recipient=self, approveExact=false are constants there),
 * so they never affect Solana matching — uniform and inert. `slippageBps` IS in
 * both the quote and the execute params (both families), so binding it stops a
 * 50bps quote from authorizing a 10000bps execute.
 */
export interface SwapMatchInput {
  readonly kind: "swap";
  readonly sessionId: string;
  readonly family: PrequoteFamily;
  /**
   * VENUE binding (LOCKED Wave-2 correction #4). The quoting venue/provider
   * (e.g. "kyberswap" | "uniswap" | "jupiter") is bound into the hash so a
   * KyberSwap quote can NEVER authorize a Uniswap execute for the same
   * tokens/amount (and vice-versa). Unlike Solana, an EVM `provider` does NOT
   * derive from `family` (kyber and uniswap are both eip155), so it must be an
   * explicit identity dimension. The recorder pins it from the quote-tool
   * registration; the gate pins it from the execute-tool registration.
   */
  readonly provider: string;
  /** EVM numeric chainId; null/undefined for Solana (single chain in scope). */
  readonly chainId: number | null | undefined;
  readonly walletAddress: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  /** Human decimal amount the quote was computed for. */
  readonly amount: string;
  /**
   * Output recipient. Defaulted to the resolved selected wallet (output-to-self)
   * when the execute omits it — mirrors `executeKyberSwap`'s
   * `str(p,"recipient") || signer.address`. Canonicalized per family (EVM
   * lowercase / Solana case-preserve). Solana = the selected wallet (constant).
   */
  readonly recipient: string;
  /**
   * Token-allowance behavior (EVM). `true` iff the execute set `approveExact`;
   * the executor's default when omitted is `false`. Canonicalized to "1"/"0" in
   * the hash. Solana = false (constant — no allowance concept).
   */
  readonly approveExact: boolean;
  /**
   * Slippage tolerance in basis points, taken from the QUOTE params (recorder)
   * and the EXECUTE params (gate). A number canonicalizes to its integer string;
   * omitted/null → the stable sentinel "" so a quote-omitted and an
   * execute-omitted slippage collide, while a 50bps quote and a 10000bps execute
   * diverge → block.
   */
  readonly slippageBps: string;
  /**
   * Jupiter fee-bearing `/build` tail (W5 design §6 R4: "prequote identity
   * hash extended with: feeBps, feeMint, tip, CU strategy, dexes,
   * maxAccounts, wrap"). ALL FIVE are `undefined` (→ "" in the hash material)
   * for every non-Jupiter swap (kyberswap/uniswap/pendle) — their
   * quote↔execute pairs still collide unchanged, since both sides omit them
   * identically. Only `solana.swap.quote`/`solana.swap.execute` (provider
   * "jupiter") populate real values, via
   * `fee-swap.ts`'s `canonicalizeJupiterFeeTail` on BOTH the recorder and the
   * gate, so a fee/tip/DEX-filter/maxAccounts/wrap substitution between quote
   * and execute produces a different digest → BLOCK. `routeKnobs` bundles
   * dexes/excludeDexes/maxAccounts/wrap/forJitoBundle into one canonical
   * string (see `canonicalizeJupiterFeeTail`) rather than five separate
   * fields.
   */
  readonly feeBps?: string;
  readonly feeMint?: string;
  readonly tipLamports?: string;
  readonly cuStrategy?: string;
  readonly routeKnobs?: string;
}

/**
 * Cross-chain bridge trade identity (Stage 8c). Computed IDENTICALLY at bridge
 * QUOTE record-time (`khalani.quote.get`) and bridge EXECUTE gate-time
 * (`khalani.bridge`) — both go through the SAME shared builder
 * (`buildBridgeIdentity`) so the digests collide. Chain IDs are normalized to
 * numeric Khalani chain IDs; addresses/tokens are canonicalized per the SOURCE
 * (from*) or DEST (to*) family; `recipient`/`tradeType` carry the bridge
 * handler's defaults.
 *
 * The money/fee leg (`refundTo`/`referrer`/`referrerFeeBps`/`filler`) is bound
 * too (8c security fix): each flows into the Khalani quote request in BOTH the
 * quote (`prepareQuoteRequest`) and the execute (`khalani.bridge`), so leaving
 * any of them out of the identity would let a quote authorize an execute that
 * changes where funds refund / who collects the fee. They carry the SAME
 * defaults `prepareQuoteRequest` applies (see `buildBridgeIdentity`); an omitted
 * field canonicalizes to a STABLE empty token so quote↔execute still collide
 * when both omit it.
 */
export interface BridgeMatchInput {
  readonly kind: "bridge";
  readonly sessionId: string;
  /**
   * VENUE binding (LOCKED Wave-2 correction #4). The bridge provider (e.g.
   * "khalani" | "relay") is bound into the hash so a Khalani quote can never
   * authorize a Relay execute for the same route (and vice-versa). Relay gets
   * its OWN bridge identity path — it does NOT reuse Khalani's.
   */
  readonly provider: string;
  /** Family of the SOURCE chain (where the deposit signs). Canonicalizes from*. */
  readonly sourceFamily: PrequoteFamily;
  /** Family of the DEST chain (where funds land). Canonicalizes the dest leg. */
  readonly destFamily: PrequoteFamily;
  readonly fromChainId: number;
  readonly toChainId: number;
  /** Selected source-family wallet address (the signer). */
  readonly sourceWallet: string;
  /** Destination recipient (defaulted to the dest-family selected wallet). */
  readonly recipient: string;
  readonly fromToken: string;
  readonly toToken: string;
  /** Amount in smallest units (wei/lamports) — bridge amounts are integers. */
  readonly amount: string;
  readonly tradeType: BridgeTradeType;
  /**
   * Refund address — a SOURCE-chain address (canonicalized under the source
   * family). Defaults to `sourceWallet` (mirrors `prepareQuoteRequest`, where an
   * omitted `refundTo` falls back to the resolved `fromAddress`).
   */
  readonly refundTo: string;
  /** EVM referrer address for fee sharing; "" when omitted. */
  readonly referrer: string;
  /** Referrer fee in basis points (canonical integer string 0-9999); "" when omitted. */
  readonly referrerFeeBps: string;
  /** Opaque Khalani filler-provider name (case-preserved, NOT an address); "" when omitted. */
  readonly filler: string;
  /**
   * Bridge slippage tolerance (canonical integer bps string); "" when the
   * provider has no slippage surface or the caller omitted it.
   *
   * Bound for the SAME reason every other identity binds it, and it was the one
   * place the doctrine had not been applied: `relay.bridge` forwards
   * `slippageBps` to Relay as `slippageTolerance`, so without this a 50 bps
   * `relay.quote.get` and a 5000 bps `relay.bridge` produced the SAME digest and
   * the gate allowed the pair. Khalani has no slippage param and passes the
   * stable "" on both sides, so its quote↔execute pairs still collide.
   */
  readonly slippageBps: string;
}

/**
 * Pendle PT redeem trade identity (Wave 5). A matured-PT redemption is NEITHER a
 * swap nor a bridge — it has no slippage/route surface and its risk leg is the
 * PT+YT pair, not a token-in/token-out pair. Computed IDENTICALLY at the Pendle
 * QUOTE record-time (`pendle.pt.quote`, when Convert returns action `redeem-py`)
 * and the Pendle redeem EXECUTE gate-time (`pendle.pt.redeem`) — both resolve the
 * YT from the PT through the SAME market lookup, so the digests collide. Never
 * reuses the Khalani/Relay bridge identity (Codex G2#3).
 *
 * Material (FIXED order): ["redeem", sessionId, provider, chainId, wallet,
 * ptAddress, ytAddress, amount, receiver, slippageBps]. Addresses are EVM
 * (lowercase); `amount` is the human decimal via `canonAmount`.
 *
 * `slippageBps` is bound too (Codex blocker fix): the redeem EXECUTE accepts a
 * `slippageBps` param, so without binding it a 50 bps quote could authorize a
 * 5000 bps execute. The shared builder normalizes the default identically on both
 * sides, so a quote-without-slippage still matches an execute-without-slippage,
 * while divergent slippage → different digest → gate BLOCK (swap-identity
 * doctrine, this file's `SwapMatchInput.slippageBps`).
 */
export interface RedeemMatchInput {
  readonly kind: "redeem";
  readonly sessionId: string;
  /** VENUE binding — "pendle". A redeem quote can never authorize another venue. */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** PT being redeemed. */
  readonly ptAddress: string;
  /** YT resolved from the PT's market (record + gate resolve it identically). */
  readonly ytAddress: string;
  /** Human decimal amount of PT to redeem. */
  readonly amount: string;
  /** Where the redeemed asset lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle PY mint trade identity (P4). A mint (token → PT+YT) is its OWN kind —
 * not a swap, bridge, or matured redeem: it acquires BOTH an equal PT and YT in
 * one transaction from a single payment token. Computed IDENTICALLY at the
 * `pendle.py.quote` (direction "mint") record-time and the `pendle.py.mint`
 * EXECUTE gate-time — both resolve the market (and its YT) from the PT anchor
 * through the SAME market lookup, so the digests collide.
 *
 * Material (FIXED order): ["mint", sessionId, provider, chainId, wallet, receiver,
 * tokenIn, amount, ptAddress, ytAddress, market, slippageBps]. Addresses are EVM
 * (lowercase); `amount` is the human decimal via `canonAmount`. The FULL execute-
 * variance surface is bound (Codex doctrine): a changed `tokenIn`, `slippageBps`,
 * or `chainId` produces a different digest → the gate BLOCKS.
 */
export interface MintMatchInput {
  readonly kind: "mint";
  readonly sessionId: string;
  /** VENUE binding — "pendle". A mint quote can never authorize another venue. */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the minted PT+YT land (defaults to the selected wallet). */
  readonly receiver: string;
  /** Payment token spent to mint. */
  readonly tokenIn: string;
  /** Human decimal amount of tokenIn. */
  readonly amount: string;
  /** PT anchor (the market is resolved from it). */
  readonly ptAddress: string;
  /** YT resolved from the PT's market (record + gate resolve it identically). */
  readonly ytAddress: string;
  /** The PT's canonical market/LP address (bound so the market is unmixable). */
  readonly market: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle PRE-EXPIRY PY redeem trade identity (P4). Burns an EQUAL PT+YT pair back
 * to a token BEFORE expiry — distinct from the matured-PT `redeem` (PT only). It
 * extends the redeem material with an explicit `outputToken` (the matured redeem
 * always outputs the underlying; a pre-expiry redeem can output any token, so it
 * must be bound). Computed IDENTICALLY at `pendle.py.quote` (direction "redeem")
 * record-time and the `pendle.py.redeem` EXECUTE gate-time.
 *
 * Material (FIXED order): ["redeem_py", sessionId, provider, chainId, wallet,
 * receiver, ptAddress, ytAddress, amount, outputToken, slippageBps].
 */
export interface RedeemPyMatchInput {
  readonly kind: "redeem_py";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the redeemed token lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** PT being burned (half of the pair). */
  readonly ptAddress: string;
  /** YT being burned (resolved from the PT's market — the other half). */
  readonly ytAddress: string;
  /** Human decimal amount of the PT+YT pair to burn (equal legs). */
  readonly amount: string;
  /** Output token (default = the market's underlyingAsset; can be overridden). */
  readonly outputToken: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle LP single-token ADD trade identity (P5). Adding single-token liquidity
 * (token → LP) is its OWN kind — not a swap, mint, or redeem: it deposits ONE
 * payment token into a Pendle market and receives the LP token. Computed
 * IDENTICALLY at the `pendle.lp.quote` (direction "add") record-time and the
 * `pendle.lp.add` EXECUTE gate-time — both bind the MARKET (the LP anchor)
 * directly (never resolved from a PT), so the digests collide.
 *
 * Direction is structurally unmixable from a remove: `lp_add` and `lp_remove` are
 * DISTINCT kinds, so an add quote can never authorize a remove execute (and
 * vice-versa) even for the same market/amount. Material (FIXED order): ["lp_add",
 * sessionId, provider, chainId, wallet, receiver, market, tokenIn, amount,
 * slippageBps]. Addresses EVM (lowercased); `amount` via `canonAmount`.
 */
export interface LpAddMatchInput {
  readonly kind: "lp_add";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the minted LP lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** The Pendle market (== the LP token) liquidity is added to. */
  readonly market: string;
  /** Payment token deposited. */
  readonly tokenIn: string;
  /** Human decimal amount of tokenIn. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle LP single-token REMOVE trade identity (P5). Removing single-token
 * liquidity (LP → token) is its OWN kind. Computed IDENTICALLY at the
 * `pendle.lp.quote` (direction "remove") record-time and the `pendle.lp.remove`
 * EXECUTE gate-time — both bind the MARKET directly. It carries `tokenOut` (the
 * output token; a remove can target any token, default = the market's underlying),
 * bound so a divergent output blocks. Material (FIXED order): ["lp_remove",
 * sessionId, provider, chainId, wallet, receiver, market, tokenOut, amount,
 * slippageBps].
 */
export interface LpRemoveMatchInput {
  readonly kind: "lp_remove";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the withdrawn token lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** The Pendle market (== the LP token) liquidity is removed from. */
  readonly market: string;
  /** Output token (default = the market's underlyingAsset; can be overridden). */
  readonly tokenOut: string;
  /** Human decimal amount of the LP token to remove. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle SY WRAP identity (R5d). `token → SY`. Its own kind rather than the
 * `swap` shape it shipped under: the wrap and the unwrap are one toolId pair
 * whose only structural separation used to be which leg held the SY, so a shared
 * kind left the DB gate reads unable to tell the two directions apart, and left
 * both indistinguishable from an ordinary swap prequote at the `kind` predicate.
 *
 * The DIRECTION is bound by the kind tag itself — the FIRST material element —
 * so a mint digest can never equal a redeem digest even when `sy`, `token`,
 * `amount` and slippage are identical. `sy`/`token` are therefore named by ROLE,
 * not by in/out leg: swapping the legs is no longer what distinguishes them.
 *
 * Material (FIXED order): ["sy_mint", sessionId, provider, chainId, wallet,
 * receiver, sy, token, amount, slippageBps].
 */
export interface SyMintMatchInput {
  readonly kind: "sy_mint";
  readonly sessionId: string;
  /** VENUE binding — "pendle-sy", never plain "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the minted SY lands (the wallet — no Pendle manifest takes a recipient). */
  readonly receiver: string;
  /** The SY being wrapped INTO. */
  readonly sy: string;
  /** The token being spent. */
  readonly token: string;
  /** Human decimal amount of the input leg. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle SY UNWRAP identity (R5d). `SY → token`. Structurally identical to
 * {@link SyMintMatchInput} except for the kind tag, which is the point: the tag
 * is what makes a wrap dry run unable to authorize an unwrap execute.
 *
 * Material (FIXED order): ["sy_redeem", sessionId, provider, chainId, wallet,
 * receiver, sy, token, amount, slippageBps].
 */
export interface SyRedeemMatchInput {
  readonly kind: "sy_redeem";
  readonly sessionId: string;
  /** VENUE binding — "pendle-sy", never plain "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the unwrapped token lands. */
  readonly receiver: string;
  /** The SY being unwrapped FROM. */
  readonly sy: string;
  /** The token received. */
  readonly token: string;
  /** Human decimal amount of the input leg. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle DUAL LP remove identity (R5d). `LP → (token, PT)` — two output legs,
 * where `lp_remove` has one. Its own kind, never `lp_remove`: the two actions
 * take the same market and the same LP amount, so a shared kind would let a
 * single-token remove quote authorize a dual remove execute (and vice-versa),
 * substituting an entirely different output shape and a different price floor.
 *
 * Material (FIXED order): ["lp_remove_dual", sessionId, provider, chainId,
 * wallet, receiver, market, tokenOut, amount, slippageBps]. The PT output leg is
 * NOT a free parameter — it is the market's own PT — so binding `market` binds
 * it; `tokenOut` is the leg the caller can vary.
 */
export interface LpRemoveDualMatchInput {
  readonly kind: "lp_remove_dual";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where both output legs land (defaults to the selected wallet). */
  readonly receiver: string;
  /** The Pendle market (== the LP token) liquidity is removed from. */
  readonly market: string;
  /** The TOKEN output leg (the PT leg is the market's own PT, bound via `market`). */
  readonly tokenOut: string;
  /** Human decimal amount of the LP token to remove. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle KEEP-YT LP add identity (R5d). `token → (LP, YT)` — two output legs,
 * where `lp_add` has one. Its own kind, never `lp_add`: same market, same token,
 * same amount, so a shared kind would let a plain add quote authorize a keep-YT
 * execute, which returns a materially different position.
 *
 * Material (FIXED order): ["lp_add_keep_yt", sessionId, provider, chainId,
 * wallet, receiver, market, tokenIn, amount, slippageBps]. The YT output leg is
 * the market's own YT, bound via `market`.
 */
export interface LpAddKeepYtMatchInput {
  readonly kind: "lp_add_keep_yt";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the LP + YT land (defaults to the selected wallet). */
  readonly receiver: string;
  /** The Pendle market (== the LP token) liquidity is added to. */
  readonly market: string;
  /** Payment token deposited. */
  readonly tokenIn: string;
  /** Human decimal amount of tokenIn. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle PT ROLLOVER identity (R5d). `PT(market A) → PT(market B)` — a maturity
 * roll. Its own kind: both PTs are free parameters, and binding only one of them
 * would let a quote for a roll into one maturity authorize an execute rolling
 * into another.
 *
 * Material (FIXED order): ["pt_rollover", sessionId, provider, chainId, wallet,
 * receiver, fromPt, toPt, amount, slippageBps].
 */
export interface PtRolloverMatchInput {
  readonly kind: "pt_rollover";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  /** Both legs are on ONE chain — a rollover is not a bridge. */
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the destination PT lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** The PT being rolled OUT of (source maturity). */
  readonly fromPt: string;
  /** The PT being rolled INTO (destination maturity). */
  readonly toPt: string;
  /** Human decimal amount of the source PT. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle LP TRANSFER identity (R5d). `LP(market A) → LP(market B)` — liquidity
 * moved between markets. Its own kind for the same reason as the rollover: both
 * markets are free parameters and both must be bound.
 *
 * Material (FIXED order): ["lp_transfer", sessionId, provider, chainId, wallet,
 * receiver, fromMarket, toMarket, amount, slippageBps].
 *
 * NO `keepYt` FIELD. The R5d card allowed one "if shipped"; it is not — no
 * `keepYt` param exists on any manifest, handler or client body in the tree
 * (`transfer-liquidity` was live-probed as `[LP(mktA)] → [LP(mktB)]`, a single
 * output leg). An identity field for a parameter the execute cannot carry would
 * bind nothing and read as though it did. If a keep-YT transfer ever ships, it
 * belongs here as a bound field BEFORE the handler accepts the param.
 */
export interface LpTransferMatchInput {
  readonly kind: "lp_transfer";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the destination LP lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** The market liquidity is withdrawn from. */
  readonly fromMarket: string;
  /** The market liquidity is deposited into. */
  readonly toMarket: string;
  /** Human decimal amount of the source LP token. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle LP→PT identity (R5d). `LP → PT` within one market. Its own kind: the
 * output is a PT, not a token, so it can never share `lp_remove`'s material
 * without letting a token-out quote authorize a PT-out execute.
 *
 * Material (FIXED order): ["lp_to_pt", sessionId, provider, chainId, wallet,
 * receiver, market, ptOut, amount, slippageBps]. `ptOut` is bound EXPLICITLY
 * even though it is the market's own PT: the two are resolved independently on
 * the record and the gate side, and binding both makes a divergent resolution a
 * block instead of a silent agreement.
 */
export interface LpToPtMatchInput {
  readonly kind: "lp_to_pt";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the PT lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** The Pendle market (== the LP token) being converted. */
  readonly market: string;
  /** The PT received (the market's PT; bound explicitly — see the doc). */
  readonly ptOut: string;
  /** Human decimal amount of the LP token to convert. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Discriminated on `kind` — swap / bridge / redeem / mint / redeem_py / lp_add /
 * lp_remove identities never collide, and neither do the seven R5d kinds
 * (sy_mint / sy_redeem / lp_remove_dual / lp_add_keep_yt / pt_rollover /
 * lp_transfer / lp_to_pt), each of which carries its tag as the FIRST material
 * element.
 */
export type PrequoteMatchInput =
  | SwapMatchInput
  | BridgeMatchInput
  | RedeemMatchInput
  | MintMatchInput
  | RedeemPyMatchInput
  | LpAddMatchInput
  | LpRemoveMatchInput
  | SyMintMatchInput
  | SyRedeemMatchInput
  | LpRemoveDualMatchInput
  | LpAddKeepYtMatchInput
  | PtRolloverMatchInput
  | LpTransferMatchInput
  | LpToPtMatchInput;

/**
 * Canonical bridge trade direction. `EXACT_INPUT`/`EXACT_OUTPUT` mirror
 * `parseTradeType` in khalani/request; `EXPECTED_OUTPUT` is a DISTINCT Relay
 * value (Wave-2 W2, R10) — Relay's recommended plain-bridge mode. Bound verbatim
 * into `bridgeHashMaterial`, so an `EXPECTED_OUTPUT` quote↔execute produces a
 * digest distinct from `EXACT_INPUT` (no longer collapsed). Widening this union
 * is additive: Khalani's `parseBridgeTradeType` still returns only the first two.
 */
export type BridgeTradeType = "EXACT_INPUT" | "EXACT_OUTPUT" | "EXPECTED_OUTPUT";

/**
 * Canonicalize an address/mint for the match-hash. EVM addresses are
 * case-insensitive → lowercase; Solana base58 mints/addresses are
 * case-SENSITIVE → preserved as-is (after trim).
 */
function canonAddress(family: PrequoteFamily, value: string): string {
  const trimmed = value.trim();
  return family === "eip155" ? trimmed.toLowerCase() : trimmed;
}

/**
 * Canonicalize a human decimal amount so `"1.0"`, `"1"`, `"1.00"`, `"01"` and
 * `" 1 "` all hash identically. Strips sign-less leading/trailing zeros around
 * a single decimal point. Non-numeric input falls back to the trimmed string so
 * the hash is still deterministic (the recorder only ever passes amounts the
 * quote already accepted).
 */
function canonAmount(raw: string): string {
  const trimmed = raw.trim();
  // Plain decimal (optional sign, digits, optional fraction). Anything exotic
  // (scientific notation, units) falls through to the trimmed literal.
  if (!/^[+-]?\d*\.?\d+$/.test(trimmed) && !/^[+-]?\d+\.?\d*$/.test(trimmed)) {
    return trimmed;
  }
  const negative = trimmed.startsWith("-");
  const unsigned = trimmed.replace(/^[+-]/, "");
  const [intPartRaw = "", fracPartRaw = ""] = unsigned.split(".");
  const intPart = intPartRaw.replace(/^0+/, "") || "0";
  const fracPart = fracPartRaw.replace(/0+$/, "");
  const body = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  // Zero is always positive-canonical so "-0" and "0" collide.
  return negative && body !== "0" ? `-${body}` : body;
}

/**
 * Deterministic sha256-hex match-hash over the trade identity. Identical at
 * record-time and gate-time. The quoting `provider`/venue IS bound (LOCKED
 * Wave-2 #4) as the LAST material field. Exported so the gate reuses the EXACT
 * function.
 *
 * Stage 8c: the material is prefixed with the `kind` discriminant tag and then
 * the kind-specific fields in a FIXED order, so a swap and a bridge with
 * otherwise-similar values produce different digests (Codex requirement #4).
 * Wave-2c appends the venue `provider` last on both kinds.
 *   - swap   : ["swap", sessionId, family, chainId|"", wallet, tokenIn, tokenOut,
 *               amount, recipient, approveExact, slippageBps, provider]
 *   - bridge : ["bridge", sessionId, sourceFamily, destFamily, fromChainId,
 *               toChainId, sourceWallet, recipient, fromToken, toToken, amount,
 *               tradeType, refundTo, referrer, referrerFeeBps, filler, provider,
 *               slippageBps]
 * EVM addresses/tokens lowercase; Solana mints case-preserved; amount via
 * `canonAmount`.
 *
 * Stage 9 swap tail (FIXED order, appended after `amount`): `recipient`
 * (family-canonical address — where the output lands), `approveExact` (stable
 * "1"/"0" allowance token), and `slippageBps` (integer string, or "" when
 * omitted). The recorder defaults `recipient`/`approveExact` to the executor's
 * omitted-value defaults (self / false) since the quote can't carry them, so a
 * quote↔execute that both omit them collide; an execute that redirects the
 * output or flips approveExact, or quotes 50bps then executes 10000bps,
 * diverges → block.
 *
 * Bridge: the source family canonicalizes `sourceWallet`/`fromToken`/`refundTo`;
 * the dest family canonicalizes `recipient`/`toToken` (derived from each chain
 * id). The money/fee tail (FIXED order, appended after `tradeType`): `refundTo`
 * (source-family address), `referrer` (EVM → lowercase), the already-canonical
 * `referrerFeeBps` integer string, and `filler` (opaque provider name,
 * case-preserved). Omitted money/fee fields are "" so a quote↔execute that both
 * omit them still collide.
 */
export function computePrequoteMatchHash(input: PrequoteMatchInput): string {
  let material: string;
  switch (input.kind) {
    case "swap":
      material = swapHashMaterial(input);
      break;
    case "bridge":
      material = bridgeHashMaterial(input);
      break;
    case "redeem":
      material = redeemHashMaterial(input);
      break;
    case "mint":
      material = mintHashMaterial(input);
      break;
    case "redeem_py":
      material = redeemPyHashMaterial(input);
      break;
    case "lp_add":
      material = lpAddHashMaterial(input);
      break;
    case "lp_remove":
      material = lpRemoveHashMaterial(input);
      break;
    case "sy_mint":
    case "sy_redeem":
      material = syHashMaterial(input);
      break;
    case "lp_remove_dual":
      material = lpRemoveDualHashMaterial(input);
      break;
    case "lp_add_keep_yt":
      material = lpAddKeepYtHashMaterial(input);
      break;
    case "pt_rollover":
      material = ptRolloverHashMaterial(input);
      break;
    case "lp_transfer":
      material = lpTransferHashMaterial(input);
      break;
    case "lp_to_pt":
      material = lpToPtHashMaterial(input);
      break;
  }
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Pendle SY wrap/unwrap material (R5d, FIXED order), shared by both directions.
 * ONE function because the two identities bind the same fields; the DIRECTION is
 * carried by `input.kind` in the FIRST slot, so a `sy_mint` digest can never
 * equal a `sy_redeem` digest for identical sy/token/amount/slippage. That single
 * element is the whole cross-direction guarantee, which is why `sy`/`token` are
 * bound by role and never re-ordered per direction. Addresses EVM (lowercased);
 * `amount` via `canonAmount`.
 */
function syHashMaterial(input: SyMintMatchInput | SyRedeemMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.sy),
    canonAddress("eip155", input.token),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle DUAL LP remove material (R5d, FIXED order). Mirrors `lp_remove`'s field
 * order exactly, so the ONLY difference between the two digests is the kind tag —
 * which is what makes a single-token remove quote unable to authorize a dual
 * remove execute. Addresses EVM (lowercased); `amount` via `canonAmount`.
 */
function lpRemoveDualHashMaterial(input: LpRemoveDualMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.market),
    canonAddress("eip155", input.tokenOut),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle KEEP-YT LP add material (R5d, FIXED order). Mirrors `lp_add`'s field
 * order exactly; the kind tag is the only divergence, so a plain add quote can
 * never authorize a keep-YT execute for the same market/token/amount.
 */
function lpAddKeepYtHashMaterial(input: LpAddKeepYtMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.market),
    canonAddress("eip155", input.tokenIn),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle PT rollover material (R5d, FIXED order). BOTH PTs are bound, in a fixed
 * source→destination order, so a roll into one maturity can never authorize a
 * roll into another (and a reversed roll hashes differently).
 */
function ptRolloverHashMaterial(input: PtRolloverMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.fromPt),
    canonAddress("eip155", input.toPt),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle LP transfer material (R5d, FIXED order). BOTH markets are bound, in a
 * fixed source→destination order, so a transfer into one market can never
 * authorize a transfer into another, and the reverse direction hashes
 * differently.
 */
function lpTransferHashMaterial(input: LpTransferMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.fromMarket),
    canonAddress("eip155", input.toMarket),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle LP→PT material (R5d, FIXED order). Binds the market AND the PT output
 * leg; see {@link LpToPtMatchInput} for why both.
 */
function lpToPtHashMaterial(input: LpToPtMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.market),
    canonAddress("eip155", input.ptOut),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle LP ADD material (P5, FIXED order). Venue `provider` is bound so an add
 * quote can never authorize a non-Pendle execute. The full execute-variance
 * surface is bound: market / tokenIn / chainId / slippage / receiver all feed the
 * digest, so any divergence blocks. The distinct `lp_add` kind tag makes the
 * direction structurally unmixable from a remove. Addresses EVM (lowercased);
 * `amount` via `canonAmount`.
 */
function lpAddHashMaterial(input: LpAddMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.market),
    canonAddress("eip155", input.tokenIn),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle LP REMOVE material (P5, FIXED order). Mirrors the add material but binds
 * `tokenOut` (a remove can target any token) instead of `tokenIn`, and carries the
 * distinct `lp_remove` kind tag so a remove quote can never authorize an add (or
 * vice-versa). Addresses EVM (lowercased); `amount` via `canonAmount`.
 */
function lpRemoveHashMaterial(input: LpRemoveMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.market),
    canonAddress("eip155", input.tokenOut),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle PY mint material (P4, FIXED order). Venue `provider` is bound so a mint
 * quote can never authorize a non-Pendle execute. The full execute-variance
 * surface is bound: tokenIn / chainId / slippage / market / YT / receiver all
 * feed the digest, so any divergence blocks. Addresses are EVM (lowercased);
 * `amount` via `canonAmount`.
 */
function mintHashMaterial(input: MintMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.tokenIn),
    canonAmount(input.amount),
    canonAddress("eip155", input.ptAddress),
    canonAddress("eip155", input.ytAddress),
    canonAddress("eip155", input.market),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle PRE-EXPIRY PY redeem material (P4, FIXED order). Extends the redeem
 * material with `outputToken` (a pre-expiry redeem can target any token) + venue
 * binding. Addresses EVM (lowercased); `amount` via `canonAmount`.
 */
function redeemPyHashMaterial(input: RedeemPyMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.ptAddress),
    canonAddress("eip155", input.ytAddress),
    canonAmount(input.amount),
    canonAddress("eip155", input.outputToken),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle redeem material (Wave 5, FIXED order). Venue `provider` is bound so a
 * redeem quote can never authorize a non-Pendle execute. PT/YT/receiver/wallet
 * are EVM addresses (lowercased); `amount` via `canonAmount`.
 */
function redeemHashMaterial(input: RedeemMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.ptAddress),
    canonAddress("eip155", input.ytAddress),
    canonAmount(input.amount),
    canonAddress("eip155", input.receiver),
    // Slippage tail (Codex blocker): integer bps string; the builder normalizes
    // the default identically on both sides so quote↔execute collide when both
    // omit it, and a divergent slippage blocks.
    input.slippageBps,
  ].join(" ");
}

function swapHashMaterial(input: SwapMatchInput): string {
  const chainIdOrEmpty =
    input.family === "eip155" && input.chainId != null ? String(input.chainId) : "";
  return [
    input.kind,
    input.sessionId,
    input.family,
    chainIdOrEmpty,
    canonAddress(input.family, input.walletAddress),
    canonAddress(input.family, input.tokenIn),
    canonAddress(input.family, input.tokenOut),
    canonAmount(input.amount),
    // Stage 9 tail (FIXED order): recipient (family-canonical address),
    // approveExact (stable "1"/"0"), slippageBps (integer string or "").
    canonAddress(input.family, input.recipient),
    input.approveExact ? "1" : "0",
    input.slippageBps,
    // Wave-2c venue binding (LOCKED #4): the quoting provider/venue, so a
    // kyber quote and a uniswap quote for the same identity hash differently.
    input.provider.trim().toLowerCase(),
    // W5 (design §6 R4) Jupiter fee-bearing tail — "" for every non-Jupiter
    // swap (both sides omit it identically, so their collision is unaffected).
    input.feeBps ?? "",
    input.feeMint ?? "",
    input.tipLamports ?? "",
    input.cuStrategy ?? "",
    input.routeKnobs ?? "",
  ].join(" ");
}

function bridgeHashMaterial(input: BridgeMatchInput): string {
  // Source-side fields canonicalize under the SOURCE family; destination-side
  // fields under the DEST family (a Solana mint on the dest leg must keep its
  // case even when the source leg is EVM, and vice-versa). The shared builder
  // passes RAW values + both leg families; the hash owns canonicalization (same
  // ownership split as the swap path).
  return [
    input.kind,
    input.sessionId,
    input.sourceFamily,
    input.destFamily,
    String(input.fromChainId),
    String(input.toChainId),
    canonAddress(input.sourceFamily, input.sourceWallet),
    canonAddress(input.destFamily, input.recipient),
    canonAddress(input.sourceFamily, input.fromToken),
    canonAddress(input.destFamily, input.toToken),
    canonAmount(input.amount),
    input.tradeType,
    // Money/fee tail (8c) — FIXED order: refundTo, referrer, referrerFeeBps,
    // filler. `refundTo` is a SOURCE-chain address (source-family canonical);
    // `referrer` is an EVM address (lowercase); `referrerFeeBps` is already the
    // canonical integer string from the builder; `filler` is an OPAQUE provider
    // name (case-preserved, trim-only — NOT an address, per Khalani docs). Each
    // is "" when omitted/defaulted so an all-omitting quote↔execute collide.
    canonAddress(input.sourceFamily, input.refundTo),
    input.referrer === "" ? "" : canonAddress("eip155", input.referrer),
    input.referrerFeeBps,
    input.filler.trim(),
    // Wave-2c venue binding (LOCKED #4): the bridge provider/venue, so a khalani
    // quote and a relay quote for the same route hash differently.
    input.provider.trim().toLowerCase(),
    // Slippage tail: appended LAST so the field order of every pre-existing
    // material element is untouched. "" for a provider without a slippage
    // surface (khalani) and for an omitted relay slippage, so those
    // quote↔execute pairs still collide; a divergent relay slippage blocks.
    input.slippageBps,
  ].join(" ");
}
