# Khalani Module Map — Cross-Chain Bridge via HyperStream API

This document maps every `.ts` file in `src/tools/khalani/` and `src/commands/khalani/` to the data it provides for cross-chain bridging, quoting, token discovery, and order tracking.

**Last updated: 2026-08-28**

**LLM maintainers:** If you modify any file in this folder, update this document to reflect the change — add/remove endpoints, update types, fix stale references.

**Docs:** https://khalani.gitbook.io/khalani-docs
**Base URL**: `https://api.hyperstream.dev` (configured via `config.services.khalaniApiUrl`)
**Auth**: None required (open API, rate-limited)

---

## What Khalani Does

Khalani is a multi-chain intent-based bridge protocol. Users publish cross-chain intents; solvers compete to fill them. The integration flow is:

```
1. Quote    → POST /v1/quotes         → quoteId + routes[]
2. Build    → POST /v1/deposit/build   → approvals[] (wallet actions)
3. Execute  → sign & broadcast each approval in order
4. Submit   → PUT /v1/deposit/submit   → orderId
5. Track    → GET /v1/orders/{address} → order lifecycle until terminal
```

Supports both **EVM chains** (Ethereum, Arbitrum, Base, etc.) and **Solana**.

---

## File Map

### Core (`src/tools/khalani/`)

| File | Role |
|------|------|
| `client.ts` | `KhalaniClient` class — typed HTTP methods for all API endpoints, NDJSON streaming, singleton via `getKhalaniClient()` |
| `types.ts` | All TypeScript interfaces: `QuoteRequest`, `QuoteRoute`, `DepositPlan`, `KhalaniOrder`, `KhalaniChain`, `KhalaniToken`, etc. |
| `validation.ts` | Runtime validators for every API response shape — `unknown` → typed. Parses chains, tokens, orders, quotes, deposit plans, error bodies |
| `errors.ts` | `mapKhalaniError(status, body)` — maps HTTP status + exception name to typed `VexError` with retryable flag |
| `chains.ts` | Chain alias map (40+ entries), chain cache (24h TTL), `resolveChainId()`, `getChain()`, `getChainFamily()`, `getChainRpcUrl()` |
| `evm-client.ts` | Dynamic viem wallet/public client creation from Khalani chain metadata + private key |
| `solana-signer.ts` | `signSolanaTransaction()` and `signAndSendSolanaTransaction()` for Solana deposit execution |
| `bridge-executor.ts` | PUBLIC ENTRY POINT for deposit-plan planning + staged per-leg signing. Re-export surface only; the implementation is the folder below |
| `bridge-executor/staged-leg.ts` | The leg model: roles, purposes, staged outcomes, stage handles/hooks, and `khalaniLegNativeValueCall` |
| `bridge-executor/approval-normalization.ts` | Pure parsing + fail-closed validation of Khalani's untrusted `approvals` wire shape |
| `bridge-executor/deposit-plan.ts` | Network-free planning: `planKhalaniDepositLegs` — ordered legs, Vex fee leg appended last |
| `bridge-executor/leg-signing.ts` | `signStageKhalaniLeg` — the only module holding signing keys: sign → stage → broadcast → bounded receipt |

### Commands (`src/commands/khalani/`)

| File | Role |
|------|------|
| `index.ts` | Commander registration: `khalani` parent command with subcommands |
| `chains.ts` | `khalani chains` — list supported chains with icon URLs |
| `tokens.ts` | `khalani tokens top/search/autocomplete/balances` — token discovery and wallet balances |
| `quote.ts` | `khalani quote` — fetch cross-chain quotes (regular + streaming NDJSON) |
| `bridge.ts` | `khalani bridge` — full flow: quote → build → execute → submit (with `--dry-run` and `--yes`) |
| `bridge-executor.ts` | Deposit plan execution: EVM CONTRACT_CALL, Solana CONTRACT_CALL, EVM TRANSFER |
| `orders.ts` | `khalani orders` / `khalani order <id>` — list and inspect orders |
| `request.ts` | Shared quote request builder: chain resolution, address normalization, amount parsing |
| `helpers.ts` | UI helpers: address normalization, chain family formatting, best route selection |

