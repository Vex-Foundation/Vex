/**
 * THE ONE OWNER OF EVERY BUNDLED EVM RPC ENDPOINT.
 *
 * Before this module the repository had six independent tables that each pinned
 * ONE url per chain per venue (`kyberswap/evm/config.ts` DEFAULT_RPC,
 * `morpho/constants.ts` MORPHO_DEFAULT_RPC, `uniswap/deployments.ts`,
 * `pendle/chains.ts`, `virtuals` curve and creator-fee deployments, `evm-chains/registry.ts`),
 * and only three of eleven consumer families could see the user's own override.
 * A stale endpoint therefore had to be fixed in five places and was fixed in
 * one, and a user who configured their own node got it on three code paths.
 *
 * THE UNIT IS A CHAIN, NOT A VENUE. A chain is a chain id plus an ORDERED list
 * of endpoints, each carrying its own method scope, timeout and retry budget.
 * That unit is forced by measurement, not by taste: on Base 8453 NO single
 * keyless endpoint serves the method set Vex issues. `base-mainnet.public
 * .blastapi.io` sustains bursts and serves receipts and caps `eth_getLogs` at
 * ten blocks; `mainnet.base.org` is the only endpoint that answers the ten
 * thousand block window the candles module is built around and sheds load after
 * about five requests per second; `base-rpc.publicnode.com` sustains bursts and
 * refuses archive-class reads. "One url per chain per venue" cannot express
 * that, whichever url it picks. This is the same unit MetaMask's
 * `NetworkConfiguration.rpcEndpoints` + `defaultRpcEndpointIndex` arrived at
 * (`agents-colab/metamask-core/packages/network-controller/src/
 * NetworkController.ts:214-250`), and the user's own endpoint is an entry in
 * the SAME list rather than a second mechanism (`:117-119,160-186`).
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. This module is data plus two pure
 * functions: the table, the resolver that puts the user's endpoints first, and
 * the failure classifier. How a transport is built from the list, the
 * `eth_chainId` echo check and the pinned signing transport live in
 * `./rpc-transport.ts`, which is the only module allowed to reach a network
 * from here.
 *
 * EVERY URL IN THE TABLE IS KEYLESS. No entry carries an api key, an account,
 * a token or a path secret, so the table is shippable and a host may be logged.
 * The provenance of each entry is the live probe archived under
 * `agents-colab/agents_dm/rpc-endpoints-2026-09-05/` (git-ignored); the date and
 * the measured refusal are named per entry below.
 */

import { getUserRpcOverridesForChain } from "../../config/chain-rpc-overrides.js";

// ── Types ───────────────────────────────────────────────────────────

/**
 * Which methods an endpoint may serve. Passed through verbatim to viem's
 * `http(url, { methods })`, which enforces it in `buildRequest` BEFORE any
 * request leaves the process (measured against the installed viem 2.54.3: an
 * excluded method costs zero requests on that endpoint) and which viem's
 * `fallback` consults to decide whether a later endpoint can serve a method the
 * current one just refused (`node_modules/viem/_cjs/clients/transports/
 * fallback.js:52-63`).
 */
export type RpcMethodScope =
  | { readonly include: readonly string[] }
  | { readonly exclude: readonly string[] };

/** Where an endpoint came from. Order in the resolved list follows this order. */
export type RpcEndpointTier = "user" | "bundled" | "provider";

