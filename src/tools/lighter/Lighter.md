# Lighter Module Map

**Last updated: 2026-08-12**

Lighter support now covers Core + Robinhood Chain public market data,
read-only account visibility, a live-data-backed order preview gate, and local
approval preparation for a future order create. The approval-prepared create
path persists `lighter_order_execution_intents` and can ask the Vex approval
runtime for consent, but Vex still has no API private-key reader, signer client,
signature, `sendTx`, order submission, order cancel, deposit, withdrawal,
transfer, or other provider state-changing Lighter path.

## Sources

- Core docs: https://apidocs.lighter.xyz/
- RHC docs: https://apidocs.rh.lighter.xyz/
- Core REST base: `https://mainnet.zklighter.elliot.ai`
- RHC REST base: `https://api.rh.lighter.xyz`
- Core WebSocket base: `wss://mainnet.zklighter.elliot.ai/stream`
- RHC WebSocket base: `wss://api.rh.lighter.xyz/stream`

## File Map

| File | Role |
|------|------|
| `constants.ts` | Public base URLs, endpoint paths, explicit environment names, limits |
| `types.ts` | TypeScript request and response shapes for Phase 1 market reads |
| `validation.ts` | Runtime validators for the public REST responses |
| `errors.ts` | Lighter HTTP/provider failures mapped to `LIGHTER_*` `VexError`s |
| `throttle.ts` | Per-process public REST throttle, small TTL cache, in-flight dedupe |
| `client.ts` | Read-only REST client and singleton |
| `order-preview.ts` | Preview identity, exact decimal conversion, freshness, and non-spoofable match hashing |
| `trading-credentials.ts` | Non-submitting trading credential readiness boundary for future signer work |

Agent-facing files live under `src/vex-agent/tools/protocols/lighter/`:

| File | Role |
|------|------|
| `manifest.ts` | Aggregates the `lighter.*` protocol manifests |
| `manifests/read.ts` | Six read-only market-data tool schemas |
| `manifests/write.ts` | Approval-prepare and approval-resume Lighter order-create tool schemas |
| `handlers.ts` | Aggregates handler maps for the namespace |
| `handlers/read.ts` | Calls the public client and projects bounded results |
| `handlers/write.ts` | Creates local order execution intents and refuses approved create before signing |
| `nonce-sync.ts` | Internal helper that records public API-key nonce observations into durable state |
| `params.ts` | Agent-layer param readers and stricter output caps |
| `projectors.ts` | Compact model-facing result projection |
| `../embeddings/lighter/market-data.ts` | Discovery passages and aliases |

## Phase 1 REST Surface

| Client method | Endpoint | Notes |
|---------------|----------|-------|
| `getStatus(environment)` | `GET /` | Public status |
| `getSystemConfig(environment)` | `GET /api/v1/systemConfig` | Public system config |
| `getAccount(environment, params)` | `GET /api/v1/account` | Public by index/L1 address; private auth boundary applies before account tools expose it |
| `getAccountActiveOrders(environment, params)` | `GET /api/v1/accountActiveOrders` | Auth-gated active account orders candidate |
| `getAccountInactiveOrders(environment, params)` | `GET /api/v1/accountInactiveOrders` | Auth-gated inactive account orders candidate |
| `getApiKeys(environment, params)` | `GET /api/v1/apikeys` | Public API-key index, public key, and nonce metadata for execution planning |
| `getReadOnlyTokens(environment, params)` | `GET /api/v1/tokens` | Auth-gated read-only token inventory candidate |
| `getMarkets(environment, params)` | `GET /api/v1/orderBooks` | Optional `market_id`, `filter` |
| `getMarketDetails(environment, params)` | `GET /api/v1/orderBookDetails` | Required `market_id`; optional `filter` |
| `getOrderBookOrders(environment, params)` | `GET /api/v1/orderBookOrders` | Required `market_id`; `limit` 1-250 |
| `getRecentTrades(environment, params)` | `GET /api/v1/recentTrades` | Required `market_id`; `limit` 1-100 |
| `getAccountTrades(environment, params)` | `GET /api/v1/trades` | Auth-gated account trade history candidate |
| `getCandles(environment, params)` | `GET /api/v1/candles` | Required market, resolution, epoch-ms timestamp range, bounded `count_back` |