---

## API Endpoints

### Quoting

| Function | Endpoint | Returns |
|----------|----------|---------|
| `client.getQuotes(request, opts?)` | `POST /v1/quotes` | `{ quoteId, routes[] }` — each route has amountOut, ETA, tags, depositMethods |
| `client.streamQuotes(request, opts?)` | `POST /v1/quotes?mode=stream` | `AsyncGenerator<QuoteStreamRoute>` — NDJSON lines as they arrive from fillers |

**Query params**: `mode=stream`, `routes=Hyperstream,Across` (comma-separated route filter)
**Body field**: `filler` restricts to a specific filler provider

### Deposit

| Function | Endpoint | Returns |
|----------|----------|---------|
| `client.buildDeposit(request)` | `POST /v1/deposit/build` | `DepositPlan` — one of 3 kinds (see below) |
| `client.submitDeposit(request)` | `PUT /v1/deposit/submit` | `{ orderId, txHash }` |

**Submit modes**:
- Frontend broadcast: send `txHash` (you broadcast the tx yourself)
- Backend broadcast: send `signedTransaction` (API broadcasts for you)

### Orders

| Function | Endpoint | Returns |
|----------|----------|---------|
| `client.getOrders(address, opts?)` | `GET /v1/orders/{address}` | `{ data: KhalaniOrder[], cursor? }` — paginated |
| `client.getOrderById(orderId)` | `GET /v1/orders/by-id/{orderId}` | Single `KhalaniOrder` |

**Query params**: `limit`, `cursor`, `fromChainId`, `toChainId`, `orderIds` (comma-separated), `txHashSearch`

### Token Discovery

| Function | Endpoint | Returns |
|----------|----------|---------|
| `client.getTopTokens(chainIds?)` | `GET /v1/tokens` | `KhalaniToken[]` — flat array of top tokens |
| `client.searchTokens(query, chainIds?)` | `GET /v1/tokens/search` | `{ data: KhalaniToken[] }` — search by name/symbol/address |
| `client.autocompleteToken(keyword, opts?)` | `GET /v1/tokens/autocomplete/{keyword}` | `{ data[], parsed, nextSlots }` — semantic NLU autocomplete |
| `client.getTokenBalances(address, chainIds?)` | `GET /v1/tokens/balances/{address}` | `{ tokens: KhalaniToken[]; rejectedEntries: KhalaniRejectedTokenBalanceEntry[] }` - tokens carry `extensions.balance` and `extensions.price.usd` |

### The wallet-balances boundary is STRICT per entry (2026-08-31)

`/v1/tokens/balances/{address}` is the ONE Khalani surface an attacker can write
to: anyone can mint a token and airdrop it into a wallet, so every field of an
entry there is attacker-controlled input arriving at scale. The other token
surfaces (`/v1/tokens`, search, autocomplete) are provider-curated.

Both validators apply the SAME strict `decimals` rule
(`Number.isInteger(d) && 0 <= d <= 36`). What differs is what a violation
COSTS, and that difference is the deliberate one:

| Surface | Validator | `decimals` rule | A bad entry costs |
|---------|-----------|-----------------|-------------------|
| `/v1/tokens`, search, autocomplete | `validateTokensResponse` / `parseToken` | strict `asTokenDecimals` (same rule) | the WHOLE call throws - a curated list nobody outside Khalani can add to should fail loudly, and the request fails rather than handing the agent a scale nothing can convert from |
| `/v1/tokens/balances/{address}` | `validateTokenBalancesResponse` | strict `asTokenDecimals`: `Number.isInteger(d) && 0 <= d <= 36` | that ONE entry, reported in `rejectedEntries` |