export interface RpcEndpoint {
  readonly url: string;
  readonly tier: RpcEndpointTier;
  /** Absent means "every method". */
  readonly methods?: RpcMethodScope;
  readonly timeoutMs: number;
  /**
   * Attempts THIS endpoint makes before the list advances, minus one.
   *
   * MEASURED, not assumed (`agents-colab/agents_dm/rpc-endpoints-2026-09-05/
   * builder/viem-fallback-measurement.txt`, viem 2.54.3): a `retryCount` passed
   * in the `http()` CONFIG survives inside a `fallback`, because `http.js:24`
   * resolves `config.retryCount ?? retryCount_` and the fallback only injects
   * the positional `retryCount: 0` (`fallback.js:25`). Three attempts were
   * counted on the first endpoint with `retryCount: 2`, one with the field
   * omitted. The audit's pin-note claimed the opposite; the endpoint is the
   * specification and this is the endpoint's answer.
   *
   * THE DEFAULT IS THEREFORE 0 WHEREVER A SECOND ENDPOINT EXISTS: retrying a
   * refusing node three times before asking a node that can answer spends the
   * caller's deadline on the wrong host. A chain with exactly one endpoint
   * carries a real retry budget instead, because it has nowhere to advance to.
   */
  readonly retryCount: number;
  /**
   * True only when this endpoint may carry `eth_sendRawTransaction` and the
   * reads a signature is bound to (the nonce, the fee estimate, the final
   * revalidation).
   *
   * THE BAR IS EVIDENCE, NOT CAPABILITY. `eth_sendRawTransaction` costs gas and
   * was never probed on any endpoint, so no amount of clean `eth_call` and
   * `eth_getTransactionReceipt` measurement proves a node will accept and
   * propagate a signed transaction. The flag is therefore set only for a
   * chain's OFFICIAL endpoint or for one this repository has already broadcast
   * through. Every gateway, aggregator and third-party mirror on these lists is
   * a READ entry: fast, measured, and never the node a signature reaches.
   *
   * A USER'S OWN ENDPOINT IS ALWAYS BROADCAST-SAFE. Rule 90's local-first
   * posture: the owner of the install pointing Vex at their own node is the
   * owner's decision, not ours to refuse.
   */
  readonly broadcastSafe: boolean;
  /**
   * Minimum milliseconds between requests THIS PROCESS sends to THIS endpoint.
   *
   * Per endpoint, not per chain, because the endpoints on one chain shed load
   * at wildly different rates: on Base the Tenderly gateway took twelve of
   * twelve at full speed while both `*.base.org` hosts answer five and then
   * 429. Enforced by a paced `fetchFn` on that endpoint's own transport, so an
   * endpoint's ceiling never slows its neighbours.
   */
  readonly minRequestSpacingMs?: number;
  /** Why this entry sits where it does, in one line. Provenance, not narration. */
  readonly note?: string;
}

export interface RpcChainEntry {
  readonly chainId: number;
  /** Human label used in logs and the lane doc. Not a user-facing chain name. */
  readonly label: string;
  /** Ordered. Index 0 is the default; every later entry is a failover. */
  readonly endpoints: readonly RpcEndpoint[];
}

// ── The table ───────────────────────────────────────────────────────

const TIMEOUT_MS = 30_000;

/**
 * Every chain Vex builds an EVM client for, with the endpoints measured on
 * 2026-09-05 from this machine.
 *
 * ORDERING RULE, applied to every row: the endpoint that serves the whole
 * method set goes first; an endpoint that refuses a method carries that method
 * in `methods.exclude` rather than being demoted, so the refusal costs zero
 * requests instead of one failed round trip.
 *
 * TWO ENDPOINTS ARE ABSENT ON PURPOSE. `base.drpc.org` was the default for five
 * separate tables and answered `eth_call`, `eth_getStorageAt` and `eth_getLogs`
 * with `{"code":30,"message":"Request timeout on the free plan"}` and a twelve
 * of twelve HTTP 408 burst: a Base launch broadcast through it could not be
 * confirmed. `1rpc.io/base` sat at the head of Morpho's Base failover list and
 * answers `eth_feeHistory` with "This endpoint has been discontinued".
 * `polygon-rpc.com`, `eth.llamarpc.com`, `base.llamarpc.com`, `1rpc.io/eth`,
 * `1rpc.io/arb` and `1rpc.io/sol` were measured dead or paywalled and must not
 * be adopted.
 */
