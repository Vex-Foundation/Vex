# pools.fun - provider module

REST client, verified on-chain fragments, the launch calldata VERIFIER, the fee
venue and the claim reads for the pools.fun token launchpad on Robinhood Chain
(chainId 4663), served from `api.bankr.bot`.

This module performs **no signing and no DB writes**: it reads, it decodes, and
it judges. Signing, authorization and settlement live in
`src/vex-agent/tools/protocols/pools/`.

The provider publishes NO documentation, no schema, and no stability promise.
Every fact in this file was MEASURED against the live API or read out of a
Blockscout-verified contract source; nothing is transcribed from a doc site
(docs.pools.fun still lists the core addresses as "TBD"). Raw captures live in
`src/__tests__/pools-fun/fixtures/live-captures/`.

## What this module is

| File | Responsibility |
|---|---|
| `client.ts` | `PoolsFunClient` + `getPoolsFunClient()` singleton (keyed on the config base URL). Injects `chain=robinhood`, requires `platform`, clamps limits, builds URLs in a stable key order. |
| `types.ts` | `PoolsToken` (discover row), `PoolsCandle` / `PoolsCandles`, request param types. |
| `validation.ts` + `validation/` | Zod validators over raw `unknown` (tolerant reader). |
| `errors.ts` | `mapPoolsFunError` / `mapTransportError` to `ErrorCodes.POOLS_*`. |
| `constants.ts` | Base URL default, chain id and slug, contract addresses, server enums, limit caps, the 1 percent pool fee. |
| `abi.ts` | Verified PartyLocker, PartyToken and `TokenLaunched` fragments. |
| `evm/token-registration.ts` | The four on-chain reads behind `pools.token`, batched at one pinned block. |

Base URL is `services.poolsFunApiUrl` in the Vex config (default
`https://api.bankr.bot`) because it is an environment endpoint, not a secret.

## Implemented reads (what this module actually calls)

Two endpoints, both keyless public GETs. `cache-control: max-age=5` on discover;
no documented rate limit; no auth anywhere in this module. Everything else the
probe verified is in **Verified provider reference** below, recorded but not
wired.

### `GET /discover` - list, filter, screen, search

Every parameter below is server-side. Two of them are mandatory and the client
supplies or demands both (see Quirks).

| param | accepted values | notes |
|---|---|---|
| `chain` | `base` \| `robinhood` | **Always sent as `robinhood`.** Absent defaults to Base. |
| `platform` | `poolsfun` \| `sushi` \| `all` | **Required argument of the client.** Absent returns a third launchpad's tokens. |
| `q` | free text | name/symbol search; the frontend's search bar. |
| `sortBy` | `marketCapUsd`, `vol1m`, `vol5m`, `vol1h`, `vol6h`, `vol24h`, `txCount24h`, `priceChange1m`, `priceChange5m`, `priceChange1h`, `priceChange6h`, `priceChange24h`, `lastTradeAt`, `deployedAt` | the full server enum, read out of its own rejection message. `trending` is a client-side blend in the UI and is NOT a server sort. |
| `order` | `asc` \| `desc` | |
| `limit` | 1-100 | the client clamps to 100. |
| `cursor` | opaque base64 | from a previous `nextCursor`. |
| `live` | `true` | the provider's recently-active feed. |
| `minMarketCap` / `maxMarketCap` | number (USD) | display-grade source. |
| `minVol` + `volTimeframe` | number + `1m`\|`5m`\|`1h`\|`6h`\|`24h` | a floor without a window is meaningless; the handler rejects half a pair. |
| `minTxCount24h` | integer | |
| `maxAgeHours` | number | the fresh-launch filter (there is no curve stage to filter on). |
| `deployer` / `feeRecipient` | address | |

Response: `{ results: Row[], nextCursor: string | null }`. Row:

