# RPC endpoints: one owner for every chain

`rpc-endpoints.ts` owns the data (which endpoints a chain has, in what order,
with what method scope, and which of them may carry a signature).
`rpc-transport.ts` owns the mechanism (how that list becomes a viem transport,
the `eth_chainId` echo, the pinned signing transport, pacing, and the two
structured events). Nothing else in the repository declares an RPC url.

Before this, six venue tables each pinned one url per chain and only three of
eleven consumer families could see the user's own endpoint. `base.drpc.org` was
the default in five files after the shared table had already moved off it, and
it answered every Base `eth_call` with a free-plan timeout.

## The table

Each chain is a chain id plus an ORDERED endpoint list. Each entry carries:

| field | meaning |
|---|---|
| `url` | keyless https endpoint; no key, no account, no query |
| `tier` | `user` (from config), `bundled` (this table), `provider` (Khalani/Relay) |
| `methods` | viem `{ include }` or `{ exclude }`; enforced before any request leaves |
| `timeoutMs` | per endpoint |
| `retryCount` | attempts minus one, on THIS endpoint, before the list advances |
| `broadcastSafe` | may carry `eth_sendRawTransaction` and the reads a signature is bound to |
| `minRequestSpacingMs` | pace, for an endpoint measured shedding load |

`unsupportedMethods` on the chain records a method NO endpoint serves, as data
rather than as a hostname branch in the transport.

### What is shipped, per chain (measured 2026-09-05, this machine, one network path)

Read primary first; `B` marks the broadcast endpoint.

| chain | endpoints, in order |
|---|---|
| Ethereum 1 | `mainnet.gateway.tenderly.co`, `ethereum-rpc.publicnode.com` **B** (no `eth_getLogs`), `eth.drpc.org` (no `eth_getLogs`) |
| Optimism 10 | `mainnet.optimism.io` **B**, `optimism.gateway.tenderly.co`, `optimism.drpc.org` |
| BSC 56 | `bsc-dataseed1.bnbchain.org` **B** (no `eth_getLogs`), `bsc-rpc.publicnode.com` (`eth_getLogs` ONLY), `bsc-dataseed1.defibit.io` (no `eth_getLogs`) |
| Unichain 130 | `mainnet.unichain.org` **B**, `unichain.gateway.tenderly.co`, `unichain-rpc.publicnode.com` (no `eth_getLogs`) |
| Polygon 137 | `polygon.gateway.tenderly.co`, `polygon-bor-rpc.publicnode.com` **B**, `polygon.drpc.org` (no `eth_getLogs`) |
| Monad 143 | `rpc.monad.xyz` **B**, `rpc-mainnet.monadinfra.com`, `rpc3.monad.xyz` |
| Sonic 146 | `rpc.soniclabs.com` **B**, `sonic-rpc.publicnode.com`, `sonic.drpc.org` |
| HyperEVM 999 | `hyperliquid.drpc.org`, `rpc.hypurrscan.io`, `rpc.hyperliquid.xyz/evm` **B** (paced 120 ms) |
| Ronin 2020 | `api.roninchain.com/rpc` **B** - single endpoint |
| MegaETH 4326 | `mainnet.megaeth.com/rpc` **B** - single endpoint |
| Robinhood 4663 | `rpc.mainnet.chain.robinhood.com` **B** (paced 150 ms), `robinhood-rpc.publicnode.com` (no `eth_getLogs`), `rpc.ordofi.network` |
| Mantle 5000 | `mantle-rpc.publicnode.com`, `rpc.mantle.xyz` **B**, `mantle.drpc.org` |
| Base 8453 | `base.gateway.tenderly.co`, `developer-access-mainnet.base.org` (paced 250 ms), `mainnet.base.org` **B** (paced 250 ms) |
| Plasma 9745 | `rpc.plasma.to` **B** - single endpoint |
| Arbitrum 42161 | `arb1.arbitrum.io/rpc` **B**, `arbitrum.gateway.tenderly.co`, `arbitrum-one-rpc.publicnode.com` (no receipts, no `eth_getLogs`) |
| Avalanche 43114 | `api.avax.network/ext/bc/C/rpc` **B**, `avalanche-c-chain-rpc.publicnode.com`, `avalanche.drpc.org` |
| Linea 59144 | `rpc.linea.build` **B**, `linea.drpc.org`, `linea-rpc.publicnode.com` (no `eth_getLogs`) |
| Berachain 80094 | `rpc.berachain.com` **B**, `rpc.berachain-apis.com`, `berachain-rpc.publicnode.com` |