const RPC_CHAINS: readonly RpcChainEntry[] = [
  {
    chainId: 1,
    label: "ethereum",
    endpoints: [
      {
        url: "https://mainnet.gateway.tenderly.co",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read primary: receipts, calls, feeHistory and 1000-block logs, 12/12 burst",
      },
      {
        url: "https://ethereum-rpc.publicnode.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        // The endpoint this repository has been broadcasting Ethereum through
        // (uniswap, pendle, morpho and kyberswap all pinned it), so it is the
        // one entry with broadcast evidence. Wide `eth_getLogs` is archive-gated.
        methods: { exclude: ["eth_getLogs"] },
        note: "broadcast endpoint; wide eth_getLogs archive-gated",
      },
      {
        url: "https://eth.drpc.org",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        // Refuses a 1000-block window with `{"code":12,"message":"Can't route
        // your request to suitable provider"}`.
        methods: { exclude: ["eth_getLogs"] },
        note: "read fallback; drpc free tier measured clean on Ethereum",
      },
    ],
  },
  {
    chainId: 10,
    label: "optimism",
    endpoints: [
      {
        url: "https://mainnet.optimism.io",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        // Read primary AND broadcast endpoint: the official OP node measured
        // clean on the whole set including head-block receipts, and is the one
        // Optimism entry with 12/12 burst evidence. This is the fix for D2 -
        // `optimism-rpc.publicnode.com` was the bundled default and refuses a
        // head-block receipt with -32602 "Archive requests require a personal
        // token", so every Optimism swap could broadcast and never confirm.
        note: "official OP endpoint: full method set, head-block receipts, 12/12 burst",
      },
      {
        url: "https://optimism.gateway.tenderly.co",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback",
      },
      {
        url: "https://optimism.drpc.org",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback; drpc measured clean on Optimism including receipts",
      },
    ],
  },
  {
    chainId: 56,
    label: "bsc",
    endpoints: [
      {
        url: "https://bsc-dataseed1.bnbchain.org",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        // BSC needs a two-entry METHOD SPLIT, not an ordering: no measured
        // keyless BSC endpoint serves both head-block receipts and
        // `eth_getLogs`. This one serves receipts (the D3 fix -
        // `bsc-rpc.publicnode.com` was the bundled default and refuses them as
        // archive requests) and refuses `eth_getLogs` at any width with -32005
        // "limit exceeded".
        methods: { exclude: ["eth_getLogs"] },
        note: "broadcast + read primary: head-block receipts, no eth_getLogs at any width",
      },
      {
        url: "https://bsc-rpc.publicnode.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        // The mirror image, and the ONLY reason it is on the list: it is the one
        // measured BSC endpoint that answers `eth_getLogs`. `include` rather
        // than `exclude` so nothing else can land here.
        methods: { include: ["eth_getLogs"] },
        note: "eth_getLogs lane only; refuses head-block receipts as archive",
      },
      {
        url: "https://bsc-dataseed1.defibit.io",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        methods: { exclude: ["eth_getLogs"] },
        note: "read fallback for the non-log method set",
      },
    ],
  },
  {
    chainId: 130,
    label: "unichain",
    endpoints: [
      {
        url: "https://mainnet.unichain.org",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        note: "official endpoint: full method set including head-block receipts",
      },
      {
        url: "https://unichain.gateway.tenderly.co",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback",
      },
      {
        url: "https://unichain-rpc.publicnode.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        methods: { exclude: ["eth_getLogs"] },
        note: "read fallback; eth_getLogs archive-gated",
      },
    ],
  },
  {
    chainId: 137,
    label: "polygon",
    endpoints: [
      {
        url: "https://polygon.gateway.tenderly.co",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read primary: answers the 1000-block window an order of magnitude faster than publicnode",
      },
      {
        url: "https://polygon-bor-rpc.publicnode.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        note: "broadcast endpoint (the bundled default this repository already broadcasts through); full method set",
      },
      {
        url: "https://polygon.drpc.org",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        // Refuses a wide window with `{"code":35,"message":"ranges over 10000
        // blocks are not supported on free plan"}`.
        methods: { exclude: ["eth_getLogs"] },
        note: "read fallback",
      },
    ],
  },
  {
    chainId: 143,
    label: "monad",
    endpoints: [
      {
        url: "https://rpc.monad.xyz",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        note: "official endpoint (25 rps documented); eth_getLogs capped at 100 blocks (-32614)",
      },
      {
        url: "https://rpc-mainnet.monadinfra.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback, officially documented (20 rps), historical state",
      },
      {
        url: "https://rpc3.monad.xyz",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback, officially documented (300/10 s)",
      },
    ],
    // `monad.drpc.org` is FORBIDDEN and deliberately absent: it answers
    // `eth_getTransactionReceipt` for a transaction from its OWN head block with
    // `{"code":26,"message":"Unknown block"}` and injects a gas field into
    // `eth_call` ("user-specified gas exceeds provider limit" for a call that
    // sent none). Every Monad endpoint caps `eth_getLogs`, so a Monad log
    // consumer must chunk whichever entry answers.
  },
  {
    chainId: 146,
    label: "sonic",
    endpoints: [
      {
        url: "https://rpc.soniclabs.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        note: "official endpoint: full method set including head-block receipts",
      },
      {
        url: "https://sonic-rpc.publicnode.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback",
      },
      {
        url: "https://sonic.drpc.org",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback",
      },
    ],
  },
  {
    chainId: 999,
    label: "hyperevm",
    endpoints: [
      {
        url: "https://hyperliquid.drpc.org",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        // READ PRIMARY, and the fix for D7. The official node answers the
        // standard `eth_feeHistory("0x4","latest",[50])` - the exact shape
        // viem's `estimateFeesPerGas` sends - with -32602 "invalid block range",
        // and rate-limits `eth_getLogs` and mid-burst `eth_call` with -32005.
        // This gateway served the whole set at about 280 ms with a 12/12 burst.
        note: "read primary: serves eth_feeHistory and eth_getLogs, which the official node refuses",
      },
      {
        url: "https://rpc.hypurrscan.io",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback",
      },
      {
        url: "https://rpc.hyperliquid.xyz/evm",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 1,
        broadcastSafe: true,
        // THE BROADCAST ENDPOINT, and the only one: it is the canonical
        // Hyperliquid node. Reads move off it, signatures do not.
        //
        // It answers the standard `eth_feeHistory("0x4","latest",[50])` - the
        // exact shape viem's `estimateFeesPerGas` sends - with -32602 "invalid
        // block range", so the method is excluded and a READ of it reaches the
        // gateway above. A PINNED execution is unscoped by construction and
        // would still meet the refusal; no HyperEVM consumer issues the method
        // today, and `rpc-endpoints.md` records the limitation.
        methods: { exclude: ["eth_feeHistory"] },
        note: "broadcast endpoint (canonical Hyperliquid node); refuses eth_feeHistory, rate-limits under burst",
        minRequestSpacingMs: 120,
      },
    ],
  },
  {
    chainId: 2020,
    label: "ronin",
    endpoints: [
      {
        url: "https://api.roninchain.com/rpc",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 2,
        broadcastSafe: true,
        // SINGLE-ENDPOINT CHAIN, and the retry budget is real because there is
        // nowhere to advance to. `eth_getLogs` is capped at 200 blocks (-32602
        // "requested block range 1001 exceeds the limit of 200"). Ronin's own
        // docs still list `ronin.lgns.net`, which no longer resolves in DNS, and
        // `ronin.drpc.org`, which failed `eth_call` and `eth_getBlockByNumber`
        // with `code 19` in a single pass - a fallback that fails the read a
        // quote depends on is worse than no fallback on a money path.
        note: "the only adoptable keyless Ronin endpoint; eth_getLogs capped at 200 blocks",
      },
    ],
  },
  {
    chainId: 4326,
    label: "megaeth",
    endpoints: [
      {
        url: "https://mainnet.megaeth.com/rpc",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 2,
        broadcastSafe: true,
        // SINGLE-ENDPOINT CHAIN. `megaeth-rpc.publicnode.com` does not exist and
        // every other provider is key-gated. The chain id question the audit
        // left open is closed: the endpoint echoes 0x10e6 = 4326, which is what
        // docs.megaeth.com and chainid.network both publish, so the `chainId`
        // key above IS the expected echo and the verifier can now check it.
        note: "the only keyless MegaETH endpoint; chain id 4326 confirmed against the chain's own docs",
      },
    ],
  },
  {
    chainId: 4663,
    label: "robinhood",
    endpoints: [
      {
        url: "https://rpc.mainnet.chain.robinhood.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        // Robinhood's own documented endpoint. It stays FIRST even though both
        // alternates are faster and burst-cleaner, for two reasons that both
        // matter: it is the only endpoint that answers the 500000-block
        // `eth_getLogs` window the candles reader is built around, and Vex's own
        // token chain must not broadcast through a third party by default.
        //
        // PACED. MEASURED 2026-09-05: one 1849 ms `eth_getLogs` was followed by
        // four consecutive `429 Too Many Requests`, while a pure twelve-request
        // `eth_call` burst was clean. The two alternates below absorb the calls
        // and receipts; this spacing keeps the wide-log lane inside the shape
        // that answered.
        minRequestSpacingMs: 150,
        note: "official endpoint: whole method set including the 500000-block candles window; sheds load after a heavy query",
      },
      {
        url: "https://robinhood-rpc.publicnode.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        // The second keyless 4663 endpoint, and half the answer to D6 ("Vex's
        // own token chain has exactly one endpoint"). Echoes 0x1237, serves a
        // head-block receipt in 139 ms, 12/12 on an `eth_call` burst. Refuses
        // `eth_getLogs` beyond the hot window as an archive request, including
        // the real candles window. NOT endorsed by Robinhood: read-only.
        methods: { exclude: ["eth_getLogs"] },
        note: "read fallback: receipts and calls, eth_getLogs archive-gated",
      },
      {
        url: "https://rpc.ordofi.network",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        // The third keyless 4663 endpoint. READ-ONLY AND LAST, DELIBERATELY:
        // OrdoFi describes itself as an execution layer that auctions backrun
        // rights on submitted transactions, which is a change to inclusion and
        // ordering semantics the user never consented to. `broadcastSafe: false`
        // is therefore a product decision, not a capability judgement. Its
        // `eth_getLogs` serves 10000 blocks and refuses 500000 with -32005; it
        // sits behind the endpoint that answers that window, so the wide lane
        // never reaches it.
        note: "read fallback; order-flow-auction relay, never a broadcast target",
      },
    ],
  },
  {
    chainId: 5000,
    label: "mantle",
    endpoints: [
      {
        url: "https://mantle-rpc.publicnode.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read primary: two to three times faster than the official endpoint on every measured method",
      },
      {
        url: "https://rpc.mantle.xyz",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        // The official endpoint, and therefore the broadcast target even though
        // it is not the read primary. This chain used to ship TWO different
        // bundled urls depending on which venue asked (kyberswap said
        // `rpc.mantle.xyz`, pendle said the publicnode host); one list ends that.
        note: "broadcast endpoint (official)",
      },
      {
        url: "https://mantle.drpc.org",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback",
      },
    ],
  },
  {
    chainId: 8453,
    label: "base",
    endpoints: [
      {
        url: "https://base.gateway.tenderly.co",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        // READ PRIMARY. It clears every Base cell the previous candidates each
        // failed: head-block receipts (publicnode cannot), state and calls
        // (`base.drpc.org` cannot), `eth_feeHistory` (`1rpc.io/base` cannot),
        // and a twelve of twelve `eth_call` burst (`mainnet.base.org` cannot).
        // Its `eth_getLogs` cap is 1000 blocks and it STATES the cap in the
        // error, which `classifyRpcFailure` reads as `range_capped` - so the
        // 10000-block candles window fails over to the `*.base.org` lane below
        // instead of being excluded here and losing the narrow windows too.
        note: "read primary: full method set, 12/12 burst, eth_getLogs capped at 1000 blocks",
      },
      {
        url: "https://developer-access-mainnet.base.org",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        // The WIDE-LOG LANE. Serves the real 10000-block candles window. Shares
        // the 5 rps ceiling of its sibling below, so it is redundancy for that
        // lane, not extra throughput, and it is paced accordingly.
        minRequestSpacingMs: 250,
        note: "wide eth_getLogs lane; paced against a measured ~5 rps ceiling",
      },
      {
        url: "https://mainnet.base.org",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        // THE BROADCAST ENDPOINT: the official Base node, and the only Base
        // entry with an official pedigree. Also the second wide-log server.
        // Base is therefore a chain where the read primary and the broadcast
        // endpoint are deliberately different hosts.
        minRequestSpacingMs: 250,
        note: "broadcast endpoint (official) and wide eth_getLogs lane; paced against a measured ~5 rps ceiling",
      },
    ],
    // ABSENT ON PURPOSE: `base.drpc.org` (twelve of twelve HTTP 408 and a
    // free-plan timeout on every `eth_call`, `eth_getStorageAt` and
    // `eth_getLogs` - it was the default for FIVE separate tables and a Base
    // launch broadcast through it could not be confirmed), `1rpc.io/base`
    // ("This endpoint has been discontinued" on `eth_feeHistory`),
    // `base-mainnet.public.blastapi.io` (BlastAPI's public tier is being
    // decommissioned chain by chain; Optimism and Polygon already answer "Blast
    // API is no longer available"), `base-rpc.publicnode.com` (refuses
    // head-block receipts), `base.llamarpc.com`, `base.meowrpc.com` and
    // `0xrpc.io/base` (dead, rate-limited from the second request, or 404).
  },
  {
    chainId: 9745,
    label: "plasma",
    endpoints: [
      {
        url: "https://rpc.plasma.to",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 2,
        broadcastSafe: true,
        // SINGLE-ENDPOINT CHAIN, and plasma.org says so itself: "Rate limited
        // and not for production systems." No second public url is published,
        // `plasma.drpc.org` is refused on the free plan and
        // `plasma-rpc.publicnode.com` does not exist. Pendle 9745 has no
        // failover; the user override is the only mitigation.
        note: "the only published Plasma endpoint; no failover exists",
      },
    ],
  },
  {
    chainId: 42161,
    label: "arbitrum",
    endpoints: [
      {
        url: "https://arb1.arbitrum.io/rpc",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        note: "official endpoint: whole method set including head-block receipts and a 1000-block eth_getLogs",
      },
      {
        url: "https://arbitrum.gateway.tenderly.co",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback",
      },
      {
        url: "https://arbitrum-one-rpc.publicnode.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        // Refuses a head-block receipt and a wide `eth_getLogs` with -32602
        // "Archive requests require a personal token".
        methods: { exclude: ["eth_getTransactionReceipt", "eth_getLogs"] },
        note: "read fallback for the non-archive method set",
      },
    ],
    // `arbitrum.drpc.org` is deliberately absent: it answered
    // `eth_getTransactionReceipt` for a transaction from its OWN latest block
    // with `{"code":26,"message":"Unknown block"}` and returned intermittent
    // `code 19` "Temporary internal error".
  },
  {
    chainId: 43114,
    label: "avalanche",
    endpoints: [
      {
        url: "https://api.avax.network/ext/bc/C/rpc",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        note: "official Ava Labs endpoint: head-block receipts, fastest measured",
      },
      {
        url: "https://avalanche-c-chain-rpc.publicnode.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback (the previous bundled default)",
      },
      {
        url: "https://avalanche.drpc.org",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback",
      },
    ],
  },
  {
    chainId: 59144,
    label: "linea",
    endpoints: [
      {
        url: "https://rpc.linea.build",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        note: "official endpoint: full method set including head-block receipts",
      },
      {
        url: "https://linea.drpc.org",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback",
      },
      {
        url: "https://linea-rpc.publicnode.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        methods: { exclude: ["eth_getLogs"] },
        note: "read fallback; eth_getLogs archive-gated",
      },
    ],
  },
  {
    chainId: 80094,
    label: "berachain",
    endpoints: [
      {
        url: "https://rpc.berachain.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: true,
        note: "official endpoint",
      },
      {
        url: "https://rpc.berachain-apis.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback: fastest measured, verified on head receipts and feeHistory",
      },
      {
        url: "https://berachain-rpc.publicnode.com",
        tier: "bundled",
        timeoutMs: TIMEOUT_MS,
        retryCount: 0,
        broadcastSafe: false,
        note: "read fallback",
      },
    ],
  },
];