```
tokenAddress, poolId, chain, platform, pairedAsset, pairedStock?,
name, symbol, decimals, totalSupply, imageUri,
deployerAddress, deployerXUsername, deployerXProfileImageUrl,
feeRecipientAddress, feeRecipientXUsername, feeRecipientXProfileImageUrl,
tweetUrl, websiteUrl, deployedAt (ISO), lastTradeAt (ISO),
lastPriceEth, lastPriceUsd, marketCapUsd,
vol1m, vol5m, vol1h, vol6h, vol24h, txCount24h,
priceChange1m, priceChange5m, priceChange1h, priceChange6h, priceChange24h
```

### `GET /discover/{tokenAddress}/ohlcv` - candles

`?chain=robinhood&timeframe=minute|hour|day&aggregate=1..24&limit=1..1000`
(server default 30). One candle spans `aggregate x timeframe`.

`limit` 1000 is the PROVIDER's hard cap, not our choice: `limit=10000` is
refused with `too_big: expected number to be <=1000`, and `limit=1000` really
returns 1000 rows (both measured 2026-08-19). We expose exactly that ceiling.
Longer history would need a time cursor on this endpoint; none is documented
and the response carries no paging field, so a deeper window is not reachable
today. Widen `aggregate` instead: `day x 3` covers ~8 years in 1000 candles.

Response: `{ ohlcv: [[unixSeconds, open, high, low, close, volumeUsd], ...],
pool: {address, network}, pair: {baseSymbol, quoteSymbol}, watermark?: {...} }`.

## Contracts (Robinhood Chain, chainId 4663)

| What | Address |
|---|---|
| PartyFactory (pools.fun launcher) | `0x626C3d09B65bF5d1D40E0D5F25e19fa49783B3D4` |
| PartyLocker (holds every LP NFT; `getPoolInfo`, `getPoolSplits`, fee claims) | `0x35E41f84d3fD61d4648F0c8B41a1E7d301bCd75E` |
| PoolsFunLaunchGateway (backend-mined launch path, charges the deployment fee) | `0x3AB42e7dd316aF8854033bc216C657eD34961164` |
| SushiLaunchpad (the `platform=sushi` launcher) | `0x104F1Ab42674565EC3DF0BFEbCcC4186f72fA7ED` |
| DopplerERC20V1Factory (the launcher you get with NO `platform` param) | `0x1B37D3a72082029c44B35B604Ea473617580b69a` |
| SushiSwap V3 Factory | `0xE51960f1B45f1C9FB6D166E6a884F866fC70433B` |
| NonfungiblePositionManager | `0x51d0e5188afe12d502e29D982d20C190e7816107` |
| Sushi RouteProcessor | `0x8e6fd69a77e88ee20ba4b4fbd59dfcda3ec0e98a` |
| WETH (18 decimals) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG (**6 decimals**) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

**Three launchers, one API.** `platform=poolsfun` is PartyFactory,
`platform=sushi` is the older SushiLaunchpad, and OMITTING the parameter gives
Bankr/Doppler tokens whose pools are Uniswap V4 and whose `poolId` is a 32-byte
pool id rather than a pool address. All three sit on the same chain and all three
look like plausible data. This is why `platform` is a required client argument
rather than an optional one.

## Provider quirks (all measured)

- **`platform` and `chain` are both traps, and both fail silently.** No
  `platform` gives a different launchpad; no `chain` gives Base. The client
  makes the first structurally impossible and always sends the second.
- **`decimals` and `totalSupply` split by launcher.** Every `poolsfun` row sends
  both as `null`; `sushi` rows send `18` and a raw supply string. Neither is
  trusted: `pools.token` reads decimals on-chain, and total supply is a protocol
  constant (one billion, minted whole at deploy).
- **Every price, volume, market cap and price change is a display-grade float**
  with no decimals metadata and no executable meaning. They never reach a trade
  decision; a KyberSwap quote is the financial truth.
- **Symbols are not identities.** Three live tokens answered to `SUSHICAT` when
  this was measured, across both launchers. Identity is `tokenAddress`.