Contract of `validateTokenBalancesResponse`:

- every token in `tokens` has a usable scale, so `formatUnits` (which THROWS on
  a fractional scale) is total on them;
- an entry whose ONLY defect is `decimals` becomes a
  `KhalaniRejectedTokenBalanceEntry`: `entryIndex`, `chainId`, `address`,
  `name`, `symbol`, `balanceRaw`, `reason: "token_decimals_invalid"`. Nothing is
  dropped silently (output-envelope spec, section 4);
- the invalid `decimals` value is NEVER echoed and NEVER guessed. No consumer
  may substitute 18 (frozen contract C1.2; `decimals || 18` is the Rabby
  anti-pattern this refuses);
- `balanceRaw` is the provider's amount only when it is an EXACT unsigned
  decimal integer string. A float, a hex string or an absent value yields
  `null`, because a size we cannot state exactly is unknown, not zero (C1.3);
- an entry with ANY other defect (identity, structure, a non-object entry, a
  non-array document) still throws, which the scan records as a CHAIN failure.

Consequence for the CURATED surfaces, decided 2026-09-01 (review finding 9): a
curated row with unusable `decimals` now fails the REQUEST rather than reaching
`khalani.tokens.top`, `khalani.tokens.search`, `khalani.tokens.autocomplete` or
their consumers (`TokenFind`, the bridge USD estimator, the Khalani read
handlers). That is the intended contract. Nobody outside Khalani can add an
entry to those lists, so a malformed one is a provider defect, and a loud
failure the agent can report beats a row whose scale no consumer can use.
Per-entry `rejectedEntries` recovery exists ONLY on the wallet-balances array,
which is the only reachable-by-airdrop surface.

`getTokenBalancesAcrossChains` carries the refusals through as
`TokenBalanceScanResult.rejectedEntries` (per-chain attribution comes from
`entry.chainId`). The field is typed optional so a caller may construct an empty
placeholder scan result; the scanner ALWAYS populates it. Read it as
`rejectedEntries ?? []`.

Consequences for the sync path
(`vex-agent/sync/balance-sync/rejected-entry-salvage.ts`):

- a refusal WITH an exact `balanceRaw` is retained as a `BalanceRow` with
  `decimals: null` and `balanceUsd: null` - the INVENTORY stays complete, the
  VALUATION of that row is honestly unknown;
- a refusal WITHOUT an exact `balanceRaw` means that chain's inventory cannot be
  reconstructed, so its destructive `replaceBalancesForChain` is skipped for the
  cycle and the last-good rows keep their timestamps (C3.5). Other chains in the
  same scan are written normally.

Scan output is also deterministic: rows are sorted by held USD descending, then
chain id, then lowercased address, then the raw address, symbol, name, decimals
and raw balance. Rows arrive in RPC completion order under concurrency, so held
USD alone (all-zero on an unpriced wallet) left the model's view of a wallet -
and the float `totalUsd` sum - varying between two identical reads.

### Balance source: SPLIT by family (2026-08-28)

Khalani is NOT the balance source for Solana anywhere in Vex.

| Lane | eip155 balances | solana balances |
|------|-----------------|-----------------|
| `WalletBalances` (internal) | Khalani scan, plus local-only EVM chains direct from RPC | direct Solana RPC via `tools/solana-ecosystem/balances/wallet-snapshot.ts` |
| `khalani__token_balances_get` (`khalani.tokens.balances`) | Khalani scan | the same shared Solana snapshot service |
| Balance sync (`vex-agent/sync/solana-balance-sync.ts`) | n/a | the same shared Solana snapshot service |
| `tools/solana-ecosystem/balances/read-wallet-balances.ts` | n/a | Khalani used as a PRICE map only, never a balance source |