const BY_CHAIN_ID: ReadonlyMap<number, RpcChainEntry> = new Map(
  RPC_CHAINS.map((entry) => [entry.chainId, entry]),
);

/** Every chain the table declares, in declaration order. Read-only. */
export function listRpcChains(): readonly RpcChainEntry[] {
  return RPC_CHAINS;
}

/** The table row for a chain id, or `undefined` when the table has never heard of it. */
export function getRpcChainEntry(chainId: number): RpcChainEntry | undefined {
  return BY_CHAIN_ID.get(chainId);
}

// ── Resolution ──────────────────────────────────────────────────────

export interface ResolveRpcEndpointsOptions {
  /**
   * Endpoints a PROVIDER registry (Khalani, Relay, viem's bundled chain data)
   * supplied for this chain, already SSRF-validated by the caller that trusts
   * them. Appended after the bundled entries, never before, and never for a
   * chain the caller did not validate them for.
   */
  readonly providerUrls?: readonly string[];
  /** Endpoints this chain is known to have failed a chain-id echo on. */
  readonly disqualifiedUrls?: ReadonlySet<string>;
}

/**
 * The ordered endpoint list for one chain: the user's own endpoints first, then
 * the bundled table, then any provider-registry urls the caller supplied.
 *
 * THE USER GOES FIRST, MECHANICALLY, FOR EVERY CONSUMER. That is the whole
 * point of the resolver existing: before it, `localChainRpcUrls` reached three
 * of eleven consumer families because each family had to remember to look, and
 * eight of them did not. A user endpoint is NOT ssrf-filtered and NOT method
 * scoped - it is the app's own configuration and rule 90's local-first posture
 * makes the user's own node the user's choice (a private archive node on
 * `http://localhost:8545` is a supported setup). It does carry a retry budget
 * of one, because a user's single node has the bundled list behind it.
 *
 * Duplicates are removed, first occurrence winning its slot, so a user who
 * copies a bundled url into their config promotes it rather than doubling it.
 */