- **The canonical pool is the locker's**, not any pool an indexer lists: tokens
  accrue secondary arbitrage pools on other DEXes. `PartyLocker.getPoolInfo`
  answers it. On a `poolsfun` row the API's `poolId` matches that address.
- **A `sushi` token is not in the pools.fun locker** and `getPoolInfo` returns
  the zero address for every field. Zeroes are not data, and neither is silence:
  the read module reports THREE outcomes per call - `registered` (a real pool),
  `unregistered` (the locker answered with its all-zero row), and `unavailable`
  (the call did not answer at all). `decimals` and `metadataUri` carry the same
  distinction. A failed read is never reported as "not registered", and the tool
  says which of the three happened in words.
- **A tokenised-stock pair is LIVE.** A `pairedAsset: "stock"` row carries an
  extra `pairedStock: {address, symbol}` block (measured on an AAPL-paired
  token). The earlier probe recorded stock pairs as not yet existing; that has
  changed and the validator accepts them.
- **Every pool charges a 1 percent fee** (Sushi V3 tier 10000, tickSpacing 200).
  It shows up as roughly 100 bps of "price impact" on any quote before real
  slippage. The locker splits it: 20 percent creator, 25 percent community,
  30 percent protocol buyback, 25 percent platform (stock pairs: 20/80
  creator/protocol).
- **There is no bonding curve and no graduation.** `launch()` deploys the token,
  creates and initialises the Sushi V3 pool, mints the whole supply as one
  full-range position and locks the LP NFT forever. The token trades on a real
  DEX from its first block, so there is no stage to filter on - `maxAgeHours` is
  what "find the fresh ones" means here.
- **An empty market is a success**: HTTP 200 `{"results":[],"nextCursor":null}`.
  Never an error, and the handlers echo the active filters so a zero-row answer
  is attributable.
- **HTTP 502 is a not-found.** `{"error":"Upstream error resolving token pool"}`
  on the candles route means no pool is indexed for that address. Mapped to
  `POOLS_NOT_FOUND` with a remedy, not to a server fault.
- **HTTP 400 is the useful one.** `{"error":"Invalid parameters","details":
  [{code,message,path}]}` where `message` is the server's own zod text listing
  every accepted value. Surfaced to the agent as `path: message` pairs, but
  never raw: EVERY provider-origin string here (this `message`, its `path`, a
  top-level `error`, an HTML fragment) goes through `scrubProviderText`, the same
  pipeline the thrown-error lane uses - secret shapes redacted, URLs collapsed,
  auth fragments stripped, control characters flattened - and is then capped.
  The measured zod text survives that intact; a bearer token echoed into the
  same field would not.
- **HTTP 404 is an HTML page** (`Cannot GET /...`). The mapper extracts the
  `<pre>` line as a bounded route-drift signal instead of trying to parse it.
- **Candle order is NOT stable across tokens.** Both pools.fun tokens measured
  returned OLDEST-first; a token from the third launchpad returned newest-first.
  `pools.candles` derives the order from the timestamps and reports it rather
  than echoing a constant.
- **Candles arrive as arrays of arrays.** The validator lifts them into named
  members at the boundary - `open` and `close` are one slot apart and no value in
  the data would reveal a swap.

## Tolerant reader (rule 90)

Strict (a bad value throws): `tokenAddress`, `poolId`, `platform`,
`pairedAsset`, `deployedAt`, and every member of a candle. Display-tolerant
(missing/null becomes `null`): all prices, volumes, market cap, price changes,
trade count, `decimals`, `totalSupply`, names, symbols, images, socials, the X
handles, `lastTradeAt`, and the candle response's `pool`/`pair` blocks.

## Trading and research: not this module's job

pools.fun tokens trade in ordinary SushiSwap V3 pools from block one, and the
existing `kyberswap` venue already routes them - 13 of 13 sampled tokens quoted,
including ones launched minutes earlier, USDG-paired tokens routed multi-hop, and
old SushiLaunchpad tokens. **Quote and trade them with `kyberswap`.** Their pools
are indexed by DexScreener as `dexId: sushiswap`, label `v3`, chain slug
`robinhood`, so **research liquidity with `dexscreener`**. That is why the
`pools` namespace ships no swap tool.