## Milestone 8 Execution Boundary

The next build slice is the execution architecture, not live trading. The
preview gate may feed a future exact matching order, but no order can be sent
until these boundaries are implemented and reviewed:

- Lighter order writes classify as external exchange mutations. If the existing
  taxonomy is used, the first create/cancel tools must be `external_post`;
  adding a narrower `exchange_order` action kind requires a separate approval
  and mutation-matrix review.
- `lighter.order.create` must require a fresh persisted `lighter.order.preview`
  match by session, environment, account index, optional API key index, market,
  side, exact integer amount, exact integer price, order type, time in force,
  reduce-only flag, expiry, client-order policy, and provider/version marker.
- Approval disclosures must be rebuilt from the persisted preview plus fresh
  provider/account reads. Handler parameters and model text may not populate
  price, size, account, or market facts in the approval surface.
- Signing belongs only in the privileged runtime. The renderer, preload, agent
  transcript, logs, telemetry, CLI arguments, and provider error text must never
  receive API private keys, signatures, signed payloads, auth tokens, or raw
  trading credential material.
- Trading credentials must enter future signer code only through an opaque
  encrypted-vault reference. Vex must reject raw private-key-shaped strings,
  read-only tokens, handler params, CLI args, and environment variables as
  trading credential sources.
- Lighter API key indexes `0` and `1` are reserved for Lighter interfaces, and
  index `255` is the all-keys inspection sentinel. Future trading paths may use
  only indexes `2` through `254`.
- Nonces are per `(environment, accountIndex, apiKeyIndex)`. Vex must serialize
  signing for that key, persist the nonce before submit, and reconcile from
  provider state after ambiguous failures.
- `sendTx` acceptance is not an execution result. Vex may report API accepted or
  sequencer pending, but may report open, partial fill, fill, cancel, or reject
  only after provider/WebSocket/account-order evidence proves that state.

Execution lifecycle vocabulary:

| State | Meaning |
|---|---|
| `previewed` | Vex generated and stored a live-data-backed order preview |
| `approval_pending` | The user has not approved the exact previewed order |
| `signed` | Vex signed locally inside the privileged runtime |
| `submitted` | Vex attempted provider submission |
| `api_accepted` | Lighter accepted the request syntax/API submission |
| `sequencer_pending` | Final provider outcome is not yet known |
| `open` | Provider evidence shows the order is live on the book |
| `partially_filled` | Provider evidence shows a partial fill |
| `filled` | Provider evidence proves full fill |
| `canceled` | Provider evidence proves cancellation |
| `rejected` | Provider evidence proves rejection |
| `ambiguous` | Vex cannot prove the final state and must not suggest blind retry |

Signer and credential strategy:

- Official Lighter docs require API-key-backed signing before transaction
  submission. The signer client receives `{ apiKeyIndex: privateKey }`,
  account index, and base URL.
- Official docs state API private keys can trade, authenticate, and process
  withdrawals. Vex therefore treats them as trading-capable secrets, not
  read-only credentials.
- Vex currently stores only a readiness boundary for this: `trading-credentials.ts`
  validates `(environment, accountIndex, apiKeyIndex, vaultCredentialId)` and
  returns a nonce scope. It never reads a private key and cannot sign.
- The acceptable secret source for a future implementation is the encrypted
  local vault. The agent layer may hold an opaque vault id, but not key bytes,
  signatures, auth tokens, or signed payload JSON.
- The future create path must combine a fresh preview match, user approval,
  credential readiness, nonce reservation, durable activity intent, privileged
  signing, provider submission, and provider/WebSocket outcome reconciliation in
  that order.