export function resolveRpcEndpoints(
  chainId: number,
  options: ResolveRpcEndpointsOptions = {},
): readonly RpcEndpoint[] {
  const disqualified = options.disqualifiedUrls;
  const seen = new Set<string>();
  const out: RpcEndpoint[] = [];

  const push = (endpoint: RpcEndpoint): void => {
    if (seen.has(endpoint.url)) return;
    if (disqualified?.has(endpoint.url) === true) return;
    seen.add(endpoint.url);
    out.push(endpoint);
  };

  for (const url of getUserRpcOverridesForChain(chainId)) {
    push({
      url,
      tier: "user",
      timeoutMs: TIMEOUT_MS,
      retryCount: 1,
      broadcastSafe: true,
      note: "configured by the owner of this install",
    });
  }

  for (const endpoint of BY_CHAIN_ID.get(chainId)?.endpoints ?? []) push(endpoint);

  for (const url of options.providerUrls ?? []) {
    // retryCount 2, not 0: for a chain the table has never heard of, a provider
    // url is frequently the ONLY entry, and a list of one has nowhere to
    // advance to. This preserves what the Khalani and Relay clients did before
    // they were routed through this resolver.
    // `broadcastSafe` is TRUE for a provider url, and only here: for a chain the
    // table has never heard of, the Khalani or Relay registry entry is the only
    // endpoint that exists, and refusing to broadcast through it would break
    // every bridge leg on those chains. The caller has already SSRF-validated it
    // (`relay/chain-client.ts` `isSsrfSafePublicHttpsUrl`). When the table DOES
    // know the chain, its own broadcast-safe entry comes first and wins.
    push({
      url,
      tier: "provider",
      timeoutMs: TIMEOUT_MS,
      retryCount: 2,
      broadcastSafe: true,
      note: "provider registry",
    });
  }

  return out;
}