## Verified provider reference (measured, NOT wired by this module)

Everything below was probed live and is recorded so the launch phase does not
have to rediscover it. None of it is called by P1 code.

### `GET /pools-fun/launches/config`

`{ "deploymentFeeWei": "263000000000000", "gatewayVersion": 1 }`.

**The fee is DYNAMIC.** It moved from 0.000263 ETH to 0.00105 ETH inside 24
hours, and the gateway contract bounds it to `[1e12, 1e16]` wei on-chain. Read it
immediately before a launch and pass it as `expectedDeploymentFeeWei`; a value
cached from a preview is how a launch reverts on `requiresReprepare`.

### `POST /pools-fun/launches/prepare` (no auth)

Required body: `{ tokenName, pairedAsset: "weth"|"usdg"|"stock",
expectedDeploymentFeeWei, expectedGatewayVersion, creatorAddress }`.

Verified OPTIONAL fields (frontend bundle extraction plus live probe):

| field | meaning |
|---|---|
| `tokenSymbol` | explicit symbol; derived from `tokenName` when omitted |
| `imageUrl` | **the image field that actually works** - the `{url}` from `launches/upload-image`, or any https URL. See the image-contract finding below |
| `tweetUrl` / `websiteUrl` | socials stamped on the row |
| `feeRecipient` | who earns the creator fee, as an OBJECT `{type, value}` - see the contract-change note below |
| `pairedStockAddress` | required when `pairedAsset` is `stock` |
| `devBuyEth` / `devBuyAmount` | the same-transaction prebuy |

Response: `{ requiresReprepare, to, data, value, predictedTokenAddress,
predictedPoolAddress, salt, metadataUri, devBuyMinOut, devBuyAmountIn,
deploymentFeeWei, nativeDevBuyWei, deadline, pairedAsset, tokenSymbol,
feeRecipient }` - complete `Gateway.launch(tuple)` calldata with a backend-mined
salt, a live start tick and a deadline of now + 1200 seconds baked in.
Stateless: nothing happens on-chain until the user signs.

Three of those fields are NOT the scalars an older reading of this document
assumed - see the contract-change note below. The bytes are committed at
`src/__tests__/pools-fun/fixtures/live-captures/launches-prepare-wallet-recipient.json`.

**`feeRecipient: 0x0` in the tuple means `msg.sender`** (gateway source, line
146). It is not an unset field and must not be "corrected" to an explicit
address without intending to.

#### The provider changed `feeRecipient`, `pairedAsset` and `value` under us (2026-08-19)

This endpoint's shape moved with no notice, no version bump and no changelog -
this API publishes no schema at all - and it took the entire launch path down.
Read this before trusting any older description of the prepare contract.

**1. `feeRecipient` in the REQUEST is now an object, and a string is a hard 400.**

```
HTTP 400  feeRecipient: Invalid input: expected object, received string
```

The accepted shape is `{ type, value }`, where the provider's own zod error
enumerates `type` as one of:

| `type` | `value` is | Vex sends it |
|---|---|---|
| `wallet` | an EVM address | yes - every agent launch, and a manual launch where the user typed an address |
| `x` | an X handle, no leading `@` | yes - a manual launch that named a handle |
| `farcaster` | a Farcaster identity | no |
| `ens` | an ENS name | no |

This was not a degraded path, it was a dead one: Vex always states the recipient
explicitly (owner decision 3), so there was no launch that avoided the 400. The
enumerated sweep that recovered the schema is
`agents_dm/pools-fun-live/fee-recipient-shape-probe.ts` with its artifact
alongside.

An unresolvable handle is a clean, diagnosable refusal rather than a silent
fallback - measured with `{type: "x", value: "vexdotfun"}`:

```
HTTP 400  {"error":"Could not resolve the x fee recipient. Check it and try again."}
```

Note the shape: a bare `error`, with none of the `details[]` array the
`/discover` rejections carry.

**2. `feeRecipient` in the RESPONSE is now an object too:**
`{ address, display }`, e.g. `{"address":"0x33eF…","display":"0x33eF…d2fA"}`.
`address` is financially consumed - it is what the verifier's point 4 holds the
signed tuple to, and on the X path it is the only statement of where the fee
stream goes - so it is validated strictly. `display` is a truncated UI label and
is display-tolerant. Comparing the tuple to `display` would never match.

**3. `pairedAsset` in the RESPONSE is now an object:**
`{ address, kind, symbol, decimals }` (the REQUEST still sends the bare string
name). Nothing consumes it - which asset a launch actually pairs against is
proven from the decoded tuple in the verifier's point 5 - so every field but the
address is display-tolerant. It is typed only so the validator stops throwing on
it.

**4. `value` is HEX** (`"0x3bc7def507320"`) while every sibling amount on the same
body is decimal (`deploymentFeeWei: "1051674002092832"` - the same number). The
validator normalises it to decimal at the boundary, so the split never reaches a
refusal message or a UI: a hex string sitting next to decimal wei figures is
exactly the misread that rule 90 forbids.

Defects 2, 3 and 4 were invisible until defect 1 was fixed, because no live body
had ever got past the 400. All four are pinned by
`src/__tests__/pools-fun/launch-prepare-contract.test.ts`.

#### The image contract: `imageUrl`, not `image` (probed 2026-08-18)

The field is **`imageUrl`**. Sending `image` is accepted with HTTP 200 and then
SILENTLY DROPPED: the pinned metadata simply has no image key, `discover.imageUri`
stays null, and the token renders blank on pools.fun. That is what happened to the
funded launch (VEXFLAM), and `image` is also what a frontend-bundle reading of the
prepare body suggests - so this is a trap that looks like the documented path.

Measured by iterating the free `prepare` endpoint over six request shapes with one
already-uploaded image URL. Only `imageUrl` landed:

| request shape | metadata image field |
|---|---|
| `image: "<url>"` | **absent** (the funded-launch failure) |
| `imageUrl: "<url>"` | **`image: "ipfs://<cid>"`** |
| `imageUri: "<url>"` | absent |
| `image: { url }` | absent |
| `metadata: { image }` | absent |
| `image` + explicit `tokenSymbol` | absent |

The backend rewrites the gateway URL into an `ipfs://` CID in the metadata's
`image` key, so the request spelling and the metadata spelling deliberately
differ. Full request/response record, including every attempted shape:
`agents_dm/pools-fun-live/artifacts/image-contract-probe.json`
(`image-contract-probe.ts` reruns it).

Note that `prepare` is free and touches no chain, but it is NOT side-effect free:
each call pins a persistent IPFS metadata object through the provider's account.
Keep any future variant sweep finite and enumerated.

### `POST /pools-fun/launches/upload-image` (no auth)

Note the path: it is under `/launches/`. The shorter `/pools-fun/upload-image`
is a 404 (measured), and this doc named it wrongly in its first draft.

The body MUST be `multipart/form-data` with the file under the field name
`file`; a JSON body is refused with HTTP 400
`{"error":"Send the image as multipart/form-data"}`. Returns `{ url }` pointing
at IPFS (Pinata). Rate limited to roughly one call per minute, which is a real
constraint on any retry loop.

The metadata JSON the launcher pins alongside it has the shape
`{ name, symbol, attributes: [launch_provider, chain], initial_deployer,
initial_fee_recipient, ... }` and is referenced as `ipfs://…`.

#### Image size: pools.fun has NO product limit of ours (owner decision 2026-08-19)

**Measured:** this endpoint accepted a **2,104,822-byte PNG** with HTTP 200 and a
byte-identical round trip. pools.fun hosts the image off-chain on its own
backend, so its size costs the user nothing and is not gas.

