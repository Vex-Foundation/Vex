# Lighter Module Map

**Last updated: 2026-08-13**

Lighter support now covers Core + Robinhood Chain public market data,
read-only account visibility, a live-data-backed order preview gate, and local
approval preparation for a future order create. The approval-prepared create
path persists `lighter_order_execution_intents` and can ask the Vex approval
runtime for consent. Approved create can now build an internal signer-bound
execution plan and unsigned signer order from the durable intent. Vex also has a
validated official signer helper and binary adapter for local `SignCreateOrder`,
plus a low-level signed-transaction submit client for Lighter's official
`sendTx` form contract. The execution-intent store also has safe lifecycle
metadata for future signed/submitted/API-accepted/ambiguous transitions. The
approved create handler now has a gated execution pipeline that can load the
main-process vault reader, reserve a nonce, sign with the packaged helper, mark
submitted, call `sendTx`, and persist API acceptance only after the explicit
live-trading release gate opens. The gate remains closed, so Vex still has no
agent-facing live order submission, order cancel, deposit, withdrawal, transfer,
or other reachable provider state-changing Lighter path. Settings/API keys can
now import or remove Lighter trading API private keys into the encrypted local
vault by exact `(environment, accountIndex, apiKeyIndex)` scope; those keys are
stored as non-env extra secrets and are not returned to the renderer.

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
| `types.ts` | TypeScript request and response shapes for Lighter reads and the low-level submit boundary |
| `validation.ts` | Runtime validators for Lighter REST responses |
| `errors.ts` | Lighter HTTP/provider failures mapped to `LIGHTER_*` `VexError`s; submit errors avoid provider-body disclosure |
| `throttle.ts` | Per-process public REST throttle, small TTL cache, in-flight dedupe |
| `client.ts` | REST client and singleton; `sendTx` exists only as a low-level signed-submit transport |
| `order-preview.ts` | Preview identity, exact decimal conversion, freshness, and non-spoofable match hashing |
| `trading-credentials.ts` | Non-submitting trading credential readiness boundary for future signer work |
| `trading-secret.ts` | Typed private-key material loader that accepts only an injected privileged reader and redacts ordinary serialization |
| `signer-order.ts` | Unsigned create-order request builder and deterministic Vex-assigned uint48 client-order-index derivation |
| `signer-adapter.ts` | Official Lighter signer adapter interface plus create-order signer input/range validation; no provider submission |
| `signer-binary-adapter.ts` | Privileged-process adapter that invokes the official signer helper with secrets over stdin only |
| `signer-runtime/` | Go helper built on `github.com/elliottech/lighter-go` for local create-order signing |
| `../../vex-app/src/main/secrets/lighter-trading-credential.ts` | Main-process encrypted-vault import, status, removal, and reader boundary for Lighter trading private keys stored as non-env extra secrets |
| `../vex-agent/tools/protocols/lighter/execution-plan.ts` | Approved-intent to signer-bound execution plan; refuses while live trading is disabled |
| `../vex-agent/tools/protocols/lighter/order-create-execution.ts` | Gated approved-create pipeline for vault secret load, nonce reservation, local signing, submit metadata, `sendTx`, and API-acceptance persistence |
| `../vex-agent/db/repos/lighter-order-execution-intents.ts` | Durable approval, nonce, signed, submitted, API-accepted, and ambiguous state transitions |

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
| `nonce-reservation.ts` | Internal helper that atomically reserves an observed nonce and attaches it to the approved order intent |
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

## Low-Level Submit Boundary

| Client method | Endpoint | Notes |
|---------------|----------|-------|
| `sendTx(environment, params)` | `POST /api/v1/sendTx` | Accepts already-signed `tx_type` / `tx_info` form data and optional `price_protection`; validates API-acceptance response only |

The submit boundary deliberately does not cache requests, does not attach
read-only auth headers, does not expose provider rejection bodies, and is not
called by `lighter.order.create` yet. A `code=200` response means API
acceptance only; final open/fill/cancel/reject state still requires provider
evidence.

## Milestone 8 Execution Boundary

The execution architecture boundary is documented and code-guarded, but it is
still not live trading. The preview gate may feed a future exact matching
order, but no order can be sent until the explicit live-trading release gate is
opened after review and live provider proof:

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
- Official Lighter API-key docs reserve indexes `0`, `1`, `2`, and `3` for
  Lighter interfaces, and index `255` is the all-keys inspection sentinel.
  Future trading paths may use only indexes `4` through `254`.
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