// ── Failure classification ──────────────────────────────────────────

/**
 * Why an endpoint refused, named.
 *
 * Adopted from MetaMask's enumerated retry filter and status mapping
 * (`rpc-service.ts:406-425`, `:750-786`), which turns "the request threw" into
 * a class the caller can act on. Vex needs its own vocabulary because our
 * measured refusals are METHOD-PARTIAL, not endpoint-down: an endpoint that is
 * twelve of twelve healthy on `eth_call` can permanently refuse a wide
 * `eth_getLogs`, which is why MetaMask's per-endpoint circuit breaker is
 * rejected here (it would never open, and the log reader would never reach the
 * endpoint that can serve it).
 *
 * - `archive_gated`   the node keeps only recent state and wants a paid token
 * - `range_capped`    the requested block window or result set was too wide
 * - `rate_limited`    too many requests, or a per-method quota
 * - `compute_budget`  a free-plan compute allowance was spent (the drpc shape)
 * - `method_unsupported` this endpoint does not serve this method at all
 * - `execution_reverted` the CONTRACT answered; this is not an endpoint failure
 * - `transport`       connection, timeout, 5xx, or an unparseable body
 * - `unknown`         classified nowhere; treated as a failover trigger
 */
export type RpcFailureClass =
  | "archive_gated"
  | "range_capped"
  | "rate_limited"
  | "compute_budget"
  | "method_unsupported"
  | "execution_reverted"
  | "transport"
  | "unknown";