- `lighter_order_execution_intents` now stores the durable bridge between a
  preview and any future signer path. It records preview identity fields,
  approval status, execution state, optional `approval_queue` /
  `protocol_executions` anchors, and the opaque encrypted-vault credential
  reference. It does not store key bytes, auth tokens, signatures, signed
  payloads, or provider submit bodies.
- `lighter.order.create.prepare` is the only user-facing bridge from preview
  to approval today. It requires the fresh preview id and an opaque encrypted
  vault credential reference, creates the local execution-intent row, then uses
  Vex's trusted prepared-action registry to request approval for
  `lighter.order.create`.
- Approved `lighter.order.create` records the approval decision against the
  local Lighter execution intent, then refuses before signer initialization or
  provider submission. This is intentional until the privileged signer adapter
  is implemented and reviewed.

Milestone 8 is complete only when the signer strategy, nonce model, durable
activity lifecycle, and failure/repair policy are reviewed. Live order
submission belongs to the later approval-gated create milestone.

Nonce foundation now has durable storage in `lighter_nonce_state` and an
internal public nonce sync helper:

- The state key is `(environment, accountIndex, apiKeyIndex)`.
- Provider nonces are stored as decimal strings after a safe-integer check. If a
  provider nonce cannot be represented exactly from the current JSON response,
  Vex refuses to reserve it rather than sign with an imprecise value.
- `recordObserved` updates only rows that are still `observed`; it does not
  overwrite an in-flight reservation.
- `reserveObserved` is a compare-and-set transition from `observed` to
  `reserved`, copying `provider_nonce` into `reserved_nonce` and attaching a
  reservation id before any future signer path can consume it.
- The status vocabulary includes `submitted` and `ambiguous` for the future
  order path, so a lost response or sequencer uncertainty can be tracked without
  suggesting a blind retry.
- This nonce foundation stores no API private key, read-only auth token,
  signature, signed transaction JSON, `sendTx` payload, or provider auth error.

## Milestone 4 Auth Boundary

Milestone 4 is the read-only credential and request boundary, not account-tool
activation and not trading. It must use Lighter read-only auth tokens only:
`ro:{account_index}:{single|all}:{expiry_unix}:{random_hex}`. Normal Lighter
API keys can read and write, so API private keys and signer-client material are
explicitly excluded from this milestone.

Allowed:

- read-only token format validation;
- environment-scoped vault labels for read-only tokens;
- credential status metadata, such as configured capability and token expiry;
- authenticated REST request helpers that receive token material only through a
  privileged provider function;
- live probes of auth-gated account-read endpoints when real read-only tokens
  are present.

Not allowed:

- API private keys;
- signer-client initialization;
- auth-token generation from API private keys inside Vex;
- `sendTx`, order create, cancel, modify, deposit, withdrawal, transfer, or
  nonce handling;
- returning raw auth tokens to renderer, preload, agent output, logs, errors,
  test snapshots, docs, or telemetry.

## Agent Tools

Every tool requires `environment: "core" | "rhc"` and is registered as
`mutating: false`, `actionKind: "read"`.

| Tool | Client calls | Returns |
|------|--------------|---------|
| `lighter.system` | `getStatus`, `getSystemConfig` | Status, network id, public pool/config fields |
| `lighter.markets` | `getMarkets` | Deterministically ordered, paged market rows with count/truncation disclosure |
| `lighter.market.get` | `getMarketDetails` | One-market detail rows for a numeric `marketId` |
| `lighter.account.get` | `getAccount` | Public account rows by account index or L1 address |
| `lighter.positions` | `getAccount` | Public inline positions from account rows |
| `lighter.openOrders` | `getAccountActiveOrders` | Authenticated open-order rows through read-only token |
| `lighter.orderHistory` | `getAccountInactiveOrders` | Authenticated inactive/historical order rows through read-only token |
| `lighter.trades` | `getAccountTrades` | Authenticated account trade rows through read-only token |
| `lighter.apiKeys.inspect` | `getApiKeys` | Public API-key indexes, public keys, and nonce metadata |
| `lighter.order.preview` | market detail, order book, public account | Persisted preview-only Lighter order preflight |
| `lighter.order.create.prepare` | persisted preview, local vault reference boundary | Local approval-prepared execution intent |
| `lighter.order.create` | approval resume context, local execution intent | Records approval then refuses before signer/provider submit |
| `lighter.orderbook` | `getOrderBookOrders` | Bounded asks/bids sorted by best price with provider totals and truncation flags |
| `lighter.recentTrades` | `getRecentTrades` | Bounded public trade tape rows plus cursor disclosure |
| `lighter.candles` | `getCandles` | Newest candle rows up to the agent output cap |