Current outcome-repair behavior:

- Before signing, the live create path verifies that authenticated account-order
  reads are available for the target account and market. If not, it stops
  before reading the trading key, reserving nonce, signing, or calling
  `sendTx`.
- After `sendTx` code `200`, Vex records `api_accepted`, immediately moves the
  intent to `sequencer_pending`, then checks authenticated active orders,
  inactive orders, and account trades for the exact Vex-assigned
  `client_order_id`.
- Vex records compact provider evidence only: source, client order id, order id,
  status, market/account, and bounded fill fields. It does not store `tx_info`,
  signed payload JSON, signatures, API private keys, auth tokens, or raw
  provider error bodies.
- If provider outcome reads fail after submission, Vex marks the intent
  `ambiguous` and must not retry `sendTx` without nonce and provider-state
  reconciliation.

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
- `execution-plan.ts` is the current ready-for-signer boundary. It accepts only
  an approved, unexpired, session-scoped durable intent whose opaque vault
  reference still matches the preview-bound environment/account/API-key scope.
  It refuses intents that are unapproved, already advanced, expired, nonce
  reserved, or credential-scope mismatched. The live submit gate is hard-coded
  disabled until the user explicitly approves the trading milestone.
- `trading-secret.ts` defines the private-key material boundary for the later
  privileged signer adapter. It can load key bytes only from an injected
  privileged reader and refuses missing, incomplete, or read-only-token material.
  It deliberately does not read `process.env`, handler params, CLI args, or the
  current managed vault keys that are mirrored into environment variables on
  unlock. The material keeps key bytes non-enumerable and returns a redacted
  JSON shape if ordinary serialization is attempted.
- `vex-app/src/main/secrets/lighter-trading-credential.ts` is the concrete
  main-process import/status/removal/reader boundary for Lighter trading
  credentials. It writes and reads only the exact default credential id
  `lighter/<environment>/account-<accountIndex>/api-key-<apiKeyIndex>` from the
  encrypted vault's non-env `extraSecrets`, validates full 40-byte Lighter API
  private keys before import, refuses mismatched references before vault access,
  does not fall back to environment variables, and maps vault failures without
  echoing secret material. These functions are not yet invoked by
  `lighter.order.create`.
- Settings/API keys calls this main-process boundary directly for one-time
  import or removal. The renderer submits only the typed account/API-key scope
  plus the one-time private-key field; after a successful save the form is
  cleared, and status returns only environment-level configured booleans.
  Managed environment-vault keys remain separate from these trading extra
  secrets.
- `signer-order.ts` maps a ready-for-signer plan into unsigned Lighter
  create-order fields, including official order type and time-in-force enum
  codes, ask/bid side, integer size/price, expiry, and a deterministic uint48
  Vex-assigned client order index derived from the preview match hash. It
  creates no signature and performs no provider call.
- `signer-adapter.ts` is the next boundary toward the official Lighter signer.
  It maps an unsigned create-order request plus privileged private-key material
  and an explicit nonce into the exact signer input envelope: REST base URL,
  chain id (`304` Core, `466324` RHC), account/API-key scope, nonce, and order
  fields. It validates the official integer ranges before any future native
  signer call. The adapter result must still match the prepared order identity.
  The module deliberately creates no provider submission.
- `signer-runtime/` contains the local Go helper that uses the official
  `github.com/elliottech/lighter-go` signer to build L2 create-order
  transactions. Its protocol accepts string decimal values for nonce,
  client-order-index, base amount, price, trigger price, and expiry so
  JavaScript number precision cannot corrupt signer inputs. It accepts only full
  40-byte hex Lighter trading API private keys, with optional `0x` prefix.
- `signer-binary-adapter.ts` locates and invokes that helper as a child process
  with an empty argument list, sends the signing request over stdin, drains
  stderr without retaining text, bounds stdout, validates the helper's
  structured output, and returns only `txType`, `txInfo`, and `txHash` to the
  privileged execution path. Helper failure messages remain structural and do
  not echo key material or signed payloads.