The 20,480-byte cap that used to bind every locker image was **ours, and it was
Trench's**: Trench writes the image bytes inline in `create()` calldata, where
every byte is gas on an irreversible transaction. Applying it here meant every
pools.fun launch silently published a downscaled, square-cropped picture. Since
migration 083 the locker stores the **original bytes verbatim** and derives a
separate Trench-only copy; `resolveLaunchImageBytes` (the seam this lane uses)
returns the original, unchanged.

One ceiling remains and it is **a resource bound, not a product limit**:
**26,214,400 bytes (25 MiB)**, enforced in three places that must stay in
agreement -
`vex-app/src/main/images/downscale.ts` (`DOWNSCALE_MAX_SOURCE_BYTES`, refused
from `stat` before a byte is read), `LOCKER_IMAGE_MAX_SOURCE_BYTES` in the
shared schema, and the `launch_images.byte_length` CHECK in migration 083. It
exists so a multi-gigabyte file picked in the dialog cannot exhaust memory. If
a user needs a larger image on pools.fun, the honest answer is the `imageUrl`
paste path below, not a wider read ceiling.

An image the Trench ladder could not shrink is stored with `onchain_byte_length
IS NULL`, is badged "pools only" in the locker card, and launches here normally.

#### Three ways an image reaches a pools.fun launch

| source | what happens |
|---|---|
| `imageId` (locker) | the ORIGINAL stored bytes are uploaded here, content type sniffed from the bytes |
| `imageUrl` (manual launch form) | pasted https URL, used as-is - no upload, no size ceiling of ours at all |
| no image | permitted by the provider; the metadata simply carries none |

### `POST /pools-fun/launches/dev-buy-quote` (no auth)

Body `{ "devBuyEth": "0.01" }` (decimal ETH string). Returns
`{ devBuyAmountIn, devBuyAmountOut, totalSupply }`, assuming a fresh pool at the
initial FDV.

### `POST /pools-fun/swap/quote` (no auth)

Body `{ tokenAddress, side: "buy"|"sell", amountIn (wei string), recipient }`.
Returns `{ amountOut, minAmountOut (2% default slippage), priceImpactBps,
tx: { to: RouteProcessor, data } }` - ready-to-sign calldata, no quote id and no
expiry. Vex does not use it: `kyberswap` is the venue, and the sell direction
here is unprobed.

### `GET /pools-fun/paired-prices`

`{ "weth": 1899.21, "usdg": 1 }`; optional `?stockAddress=0x…`. USD marks for the
paired assets.

### `GET /pools-fun/official-token`

`{ "phase": "prelaunch", "revision": 1 }` - the protocol token's status.

### WebSocket

`wss://api.bankr.bot/pools-fun`, socket.io (EIO=4, polling handshake confirmed).
Events: `TOKEN_LAUNCH` (a discover row, or an array of them) and
`DISCOVER_PRICE_UPDATE` (a partial row: market cap and volume). Frontend
reconnect policy is 2s rising to 10s.

### Authed-only (Privy session - NOT usable for self-custodial Vex)

`/user`, `/user/bootstrap`, `/user/orders`, `/user/automation`, `/user/mfa/*`,
`/user/accept-terms`, `/wallet/portfolio`, `/wallet/transfer`, `/pools-fun/swap`,
`/pools-fun/swap/prepare`, `/pools-fun/swap/execute`, `/pools-fun/launches`,
`/pools-fun/claim`, `/pools-fun/fee-recipient[/prepare]`.

Note that `/token/…`, `/launch`, `/pool-party`, `/leaderboard` and `/search` are
SPA routes, not API endpoints - calling them on `api.bankr.bot` is what produces
the HTML 404 the error mapper handles.

## The VEX badge: `POST /pools-fun/vex/attestations` (live, measured 2026-08-24)