WHY: `client.getTokenBalances` answers `scannedChainIds = [20011000000]` with
ZERO tokens for Solana. Every lane that trusted it reported `$0` for a funded
wallet while the Portfolio sidebar showed the true balance (owner screenshot,
2026-08-28). Khalani legitimately remains the ENUMERATOR for its EVM chains,
which have no per-chain RPC reader of their own.

Consequences for maintainers of this folder:

- the three Solana shaping rules (native SOL under the wSOL mint, zero balances
  skipped, a wSOL token account folded into the native row) live ONCE, in
  `tools/solana-ecosystem/balances/wallet-snapshot.ts`. Do not re-derive them;
- Solana rows carry NULLABLE `symbol`/`name`. `ConciseKhalaniToken` is
  deliberately not widened, and a mint address is never used as a label;
- a Solana token ACCOUNT that fails validation is reported in `accountErrors`
  ({chainId, accountAddress, reason}), never in `tokenErrors`, whose address
  field means a MINT.

**Autocomplete understands**: `"100 usdc on ethereum"` — parses amount, token, chain. `nextSlots` tells UI what input to prompt next.

### Chains

| Function | Endpoint | Returns |
|----------|----------|---------|
| `client.getChains()` | `GET /v1/chains` | `KhalaniChain[]` — id, name, type, nativeCurrency, rpcUrls, blockExplorers |
| `client.getChainIconUrl(chainId)` | (builds URL) `GET /v1/chain/{chainId}/icon` | URL string — returns PNG/SVG image. Never 404s (returns placeholder) |

**Caching**: `getCachedKhalaniChains()` caches chain list for 24 hours in memory.

---

## Deposit Plan Kinds

The `POST /v1/deposit/build` response has 3 possible shapes based on `kind`:

### CONTRACT_CALL (default, most common)

Execute `approvals[]` array **in order**. Each approval is either:
- `eip1193_request` (EVM): contains `request.method` + `request.params`
  - `wallet_switchEthereumChain` — chain switch (no tx hash)
  - `eth_sendTransaction` — approval or deposit tx
- `solana_sendTransaction` (Solana): contains `transaction` (base64-encoded)

Capture the tx hash/signature from the approval where `deposit: true`. Submit it.

### PERMIT2

EIP-712 typed data for gasless approval. Contains `permit` (sign with `eth_signTypedData_v4`) and `transferDetails`.
**Status in v1**: Parsing supported, execution intentionally blocked. Use `--dry-run` to inspect or `--deposit-method CONTRACT_CALL`.

### TRANSFER

Direct token transfer to a deposit address. Contains `depositAddress`, `amount`, `token`, `chainId`, `memo?`, `expiresAt?`.
**Status in v1**: EVM implemented (native + ERC20). Solana TRANSFER not implemented.

---

## Order Lifecycle

```
created → deposited → published → filled (terminal, success)
                                → refund_pending → refunded (terminal)
                                → failed (terminal)
```

| Status | Terminal | Description |
|--------|----------|-------------|
| `created` | No | Order created, deposit not yet confirmed |
| `deposited` | No | Deposit confirmed on source chain |
| `published` | No | Intent published to fillers/solvers |
| `filled` | Yes | Delivered on destination chain |
| `refund_pending` | No | Intent expired, waiting for Hyperlane refund |
| `refunded` | Yes | Funds returned to sender |
| `failed` | Yes | Order failed |

**`stepsCompleted`**: Cumulative for progress states (`["created", "deposited", "published", "filled"]`). For terminal failures (`refunded`, `failed`), shows only `["created"]` regardless of actual progress.

**`transactions`**: Object keyed by kind (`deposit`, `fill`, `refund`) with `{ timestamp, txHash, chainId, amount? }`.

**`timestamps`**: Object with lifecycle event timestamps (`{ createdAt, publishedAt, ... }`). Separate from top-level `createdAt`/`updatedAt`.

**`providerStatus`**: Filler-specific status info (`{ provider, nativeStatus, substatus?, metadata? }`). Example: `{ provider: "across", nativeStatus: "filled", substatus: "completed" }`.