- `client.ts` now exposes the low-level `sendTx` transport that posts official
  form data (`tx_type`, `tx_info`, optional `price_protection`) and validates
  the API-acceptance response (`code`, `tx_hash`,
  `predicted_execution_time_ms`, and optional `volume_quota_remaining`). Submit rejection
  errors do not include provider response bodies because those may echo signed
  payload material. This client method is disconnected from agent order
  handlers while the explicit live-trading release gate remains closed.
- `order-create-execution.ts` is the only reviewed agent-side owner of the
  future live create path. It is dependency-injected by the Vex main process
  with the unlocked-vault secret reader, packaged signer adapter, and Lighter
  client. Its order is: release gate, key load, nonce reservation, local signer,
  signed-state persistence, submitted-state persistence before `sendTx`, API
  acceptance persistence, and ambiguous-state marking for send-time uncertainty
  or post-reservation failures. It returns only bounded hashes/status metadata,
  never key bytes or `tx_info`.
- `lighter_order_execution_intents` now stores the durable bridge between a
  preview and any future signer path. It records preview identity fields,
  approval status, execution state, optional `approval_queue` /
  `protocol_executions` anchors, and the opaque encrypted-vault credential
  reference. It does not store key bytes, auth tokens, signatures, signed
  payloads, or provider submit bodies.
- The execution-intent repo also owns the future submit lifecycle CAS
  transitions: `markSigned` requires an approved intent with an attached nonce
  reservation, `markSubmitted` advances only the matching signed hash,
  `markApiAccepted` records the provider API-acceptance hash/timing/quota data
  without marking a final order outcome, and `markAmbiguous` preserves uncertain
  post-sign or post-submit states for repair. These methods reject raw
  signed-payload-shaped text before writing.
- `lighter.order.create.prepare` is the user-facing bridge from preview to
  approval today. In the normal conversational flow it uses the latest fresh
  preview in the session and derives the local encrypted-vault reference from
  the preview's environment, account index, and API-key index, then creates the
  local execution-intent row and uses Vex's trusted prepared-action registry to
  request approval for `lighter.order.create`.
- Approved `lighter.order.create` records the approval decision against the
  local Lighter execution intent, builds the signer-bound execution plan, builds
  the unsigned create-order request, then refuses at the explicit live-trading
  gate before any private-key read, signer initialization, signature, or
  provider submission. This is intentional until the privileged signer adapter,
  durable post-submit lifecycle, and handler-level `sendTx` wiring are verified.

Milestone 8 S1/S2 are closed for the documented execution boundary and
code-level guardrails: create remains approval-gated, cancel surfaces are not
registered, and submit/signing behavior is isolated behind the disabled
live-trading release gate. Live order submission belongs to the later
approval-gated create milestone.

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
- `nonce-reservation.ts` is the current nonce consumption boundary. It reserves
  an observed nonce with the `lighter_nonce_state` compare-and-set update and
  attaches that same reservation to the exact approved
  `lighter_order_execution_intents` row inside one transaction. The attach is
  scoped by session id, environment, account index, and API-key index, and
  refuses if the intent already has a nonce or is not approved. This helper
  still creates no signature and performs no provider submission.

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
- order create, cancel, modify, deposit, withdrawal, transfer, or
  nonce handling;
- returning raw auth tokens to renderer, preload, agent output, logs, errors,
  test snapshots, docs, or telemetry.

## Agent Tools

Agent tools accept `environment: "core" | "rhc"` as an advanced override and
default to `rhc` for normal conversational Lighter requests. Tools are
registered as read-only or approval-preparation surfaces; the only execution
resume target records approval and still refuses before signer/provider submit.

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
| `lighter.order.preview` | live market resolution, public API-key metadata, market detail, order book, public account | Persisted preview-only Lighter order preflight from conversational asset/price/expiry requests |
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

- Normal conversational calls default to `rhc`; callers can still explicitly
  choose `core` or `rhc`, and the selected environment is always echoed in the
  result.
- `lighter.order.preview` resolves normal user language such as ETH, amount,
  price, and relative expiry into live Lighter market, account, and public
  trading API-key metadata. It does not ask users for account indexes, API-key
  indexes, market ids, or client-order-index policy unless they explicitly
  override the advanced fields.
- Vex still requires the user to choose buy or sell for order previews. If that
  direction is missing, the agent should ask a plain-language clarification
  instead of guessing.
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