Every successful agent response includes provenance:

| Field | Meaning |
|-------|---------|
| `source` | Always `live_lighter_public_api` for these tools |
| `provenance.provider` | `lighter` |
| `provenance.dataPlane` | `provider_public_rest`, not a mock, fixture, or local simulator |
| `provenance.environment` | Explicit `core` or `rhc` |
| `provenance.endpointPaths` | Public Lighter REST paths used for the read |
| `provenance.retrievedAt` | Time Vex produced the tool response |
| `provenance.cacheStatus` | `fresh_or_short_cache`; the bytes are from live provider reads and may be served from Vex's short in-process cache |
| `provenance.maxDataAgeMs` | Current maximum cache age for repeated identical reads |
| `provenance.independentOnchainVerification` | `false` until a later phase adds independent chain/RPC verification |

## Safety Notes

- Every call requires an explicit `environment`: `core` or `rhc`.
- The agent tools never infer an environment from chain, symbol, or conversation
  context; the selected environment is always echoed in the result.
- Public tools never read environment variables, local secret vault entries, API
  keys, auth tokens, private keys, wallets, or signer state. Authenticated
  account reads use read-only tokens only through the privileged provider path.
- Agent handlers call only the read client and preview persistence. There is no
  renderer, preload, wallet, approval, order submit, order cancel, deposit,
  withdrawal, transfer, or signing path in the Lighter namespace.
- Market list projections sort active markets first, then by ascending
  `market_id`, before applying the agent page and limit. Broad lists return
  `page`, `lastPage`, `nextPage`, `sorting`, and a truncation note so the agent
  can walk the live provider list instead of depending on provider row order.
  A page past the live result set fails clearly with the last valid page number
  instead of returning an empty list that could be mistaken for no markets.
- Order book projections sort asks by ascending numeric price and bids by
  descending numeric price before applying the agent output limit. Vex does not
  rely on provider row order for top-of-book reasoning.
- Core order book rows can expose `order_index` values larger than JavaScript's
  safe integer range; Core and RHC recent-trade rows can do the same for order
  ids such as `trade_id`, `ask_id`, and `bid_id`. Phase 1 treats Lighter's
  `*_id_str` fields as canonical for recent trades: agent output exposes those
  digit-only strings as the primary ids, keeps unsafe numeric provider fields
  as `null`, and marks the numeric precision when JavaScript cannot represent
  the number exactly.
- Candle timestamps are JavaScript epoch milliseconds. Seconds-scale Unix
  timestamps are rejected before a provider request is sent.
- Candle ranges are bounded by Vex before the provider request. In Phase 1,
  broad ranges are rejected if they can exceed the requested `countBack` at the
  selected resolution. This is a Vex-owned safety and output-size policy, not a
  claim about Lighter's full candle query semantics.
- Agent candle output is capped independently of provider response validation;
  the response discloses provider row count and truncation instead of silently
  emitting a huge payload.
- Provider error bodies are redacted and length-bounded before they enter a
  `VexError`.
- Lighter public market data is live provider API data, not mock data. Do not
  describe it as independently on-chain verified unless a later verifier proves
  the same rows through a chain/RPC source.