---

## Chain Support

### Chain Families

| Type | Description | Address format | Tx hash format |
|------|-------------|----------------|----------------|
| `eip155` | EVM chains (Ethereum, L2s) | `0x` + 40 hex chars | `0x` + 64 hex chars |
| `solana` | Solana | Base58, 32-44 chars | Base58, 87-88 chars |

### Chain Aliases (from `chains.ts`)

Users can pass aliases instead of numeric chain IDs:

| Alias | Chain ID | Alias | Chain ID | Alias | Chain ID |
|-------|----------|-------|----------|-------|----------|
| `eth`/`ethereum` | 1 | `arb`/`arbitrum` | 42161 | `base` | 8453 |
| `op`/`optimism` | 10 | `sol`/`solana` | 20011000000 | `poly`/`polygon` | 137 |
| `bsc`/`bnb` | 56 | `avax`/`avalanche` | 43114 | `scroll` | 534352 |
| `linea` | 59144 | `zksync` | 324 | `mantle` | 5000 |
| `monad` | 143 | `blast` | 81457 | `mode` | 34443 |
| `unichain` | 130 | `sonic` | 146 | `bera`/`berachain` | 80094 |
| `abstract` | 2741 | `ink` | 57073 | `lens` | 232 |
| `sei` | 1329 | `story` | 1514 | `world`/`worldchain` | 480 |
| `lisk` | 1135 | `bob` | 60808 | `zora` | 7777777 |
| `tron` | 728126428 | `flow` | 747 | `hyperevm` | 999 |
| `injective` | 2525 | `neon` | 245022934 | `zilliqa` | 32769 |
| `soneium` | 1868 | `redstone` | 690 | `sophon` | 50104 |
| `jovay` | 5734951 | `katana` | 747474 | `plasma` | 9745 |

Numeric chain IDs always work. Fuzzy matching against the live chain list (`slugify(chain.name)`) is also supported.

---

## Value Formats

### Amounts

All token amounts in the API are **strings in smallest units** (no decimals).

| Token | Decimals | Human Amount | API Amount |
|-------|----------|-------------|------------|
| USDC | 6 | 100.00 | `"100000000"` |
| ETH | 18 | 1.5 | `"1500000000000000000"` |
| WBTC | 8 | 0.5 | `"50000000"` |
| SOL | 9 | 1.0 | `"1000000000"` |

**Hex format**: The API accepts `0x` prefix (`"0xF4240"` = `"1000000"`). The CLI also accepts hex via `parseAmountInSmallestUnits()` which converts to decimal before sending.

### Quote Fields

| Field | Format | Notes |
|-------|--------|-------|
| `quote.amountIn` / `amountOut` | String, smallest units | Use token decimals for display |
| `quote.expectedDurationSeconds` | Integer, seconds | Expected fill time |
| `quote.validBefore` | Unix timestamp, seconds | On-chain deadline — tx reverts after this |
| `quote.quoteExpiresAt` | Unix timestamp, seconds | Price quote expiry — re-quote after this |
| `quote.estimatedGas` | String, wei | Gas estimate (optional) |
| `referrerFeeBps` | Integer, 0-9999 | Basis points (100 = 1%). **Vex never sends this.** See below. |

### Referral fee — deliberately unused

Khalani's `POST /v1/quotes` accepts `referrer` + `referrerFeeBps`. Verified live
(2026-07-25, ETH→ARB USDC, Hyperstream native-filler route): the fee is a
**surcharge deducted from the user's output**, not a share of a fee Khalani
already takes — 1,000,000 in returns 999,800 out with no fee, and 989,802 with
`referrerFeeBps=100`. The schema accepts up to 9999 (99.99%), the `referrer`
address needs no registration (only an EIP-55 checksum), and the quote response
carries **no fee breakdown field**, so the skim is invisible inside `amountOut`.
It is also route-dependent: aggregated routes such as Across ignore it entirely.