Three chains ship ONE endpoint because no adoptable keyless second exists:
Plasma (its own site says "rate limited and not for production systems"),
MegaETH, and Ronin (its docs still list a host that no longer resolves in DNS
and one that failed `eth_call` in the same pass). For those, a user override is
the only redundancy.

On five chains the read primary and the broadcast endpoint are deliberately
DIFFERENT hosts: Base, Ethereum, Polygon, Mantle and HyperEVM. The read primary
is the fastest measured endpoint that serves the whole read set; the broadcast
endpoint is the one with broadcast evidence.

### Endpoints deliberately not shipped

`base.drpc.org` (twelve of twelve HTTP 408; a Base launch broadcast through it
could not be confirmed), every `*.public.blastapi.io` (the public tier is being
decommissioned chain by chain; Optimism and Polygon already answer "Blast API is
no longer available"), `1rpc.io/*` (discontinued and paid-plan-only methods),
`rpc.ankr.com/*` (key-gated), `*.llamarpc.com` (gone), `cloudflare-eth.com`
(`-32603` on every real method), `polygon-rpc.com` (API key disabled),
`monad.drpc.org` (answers "Unknown block" for a receipt from its own head block
and injects a gas field into `eth_call`), `arbitrum.drpc.org` (same "Unknown
block" behaviour), `*.meowrpc.com`, `0xrpc.io/*`, blockpi public, `ronin.lgns.net`,
`eth.merkle.io`, `rpc.arrowrpc.com`. A test asserts none of them can come back.

## Failure classes

`classifyRpcFailure` names a refusal from the provider's own bytes, because the
numeric codes do not distinguish them (three different refusals all arrive as
`-32602`):

| class | meaning | advances? |
|---|---|---|
| `archive_gated` | node keeps only recent state and wants a paid token | yes |
| `range_capped` | requested block window or result set too wide | yes |
| `rate_limited` | too many requests, or a per-method quota | yes |
| `compute_budget` | a free-plan compute allowance is spent | yes |
| `method_unsupported` | this endpoint does not serve this method | yes |
| `transport` | connection, timeout, 5xx, unparseable body | yes |
| `unknown` | classified nowhere | yes |
| `execution_reverted` | the CONTRACT answered | **no** |

A revert is an answer. Asking a second node the same question gets the same
answer, costs a round trip, and blurs which node a pre-sign decision was made
against. Every other class means "this endpoint cannot answer", so the list
advances.

The fixtures are byte-for-byte captures of the probe output
(`src/__tests__/fixtures/rpc-failures/bodies.ts`). A classifier written from a
provider's documentation instead of its bytes is the guess rule 10 forbids.

## The pinning rule

Reads ride the failover list. An EXECUTION rides ONE endpoint, chosen once and
never changed: the first entry that is `broadcastSafe` AND serves every method in
`SIGNING_METHODS`. The nonce read, the fee estimate, the pre-sign revalidation
and `eth_sendRawTransaction` all land on it.

Two independent filters, because they answer two different questions.
`broadcastSafe` asks whether this repository has EVIDENCE the node accepts signed
material - `eth_sendRawTransaction` costs gas and was never probed anywhere, so
the flag is set only for a chain's official endpoint, the endpoint already
broadcast through, or the user's own. The method check asks whether the node can
CONFIRM what it accepted; it skips `arbitrum-one-rpc.publicnode.com` and
`bsc-rpc.publicnode.com`, which refuse a head-block receipt as an archive
request.

The pinned transport carries `retryCount: 0`. viem's retry filter retries on
429, on `-32005` and on 5xx, and applying that to `eth_sendRawTransaction` is an
automatic re-broadcast of signed material: forbidden by rule 90, and contrary to
`staged-broadcast.ts`, which treats a send-time throw as `ambiguous` so the row
reconciles instead of re-sending.

The pinned host is recorded as a structured event (`rpc.pinned`), host only.

## Pacing numbers

Only where an endpoint measurably sheds load and pace is the remaining control:

- `rpc.mainnet.chain.robinhood.com` - 150 ms. One 1849 ms `eth_getLogs` was
  followed by four consecutive `429`, while a pure twelve-request `eth_call`
  burst was clean. The two read fallbacks absorb calls and receipts.
- `mainnet.base.org` and `developer-access-mainnet.base.org` - 250 ms each.
  Both answer about five requests per second and then `429`. They are the only
  servers for the wide `eth_getLogs` window the candles and launch-keeper
  modules need.
- `rpc.hyperliquid.xyz/evm` - 120 ms. Rate-limits mid-burst.

Pacing is a QUEUE, per endpoint: n requests take at least n x spacing, which is
bounded and visible, instead of arriving as a `429` the caller must interpret.
It is per endpoint rather than per chain because on Base the Tenderly gateway
took twelve of twelve at full speed while both `*.base.org` hosts did not.

## How a user overrides

Two config keys, unchanged in shape:

```jsonc
{
  "localChainRpcUrls": { "8453": "http://localhost:8545" },
  "pendleRpcUrls":     { "1": "https://my-node.example" }
}
```

Both are merged by `@config/chain-rpc-overrides.ts` and placed AHEAD of every
bundled entry by `resolveRpcEndpoints`, for every venue. A user endpoint is not
SSRF-filtered and not method-scoped: it is the app's own configuration and rule
90's local-first posture makes the owner's own node the owner's choice, loopback
included. It is `broadcastSafe`.

Solana keeps `config.solana.rpcUrl`. A stored value equal to an endpoint this
repository once shipped as its bundled default is treated as a bundled default
and superseded by the table; anything else is the user's and wins for both roles.

## What stays provider-owned

Khalani's `/v1/chains` and Relay's `/chains` remain the authority for chains this
table has never heard of. Their urls enter the resolver as `provider` tier -
after the user's entries and after the bundled list - and only where the caller
has already SSRF-validated them (`relay/chain-client.ts`
`isSsrfSafePublicHttpsUrl`). For a chain the table does not know, the provider
url is the only endpoint that exists and is therefore broadcast-safe; when the
table DOES know the chain, its own broadcast endpoint comes first and wins.

## Known limitations

- `eth_sendRawTransaction` and `eth_estimateGas` were never probed on any
  endpoint: they mutate or cost gas. Every "serves the money path" claim rests
  on `eth_call`, `eth_getStorageAt`, `eth_getTransactionReceipt`,
  `eth_getTransactionCount` and `eth_feeHistory`, which is the same class of
  node work, not on a broadcast. `broadcastSafe` exists precisely because that
  gap cannot be closed by measurement.
- Receipts were probed on HEAD-BLOCK transactions only. Archive-depth behaviour
  (the case the bridge verifier hits after a month) is unmeasured here.
- Rate limits are per IP and per window. The pacing numbers are shapes observed
  from one address, not guaranteed constants.
- HyperEVM's broadcast endpoint refuses the standard `eth_feeHistory` form. No
  HyperEVM consumer issues it today; a future one must read fees through the
  read list.
- The chain-id echo runs once per process per chain, on the transport's first
  request. It costs one extra request per endpoint per chain per process.