## Account Endpoint Auth Matrix

Which account endpoints require a credential is live-verified per endpoint, not
inferred from the docs. Lighter's behavior is not uniform, and two endpoints
that look equally account-scoped can sit on opposite sides of the auth line.

Full Core and RHC classifications were verified on 2026-08-10 with real
read-only tokens through `pnpm run test:lighter:live:auth:prompt`.
`pnpm run lighter:probe:auth` exits non-zero when that proof is incomplete.

| Endpoint | Without credentials | With read-only token | Access |
|---|---|---|---|
| `/api/v1/account` | 200 | not required | public |
| `/api/v1/accountsByL1Address` | 200 | not required | public |
| `/api/v1/apikeys` | 200 | not required | public |
| `/api/v1/accountActiveOrders` | 400, code 20001 | 200 | read-only token required |
| `/api/v1/accountInactiveOrders` | 400, code 20001 | 200 | read-only token required |
| `/api/v1/trades` | 400, code 20001 | 200 | read-only token required |
| `/api/v1/tokens` | 400, code 20001 | 401, invalid auth | closed to the read-only lane |

Consequences for the tool surface:

- Account state, positions, sub-account lookup by L1 address, and API key
  metadata are public. Vex must not require a credential for them. Gating a
  public read would lock keyless users out of data they are entitled to, and
  presenting a public read as authenticated account visibility would be
  untruthful.
- Only open orders, order history, and account trades consume the read-only
  credential.
- A 200 response obtained while holding a token is not evidence that the token
  was required. Only the credential-less call separates public from auth-gated,
  which is why the matrix is regenerated from both directions.

Two provider behaviors that the client must account for:

- Missing credentials are signalled as HTTP `400` with body
  `{"code":20001,"message":"invalid param : auth query param and Authorization
  header are empty"}`, not as `401`. Status-based error mapping alone will
  report a missing or expired token as a malformed request.
- The provider also accepts credentials as an `auth` query parameter. Vex sends
  credentials only as an `Authorization` header. A token must never enter a URL,
  where it would reach logs, proxies, referrers, and error strings.

Regenerate the full matrix with `pnpm run lighter:probe:auth`. The probe is
read-only and never prints token material. It requires both Core and RHC
read-only tokens and exits non-zero when the matrix is incomplete or unknown.
Run `pnpm run lighter:probe:auth:public` for a public-only drift check; that
mode does not prove read-only token reachability.

## Verification

- Client foundation: `pnpm test src/__tests__/lighter/lighter-client.test.ts src/__tests__/lighter/lighter-throttle.test.ts`
- Account endpoint auth matrix: `pnpm run lighter:probe:auth`
- Auth boundary: `pnpm test src/__tests__/lighter/lighter-auth-token.test.ts src/__tests__/lighter/lighter-credentials.test.ts`
- Agent discovery: `pnpm test src/__tests__/vex-agent/tools/lighter-discovery.test.ts`
- Agent handlers: `pnpm test src/__tests__/vex-agent/tools/lighter-handlers.test.ts`
- Protocol guardrails: manifest lint, embedding lint, registry completeness, and
  namespace list-mode tests.
- Live market-data proof: `pnpm run test:lighter:live` runs the gated
  `VEX_LIGHTER_LIVE=1` smoke against real Core and RHC public APIs through
  `executeProtocolTool`, including provenance assertions on every Lighter tool
  response.
- Live public API-key nonce proof: `pnpm run test:lighter:live:apikeys` runs
  the gated `VEX_LIGHTER_API_KEYS_LIVE=1` smoke against real Core and RHC
  public `/api/v1/apikeys` reads through `executeProtocolTool`. It requires no
  credential and must never be described as trading authority; it proves only
  public API-key index, public key, and nonce metadata visibility.