Vex charges no bridge referral fee. Both fields are absent from
`QuoteRequestInput` and from the outbound `QuoteRequest`, and any caller-supplied
value is rejected by name — a fee must never come from model/tool input. See the
policy block in `request.ts` and the same doctrine in
`src/tools/kyberswap/constants.ts`.

### Order Fields

| Field | Format | Notes |
|-------|--------|-------|
| `srcAmount` / `destAmount` | String, smallest units | Source and destination amounts |
| `createdAt` / `updatedAt` | ISO 8601 string | `"2024-01-24T12:00:00Z"` |
| `transactions.*.amount` | String, smallest units | Fill amount (optional, present on fills) |
| `transactions.*.timestamp` | ISO 8601 string | When the tx was seen |

### Token Extensions (from discovery endpoints)

| Field | Type | Notes |
|-------|------|-------|
| `extensions.balance` | String, smallest units | From `/v1/tokens/balances`. Exact unsigned decimal integer; anything else is treated as an ABSENT amount on the balances boundary |
| `extensions.price.usd` | String, USD | `"1.00"` |
| `extensions.isRiskToken` | Boolean | Risk flag |
| `extensions.marketCap` | String | Market cap |
| `extensions.volume` | String | Trading volume |
| `extensions.bridgeInfo` | Object | Cross-chain token address mapping keyed by chain ID |

---

## Error Handling

### Error Response Shape

```json
{
  "message": "Quote not found or expired",
  "name": "QuoteNotFoundException",
  "details": { "quoteId": "..." }
}
```

Parsed by `parseKhalaniErrorBody()` in `validation.ts`, then mapped by `mapKhalaniError()` in `errors.ts`.

### Exception Mapping

| API Exception Name | Error Code | Retryable | Hint |
|--------------------|------------|-----------|------|
| `ValidationException` | `KHALANI_VALIDATION_ERROR` | No | Fix request parameters |
| `BadRequestException` | `KHALANI_VALIDATION_ERROR` | No | Check chain/tx format, quote freshness |
| `CannotFillException` | `KHALANI_CANNOT_FILL` | No | Try another route, token, chain, amount |
| `QuoteNotFoundException` | `KHALANI_QUOTE_EXPIRED` or `_NOT_FOUND` | Yes | Re-request a quote |
| `NotSupportedTokenException` | `KHALANI_UNSUPPORTED_TOKEN` | No | Search supported tokens first |
| `NotSupportedChainException` | `KHALANI_UNSUPPORTED_CHAIN` | No | Check chain list |
| `BroadcastException` | `KHALANI_BROADCAST_FAILED` | No | Check balances, nonce, blockhash |
| `DuplicateRecordException` | `KHALANI_API_ERROR` | No | Already registered — fetch order |
| `UnexpectedFromAddressException` | `KHALANI_ADDRESS_MISMATCH` | No | Address format vs chain family mismatch |
| `NotSupportedContractException` | `KHALANI_API_ERROR` | No | Choose another route |
| `BuildDepositParsingException` | `KHALANI_API_ERROR` | No | Re-quote and retry |
| `NotSupportedAssetReverseContractException` | `KHALANI_UNSUPPORTED_CHAIN` | No | Choose another route |
| `IntentNotFoundException` | `KHALANI_QUOTE_NOT_FOUND` | No | Re-quote and re-initiate |
| `NotSupportedDepositMethodException` | `KHALANI_UNSUPPORTED_DEPOSIT_METHOD` | No | Use different `--deposit-method` |
| `InternalErrorException` | `KHALANI_API_ERROR` | Yes | Retry with backoff |
| HTTP 429 | `KHALANI_RATE_LIMITED` | Yes | Rate limit — retry with backoff |
| HTTP 5xx (default) | `KHALANI_API_ERROR` | Yes | Server error — retry with backoff |