The endpoint pools.fun implemented from `attribution-server-spec.md` (in this
folder) is LIVE at the proposed path, confirmed by the partner in writing and
probe-verified against the spec on 2026-08-24. The contract there is an
external commercial commitment: the request body, the signed message bytes
(`VEX-attest:v1:pools.fun:4663:<lowercase token>`), the closed error
vocabulary and the idempotency and backfill requirements are FROZEN; a change
to the bytes is a new version, never a mutation.

Measured conformance (six probes, garbage signatures only - no real
attestation can be sent outside a launch window):

| Probe | Answer | Spec verdict |
|---|---|---|
| empty body `{}` | 400 `validation_failed` | conforms |
| malformed address | 400 `validation_failed` | conforms |
| unrecoverable signature (bad `v`) | 400 `validation_failed` | conforms (cannot-recover = malformed) |
| real indexed token + recoverable garbage signature | 401 `invalid_signature`, "recovered signer is not this launch's gateway launcher" | conforms - recovery and launcher compare are real |
| UNKNOWN token address | 404 `launch_not_ready` | conforms - the critical retryable semantic; an unindexed launch is NOT `not_pools_launch` |
| `chainId: 1` | 400 `chain_unsupported` | conforms |

Every response carried the flat `code` field, `success: false`, and a
human-readable `message` the Vex client ignores by design. No redirects.

The one thing the spec exists to prevent held in practice: identity binds
through `GatewayLaunch.launcher` (the 401 message names it), never
`TokenLaunched.creator` - on the GATEWAY path `creator` and `.deployer` are
the gateway contract, exactly as decoded in
`src/vex-agent/sync/pools-settlement-decoder.ts`.

Client state: `services.poolsFunAttestApiUrl` defaults to the live host;
signing remains behind the strict-boolean `poolsFunAttestationEnabled` flag
(the lane's kill switch - see `src/config/store.ts` for its current default
and parse rules).

The SUCCESS path is now measured too (first badged launch, 2026-08-24):
"Desu Vex" `0x07aD15f1eBe1C112a0854c40fd6E5ce8BD4F796c`, launched through the
gateway in tx
`0x4a76405e80228cdd41c13211aa1108a742b99dbf97f5714e125deb804b85b513`, was
attested in-process seconds after the confirm - one POST, HTTP 2xx with
`success: true`, `pools_attributed_at` stamped, no retry needed. The provider
then surfaced a NEW `/discover` row field for it: `vexAttested: true`
(boolean, absent-or-false on unbadged rows). That field is not yet projected
by `pools.tokens`/`pools.search` - it appeared with the first badge and
surfacing it in the discover row shape is a named follow-up, not an accident.

## Money-path conditions (verbatim force - change any of these by owner decision only)

These are the conditions the launch and claim paths were built under. They are
recorded here because each one is a decision, not an implementation detail: a
future reader who "fixes" one of them silently changes what the user is charged
or what the agent may do unattended.

- **The Vex fee basis is `launch_msg_value` - the NATIVE value only.** A launch's
  fee is 25 bps of the ETH it sends (the gateway's deployment fee plus any ETH
  prebuy). A **USDG prebuy is an ERC-20 leg and is therefore NOT in that basis
  and NOT charged**. That exclusion is deliberate and matches the Trench
  precedent (`trench/handlers/launch/plan.ts`); widening the basis to cover an
  ERC-20 leg needs a separate owner decision, not a code change.
- **Automatic reprepare happens ONLY while no authorization exists.** A prepare
  pins a persistent IPFS object and mines a NEW salt, which changes the metadata
  URI, the salt, and therefore the token's address. Once a C0 authorization
  exists over a calldata+value fingerprint, any change VOIDS it and re-asks;
  re-preparing after that point would broadcast something other than what was
  approved.
- **Exact USDG approvals, when the ERC-20 prebuy path ships, target ONLY the
  gateway**, in the exact amount, and a residual allowance left by a DEFINITIVE
  launch failure is surfaced and reset - never silently ignored. (No approval leg
  ships today; see the omissions below.)