/**
 * Classes that make the resolver advance to the next endpoint.
 *
 * `execution_reverted` is deliberately absent: a revert is the chain's ANSWER,
 * and asking a second node the same question gets the same answer while costing
 * a round trip and, on a pre-sign simulation, blurring which node the caller's
 * decision was made against.
 */
const FAILOVER_CLASSES: ReadonlySet<RpcFailureClass> = new Set([
  "archive_gated",
  "range_capped",
  "rate_limited",
  "compute_budget",
  "method_unsupported",
  "transport",
  "unknown",
]);

/** True when a failure of this class should be retried on the NEXT endpoint. */
export function shouldFailoverOn(failure: RpcFailureClass): boolean {
  return FAILOVER_CLASSES.has(failure);
}

interface ErrorFacts {
  readonly codes: readonly number[];
  readonly statuses: readonly number[];
  readonly text: string;
}

/**
 * Collect the numeric codes, HTTP statuses and message text from an error and
 * every `cause` beneath it.
 *
 * viem wraps a JSON-RPC error body several layers deep (`RpcRequestError` inside
 * `InvalidParamsRpcError` inside the action's own error), and the provider's own
 * `code` and `message` are the only things that identify the refusal, so the
 * whole chain is walked rather than the top frame inspected.
 */
function collectErrorFacts(error: unknown): ErrorFacts {
  const codes: number[] = [];
  const statuses: number[] = [];
  const parts: string[] = [];
  const seen = new Set<unknown>();

  let current: unknown = error;
  for (let depth = 0; depth < 12 && current !== null && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);

    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;

    const record = current as Record<string, unknown>;
    if (typeof record.code === "number") codes.push(record.code);
    if (typeof record.status === "number") statuses.push(record.status);
    for (const key of ["message", "shortMessage", "details", "reason"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) parts.push(value);
    }
    const nested = record.error;
    if (nested !== undefined && nested !== null && !seen.has(nested)) {
      const nestedRecord = nested as Record<string, unknown>;
      if (typeof nestedRecord.code === "number") codes.push(nestedRecord.code);
      if (typeof nestedRecord.message === "string") parts.push(nestedRecord.message);
    }
    current = record.cause;
  }

  return { codes, statuses, text: parts.join(" | ").toLowerCase() };
}