### All Khalani Error Codes (from `errors.ts`)

```
KHALANI_API_ERROR              KHALANI_TIMEOUT
KHALANI_RATE_LIMITED           KHALANI_QUOTE_NOT_FOUND
KHALANI_QUOTE_EXPIRED          KHALANI_VALIDATION_ERROR
KHALANI_CANNOT_FILL            KHALANI_UNSUPPORTED_TOKEN
KHALANI_UNSUPPORTED_CHAIN      KHALANI_DEPOSIT_FAILED
KHALANI_BROADCAST_FAILED       KHALANI_PERMIT2_BLOCKED
KHALANI_ORDER_NOT_FOUND        KHALANI_SOLANA_SIGN_FAILED
KHALANI_SOLANA_KEYSTORE_NOT_FOUND  KHALANI_ADDRESS_MISMATCH
KHALANI_UNSUPPORTED_DEPOSIT_METHOD
```

---

## Execution Flow (`bridge-executor.ts`)

### EVM CONTRACT_CALL

```
1. requireEvmWallet() → { privateKey, address }
2. For each approval in plan.approvals:
   a. wallet_switchEthereumChain → validate chain ID matches, skip (no tx)
   b. eth_sendTransaction → createDynamicWalletClient(), sendTransaction()
      - Parses all tx params: to, data, value, gas, gasPrice, maxFeePerGas, maxPriorityFeePerGas, nonce
      - Validates from address matches configured wallet
   c. If waitForReceipt=true → publicClient.waitForTransactionReceipt()
   d. If deposit=true → capture txHash
3. client.submitDeposit({ quoteId, routeId, txHash }) → orderId
```

### Solana CONTRACT_CALL

```
1. requireSolanaWallet() → { secretKey }
2. getChainRpcUrl(chainId, chains) → Solana RPC URL
3. For each approval in plan.approvals:
   a. Decode base64 → VersionedTransaction.deserialize()
   b. Sign with Keypair.fromSecretKey()
   c. connection.sendRawTransaction() → confirmTransaction("confirmed")
   d. If deposit=true → capture signature
4. client.submitDeposit({ quoteId, routeId, txHash: signature }) → orderId
```

### EVM TRANSFER

```
1. requireEvmWallet()
2. If token is native (0x000...000 or 0xeee...eee):
   → walletClient.sendTransaction({ to: depositAddress, value: amount })
3. Else (ERC20):
   → walletClient.writeContract({ abi: ERC20_ABI, functionName: "transfer",
       args: [depositAddress, amount] })
4. Wait for receipt
5. client.submitDeposit({ quoteId, routeId, txHash }) → orderId
```

### PERMIT2 (blocked in v1)

Throws `KHALANI_PERMIT2_BLOCKED`. User must use `--dry-run` to inspect the permit payload or switch to `--deposit-method CONTRACT_CALL`.

### Solana TRANSFER (blocked in v1)

Throws `KHALANI_DEPOSIT_FAILED` with hint to use `--deposit-method CONTRACT_CALL`.

---

## CLI Commands

```
khalani chains [--refresh]
khalani tokens top [--chain-ids <ids>]
khalani tokens search <query> [--chain-ids <ids>]
khalani tokens autocomplete <keyword> [--chain-ids <ids>] [--limit <n>]
khalani tokens balances [address] [--wallet eip155|solana] [--chain-ids <ids>]

khalani quote
  --from-chain <chain> --from-token <addr>
  --to-chain <chain> --to-token <addr>
  --amount <value>
  [--trade-type EXACT_INPUT|EXACT_OUTPUT]
  [--from-address <addr>] [--recipient <addr>] [--refund-to <addr>]
  [--filler <name>] [--route <routeId>]
  [--stream] [--refresh-chains]

khalani bridge
  --from-chain <chain> --from-token <addr>
  --to-chain <chain> --to-token <addr>
  --amount <value>
  [--trade-type EXACT_INPUT|EXACT_OUTPUT]
  [--from-address <addr>] [--recipient <addr>] [--refund-to <addr>]
  [--filler <name>] [--route-id <routeId>]
  [--deposit-method CONTRACT_CALL|PERMIT2|TRANSFER]
  [--dry-run] [--yes] [--refresh-chains]

khalani orders [address] [--wallet eip155|solana]
  [--limit <n>] [--cursor <n>]
  [--from-chain <chain>] [--to-chain <chain>]
  [--order-ids <ids>] [--tx-hash <hash>]

khalani order <orderId>
```