- **Autonomous prebuy is WETH-native only.** The gateway itself refuses a native
  dev buy against any other pair (`NativeDevBuyRequiresWeth`, verified source
  line 140), and the verifier refuses it before signing rather than discovering
  it as a revert.
- **The creator fee recipient is pinned to the session wallet on every AGENT
  launch**, and the agent-facing tools have no recipient parameter at all. Only
  the manual form may name someone else; an address there is held to exact
  equality by the verifier, and an X handle is resolved by the launchpad, shown
  to the user, and bound into the very bytes they confirm (the fingerprint covers
  `to`, `data` and `value`, and the tuple inside `data` names the recipient).
  Vex never claims to have verified a handle-to-address mapping - only the
  launchpad can know it - and it never silently substitutes the session wallet
  for a handle.
- **`devBuyMinOut` is the EXACT simulated fill**, never a percentage band: the
  first swap in a fresh pool is deterministic, and a tolerance that scaled with
  size is exactly what rule 90 forbids on a money comparison.
- **The claim's `claimable*` mappings are ALREADY-COLLECTED balances.** They are
  never presented as a claimable total. The `eth_call` simulation of
  `collectAndClaim` from the claiming wallet is the only honest preview, measured
  live at 0/0 mappings against a 0/599999999999 simulation.

### Named omissions (deliberate, not oversights)

- **A USDG (ERC-20) prebuy is manual-form only and not implemented today.** It
  needs an approval leg, and an approval leg on an autonomous path is a second
  signature with its own failure modes. The agent path offers an ETH prebuy only.
- **Tokenised stocks are not launchable.** `allowedPairedAsset(AAPL)` is false on
  PartyFactory; the AAPL-paired rows in `/discover` belong to the OLDER sushi
  launcher. WETH and USDG only, and the database CHECK enforces it.
- **The claim has no mission-autonomy ceiling.** It ships as an ordinary
  approval-gated mutating tool (owner directive 2026-08-19): no per-mission claim
  count, no in-flight tracking, no contract-hash material. A claim is bounded by
  the same approval every other mutating tool is bounded by.
- **`launched_tokens` is written by the launch path only.** A pools.fun token
  launched outside Vex will not appear there; `pools.my_launches` reads the
  launchpad's own deployer index instead, which does include it.

## Deferred (NOT in P1)

- ~~The launch family~~ - **SHIPPED** via the GATEWAY path.
  `POST /pools-fun/launches/prepare` mines the salt and returns
  `Gateway.launch(tuple)` calldata, `launch/verify-calldata.ts` proves 13 things
  about it against the chain, and only then is it authorized and signed. The
  gateway costs `deploymentFeeWei`, which a direct `PartyFactory.launch()` from
  the EOA would not - the trade is deliberate, and the dynamic fee is why the
  config read is fresh at execute time.
  On-chain `creator` for a gateway launch is the GATEWAY (the real launcher is
  in `launcherOf` and in `GatewayLaunch.launcher`), which the settlement decoder
  accounts for: it requires ONE `GatewayLaunch` from the pinned gateway AND ONE
  `TokenLaunched` from the pinned factory, cross-checked against the AUTHORIZED
  plan. This does NOT affect `pools.my_launches`: bankr's own indexer credits the
  launching wallet, measured against a real gateway-launched token
  (`discover-deployer-gateway-launch.json`).
- **The helper endpoints above.** Documented, not wired.
- **The WebSocket live feed.** REST covers the same ground via
  `sortBy=deployedAt` plus `live`; add it only when a latency need is proven.
- **No throttle module.** No documented rate limit on the read endpoints and a
  5-second server cache. The 1-per-minute limit on `upload-image` belongs to the
  launch phase that calls it.

## Fixtures

`src/__tests__/pools-fun/fixtures/live-captures/` holds real captured bytes under
a `{endpoint, capturedAt, response}` envelope; the validators, the client and the
error mapper are all tested against them. See that folder's `README.md` for the
naming law, the sanitization reasoning, and what each capture pins.