- Nonce-state guardrails: `pnpm test
  src/__tests__/vex-agent/db/repos/lighter-nonce-state.test.ts
  src/__tests__/vex-agent/tools/lighter-nonce-sync.test.ts
  src/__tests__/vex-agent/tools/lighter-execution-boundary.test.ts` verifies
  durable nonce observation/reservation behavior and confirms no Lighter
  create/cancel/submit/sign hook has been introduced.
- Live read-only auth proof: `pnpm run test:lighter:live:auth` runs the gated
  `VEX_LIGHTER_AUTH_LIVE=1` smoke against real Core and RHC account endpoints.
  It requires `LIGHTER_CORE_READ_ONLY_AUTH_TOKEN` and
  `LIGHTER_RHC_READ_ONLY_AUTH_TOKEN` to be present through the encrypted local
  secret vault or process environment. If either real token is absent, expired,
  or malformed, the live auth proof fails rather than substituting fixtures,
  mocks, or simulated provider responses. The proof uses read-only-compatible
  account data endpoints: `/api/v1/trades`, `/api/v1/accountActiveOrders`, and
  `/api/v1/accountInactiveOrders`. `/api/v1/tokens` is not treated as proof for
  a read-only token because live Core rejected that endpoint with a read-only
  token while accepting account trade history. This smoke also calls
  `/api/v1/account`, which the auth matrix later showed to be public. That call
  exercises the client path but is not evidence of authenticated access.
- Prompted live proof: `pnpm run test:lighter:live:auth:prompt` asks for the
  Core read-only token, then the RHC read-only token, hides both inputs, and
  runs the live auth smoke followed by the full account auth matrix probe with
  those tokens only in child-process environment variables.

## Live Verification Notes

2026-08-09 local time (`2026-08-09T00:09Z`): `pnpm run test:lighter:live`
passed against real public Lighter infrastructure, including provenance
assertions on every successful Lighter tool response.

| Environment | Network id | Latest selected market | Reads proven |
|-------------|------------|------------------------|--------------|
| Core | 1 | `0` / `ETH` | system, markets, market detail, order book, recent trades, candles |
| RHC | 1 | `0` / `ETH` | system, markets, market detail, order book, recent trades, candles |

The live smoke selected active markets from `lighter.markets`, then reused the
selected `marketId` for detail, depth, recent trades, and 1-minute candles.
Both environments returned 10 ask rows, 10 bid rows, 10 recent trade rows, and
12 candle rows within the configured live smoke limits. The latest proof
selected ETH on both Core and RHC after market-list output was hardened to sort
before paging.

2026-08-10 local time: `pnpm run test:lighter:live:auth:prompt` passed against
real Core and RHC read-only tokens. The live auth runtime test proved
`lighter.account.get`, `lighter.positions`, `lighter.openOrders`,
`lighter.orderHistory`, and `lighter.trades` through `executeProtocolTool` for
both environments. The full account auth matrix also completed for both
environments: `/account`, `/accountsByL1Address`, and `/apikeys` were public;
`/accountActiveOrders`, `/accountInactiveOrders`, and `/trades` required a
read-only token; `/tokens` rejected the read-only lane with `401 invalid auth`.

2026-08-10 local time: `pnpm run test:lighter:live:preview` passed against real
Core and RHC live data through `executeProtocolTool`, with the repo e2e
Postgres on port 5777 and the Lighter order-preview migration applied. The
proof created persisted `lighter_order` previews for both environments from
live market details, live order books, and live public account reads. No signer,
API private key, signature, `sendTx`, order placement, cancellation, deposit,
withdrawal, or transfer path was introduced.

2026-08-12 local time: `pnpm run test:lighter:live:apikeys` passed against real
Core and RHC public `/api/v1/apikeys` reads through `executeProtocolTool`. The
proof exercised `lighter.apiKeys.inspect` for account `1` with API-key index
`255`, returned at least one public API-key metadata row for each environment,
and asserted live public provenance. No credential, API private key, signer,
signature, `sendTx`, order placement, cancellation, deposit, withdrawal, or
transfer path was introduced.