**Headless mode** (`VEX_HEADLESS=1`): All commands output structured JSON via `writeJsonSuccess()`.
**`--dry-run`** on bridge: builds the deposit plan without broadcasting. Returns plan details for inspection.
**`--yes`** on bridge: required to execute (safety confirmation). Without it, throws `CONFIRMATION_REQUIRED`.

---

## Route Selection Logic

`resolveRouteBestIndex()` in `helpers.ts`:
1. **Primary**: highest `amountOut` (BigInt comparison)
2. **Tiebreaker**: lowest `expectedDurationSeconds`

---

## Streaming Mode (NDJSON)

When `--stream` is used on `khalani quote`:
- Request: `POST /v1/quotes?mode=stream` with `Accept: application/x-ndjson`
- Response: one JSON object per line, each a route from a different filler
- All routes share the same `quoteId` but have different `routeId` values
- Stream completes when all fillers have responded or timed out
- Individual filler failures are skipped (fewer routes, no error)
- If request body fails validation, API returns normal JSON error (no stream)

Implementation: `client.streamQuotes()` reads the response body via `ReadableStream`, buffers until newline, parses each line as JSON, validates via `validateQuoteStreamRoute()`.

---

## Quote Expiry Safety

Before executing a bridge, `ensureRouteFresh()` in `bridge.ts` checks:
1. `quoteExpiresAt` (price quote expiry) — if set and past current time, throws `KHALANI_QUOTE_EXPIRED`
2. Falls back to `validBefore` (on-chain deadline) — same check

**Rule**: Always re-quote if expired. Never execute a deposit for a stale quote.

---

## Wallet Requirements

| Chain Family | What's needed | Resolved by |
|-------------|---------------|-------------|
| EVM (`eip155`) | Private key + EVM address in config | `requireEvmWallet()` from `multi-auth.ts` |
| Solana | Solana keystore + address in config | `requireSolanaWallet()` from `multi-auth.ts` |

Cross-chain bridges where source and destination are different families (e.g., EVM→Solana) use the **source chain** wallet for signing the deposit. The recipient address is resolved from the **destination chain** family.

---

## Filler Types

| Type | Description |
|------|-------------|
| `native-filler` | Khalani/HyperStream's own filler |
| `external-intent-router` | External intent protocol (Across, deBridge) |
| `liquidity-router` | Direct liquidity router |
| `aggregator-router` | Aggregator-based router |

---

## Route Tags

| Tag | Meaning |
|-----|---------|
| `1-click` | No token approval needed, deposit in one step |
| `needs-approval` | Token approval transaction required before deposit |

---

## EVM Client Details (`evm-client.ts`)

- Converts `KhalaniChain` to viem `Chain` object dynamically using RPC URL from chain metadata
- RPC timeout: 30 seconds
- RPC retry count: 2
- Creates both `walletClient` (for signing/sending) and `publicClient` (for waiting on receipts)

## Solana Signer Details (`solana-signer.ts`)

- Deserializes base64 → `VersionedTransaction`
- Signs with `Keypair.fromSecretKey()`
- Broadcasts via `Connection.sendRawTransaction()`
- Confirms with `confirmTransaction("confirmed")`
- Errors map to `KHALANI_SOLANA_SIGN_FAILED` or `KHALANI_BROADCAST_FAILED`