/**
 * Name the refusal behind an error thrown by an RPC call.
 *
 * The fixtures this is written against are the VERBATIM bodies the endpoints
 * returned on 2026-09-05, kept in `src/__tests__/fixtures/rpc-failures/`. A
 * classifier written from a provider's documentation instead of its bytes is
 * exactly the class of guess rule 10 exists to forbid.
 *
 * Never throws, whatever it is handed.
 */
export function classifyRpcFailure(error: unknown): RpcFailureClass {
  const { codes, statuses, text } = collectErrorFacts(error);

  // A revert is an ANSWER. Checked first so a node that spells it with an
  // unusual code cannot be mistaken for an endpoint failure and re-asked.
  if (codes.includes(3) || text.includes("execution reverted")) return "execution_reverted";

  if (text.includes("archive request")) return "archive_gated";

  // The drpc free-plan compute allowance: `{"code":30,"message":"Request
  // timeout on the free plan, please upgrade to paid plan"}`. Named apart from
  // `rate_limited` because it is spent by WORK, not by request count, and does
  // not recover by waiting a moment.
  if (codes.includes(30) && text.includes("free plan")) return "compute_budget";

  if (
    text.includes("block range")
    || text.includes("blocks range")
    || text.includes("block range should work")
    || text.includes("exceeds max results")
    || text.includes("limited to a 100 range")
    || text.includes("response too large")
    // drpc: "ranges over 10000 blocks are not supported on free plan". It names
    // a plan, but the remedy is a narrower window, not a wait, so it is a range
    // cap rather than a compute budget.
    || text.includes("blocks are not supported")
    || text.includes("query returned more than")
  ) {
    return "range_capped";
  }

  if (
    statuses.includes(429)
    || codes.includes(429)
    || text.includes("too many requests")
    || text.includes("rate limit")
    || text.includes("limit exceeded")
  ) {
    return "rate_limited";
  }

  if (
    codes.includes(-32601)
    || codes.includes(-32004)
    || text.includes("method not found")
    || text.includes("method not supported")
    || text.includes("has been discontinued")
    || text.includes("paid plans only")
  ) {
    return "method_unsupported";
  }

  if (
    statuses.some((status) => status >= 500 || status === 408 || status === 410)
    || text.includes("timed out")
    || text.includes("timeout")
    || text.includes("fetch failed")
    || text.includes("socket")
    || text.includes("econnreset")
    || text.includes("econnrefused")
    || text.includes("enotfound")
    || text.includes("network error")
    || text.includes("http request failed")
    || text.includes("is not valid json")
  ) {
    return "transport";
  }

  return "unknown";
}
