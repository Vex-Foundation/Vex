# Lighter Module Map

**Last updated: 2026-08-19**

Lighter support now covers Core + Robinhood Chain public market data,
read-only account visibility, wallet-funded account onboarding, local trading
credential registration, approval-gated order create, and Phase 2 order
lifecycle management. Phase 2 adds exact approval-gated cancel-one, limit-order
modify, immediate cancel-all, full reduce-only position close, authenticated
order/trade/position streams, and evidence-only lifecycle repair. Phase 3 can reserve a
free API-key slot, generate and encrypt the key locally, prepare a separate
registration approval, sign the exact TxType 8 ownership transaction in the
privileged main process, submit it through Lighter `sendTx`, and reconcile the
result. The credential becomes available to order signing only after the live
slot matches the vault-derived public key, the official SDK `CheckClient`
succeeds, and the next nonce is exactly the approved nonce plus one.

Deposit, key registration, and order create require exact user approval and
execute through the privileged main-process boundary without operator environment gates.
Signatures, signed payloads, private keys, and auth tokens are never persisted
in PostgreSQL or returned through the agent tool surface. Approval-gated order
create, market/IOC signing, and Phase 3 registration have real Core proofs. No
manual dashboard API-key entry or credential copy/paste is required for the
wallet-funded onboarding flow.

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
| `wallet-funding/api-key-slots.ts` | Strict full-slot inspection and conservative unused-index selection for `4..254` |
| `change-pub-key.ts` | Exact TxType 8 unsigned identity and fixed-width L1 ownership-message construction |
| `order-preview.ts` | Preview identity, exact decimal conversion, freshness, and non-spoofable match hashing |
| `trading-credentials.ts` | Non-submitting validator for exact encrypted-vault credential and nonce scope |
| `trading-secret.ts` | Typed private-key material loader that accepts only an injected privileged reader and redacts ordinary serialization |
| `signer-order.ts` | Unsigned create-order request builder and deterministic Vex-assigned uint48 client-order-index derivation |
| `signer-adapter.ts` | Official Lighter signer adapter interface for canonical account auth and create-order signing; no provider submission |
| `signer-binary-adapter.ts` | Privileged-process adapter that invokes the official signer helper with secrets over stdin only |
| `signer-runtime/` | Pinned `lighter-go` helper for key generation, public derivation, TxType 8 signing, official `CheckClient`, account auth, create-order signing, cancel-one, cancel-all, and modify signing |
| `signer-order-lifecycle.ts` | Exact TxType 15 cancel-one, TxType 16 immediate cancel-all, and TxType 17 modify signer contracts |
| `../../../vex-app/src/main/secrets/lighter-trading-credential.ts` | Main-process encrypted-vault import, status, removal, and reader boundary for Lighter trading private keys stored as non-env extra secrets |
| `../../../vex-app/src/main/lighter/key-registration-credential.ts` | Privileged pending-key creation/recovery and public-only promotion to active |
| `../../../vex-app/src/main/lighter/key-registration-signing.ts` | Selected-wallet EIP-191 signature plus official TxType 8 signer orchestration |
| `../../../vex-app/src/main/lighter/key-registration-execution.ts` | Exact preflight, staged submit, evidence verification, and reconciliation owner |
| `../../vex-agent/tools/protocols/lighter/key-registration-execution.ts` | Public-only dependency seam for registration execution and reconciliation |
| `../../vex-agent/db/repos/lighter-key-registration-intents.ts` | Durable public registration identity and checked lifecycle transitions |
| `../../vex-agent/tools/protocols/lighter/execution-plan.ts` | Approved-intent to signer-bound execution plan |
| `../../vex-agent/tools/protocols/lighter/order-create-execution.ts` | Approved-create pipeline for vault secret load, nonce reservation, local signing, submit metadata, `sendTx`, and API-acceptance persistence |
| `../../vex-agent/db/repos/lighter-order-execution-intents.ts` | Durable approval, nonce, signed, submitted, API-accepted, and ambiguous state transitions |
| `../../vex-agent/tools/protocols/lighter/order-lifecycle.ts` | Fresh preparation, exact approval-gated execution, and provider-evidence reconciliation for cancel, modify, cancel-all, and full position close |
| `../../vex-agent/db/repos/lighter-order-lifecycle-intents.ts` | Durable lifecycle approval, nonce, staging, submission, outcome, and ambiguity state |
| `../../../vex-app/src/main/lighter/order-stream.ts` | Privileged authenticated account orders/trades/positions supervisor with reconnect resnapshot |

Agent-facing files live under `src/vex-agent/tools/protocols/lighter/`:

| File | Role |
|------|------|
| `manifest.ts` | Aggregates the `lighter.*` protocol manifests |
| `manifests/read.ts` | Read-only market/account schemas plus evidence-only deposit, order, and key-registration status tools |
| `manifests/write.ts` | Approval-prepare/resume schemas for deposit, key registration, and order create |
| `handlers.ts` | Aggregates handler maps for the namespace |
| `handlers/read.ts` | Calls the public client and projects bounded results |
| `handlers/write.ts` | Aggregates approval preparation and exact approved-resume handlers |
| `handlers/key-registration.ts` | Registration preparation and host-approval-only execution dispatch |
| `key-registration-preparation.ts` | Full-slot reservation, pending vault-key provisioning, public metadata, and exact approval preparation |
| `key-registration-approval-binding.ts` | Non-spoofable comparison of approval-card facts to the durable registration intent |
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
| `getNextNonce(environment, params)` | `GET /api/v1/nextNonce` | Public just-in-time nonce for one exact account/API-key scope |
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
read-only auth headers and does not expose provider rejection bodies. It is
reachable from `lighter.order.create` only after an exact user approval resumes
the configured privileged execution path. A `code=200` response
means API acceptance only; final open/fill/cancel/reject state still requires
provider evidence.

The order-create product surface exposes only market orders with
`immediate-or-cancel` time in force.
The required price is the user's worst acceptable execution price, and Vex
revalidates the live opposite-side price after approval before any credential
or vault access. Resting limit, good-till-time, and post-only orders are refused
at parameter parsing, approval preparation, execution-plan construction, and
the privileged submit boundary. Phase 2 now provides production approval-gated
cancel and modify machinery, but the create gate remains closed until retained
real-provider canary evidence proves both operations end-to-end on a separately
approved resting order. The lower-level signer keeps the provider's broader order-type
encoding for future phases, but those modes are not reachable from the product.

## Production Deposit Boundary

Deposit execution has no operator environment gate, allowlist, rollout cap, or
kill switch. It remains unavailable to direct model calls and resumes only from
the exact approval card the user accepted. Before signing, Vex revalidates the
selected wallet, Ethereum chain, Lighter gateway and USDC metadata, balances,
allowance, transaction fee ceilings, intent freshness, workflow state, and
wallet nonce lease. Transaction identity is staged durably before broadcast,
and ambiguous outcomes are reconciliation-only.

## Phase 3 Key Registration Boundary

| Tool | Capability |
|------|------------|
| `lighter.key.register.prepare` | Reserves a full-read-proven slot, creates/reuses an encrypted pending key, reads the exact nonce, and returns a security-sensitive approval card without signing or submitting |
| `lighter.key.register` | Host-approval-only resume target; exact approval is required before signing or `sendTx` |
| `lighter.key.register.status` | Reconciles a previously staged registration from public evidence; structurally cannot sign, submit, or retry an unstaged intent |

The privileged execution sequence is intentionally ordered:

1. Re-prove the unique wallet-owned master account, reserved empty slot, exact
   approved nonce, approval binding, and workflow state.
2. Resolve and decrypt only the selected Vex EVM wallet and pending Lighter key.
3. Sign the human-readable ownership message locally and build the official
   TxType 8 transaction.
4. Persist the transaction hash and expiry before calling `sendTx`.
5. Read the exact slot. A different public key is a conflict and never activates
   the local credential; an uncertain send is reconciliation-only and is never
   blindly resubmitted.
6. Derive the public key again from the encrypted key, require exact live match,
   run the official `CheckClient`, require next nonce `approved + 1`, then mark
   the database lifecycle ready and promote the vault marker to
   `key_registered_active`.

Pending keys use `key_generated_pending_registration` and are excluded from
trading credential listing and order-signing reads.

Lighter Core reports a missing exact API-key slot as HTTP `400` with the exact
provider message `api key not found`, rather than as an empty successful list.
Only the key-registration exact-slot preflight interprets that precise response
as vacancy; unrelated `400` responses still fail closed before wallet access.

## Milestone 8 Execution Boundary

The execution architecture boundary is documented and code-guarded. The preview
gate may feed an exact matching order, but no order can be sent unless the
prepared approval card is approved and the configured privileged execution
dependencies are available. This is not itself live order proof:

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
- Trading credentials must enter signer code only through an opaque
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

- Before signing, the live create path reads the exact registered public key and
  `/nextNonce`, derives a ten-minute account auth token with the official signer,
  matches the derived key to the provider key, and verifies authenticated active
  orders, inactive orders, and trades for the target account and market. It also
  rejects existing order or trade evidence for the same Vex client order id.
  Any failure stops before nonce reservation, signing, or `sendTx`.
- After `sendTx` code `200`, Vex records `api_accepted`, immediately moves the
  intent to `sequencer_pending`, then performs bounded authenticated active-order
  polling before checking inactive orders and account trades for the exact Vex-assigned
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
- `trading-credentials.ts` validates
  `(environment, accountIndex, apiKeyIndex, vaultCredentialId)` and returns the
  exact nonce scope. Only the injected privileged vault reader can resolve that
  opaque reference into private-key material.
- The only acceptable secret source is the encrypted local vault. The agent
  layer may hold an opaque vault id, but not key bytes,
  signatures, auth tokens, or signed payload JSON.
- The create path combines a fresh preview match, user approval,
  credential readiness, nonce reservation, durable activity intent, privileged
  signing, provider submission, and provider/WebSocket outcome reconciliation in
  that order.
- `execution-plan.ts` is the current ready-for-signer boundary. It accepts only
  an approved, unexpired, session-scoped durable intent whose opaque vault
  reference still matches the preview-bound environment/account/API-key scope.
  It refuses intents that are unapproved, already advanced, expired, nonce
  reserved, or credential-scope mismatched.
- `trading-secret.ts` defines the private-key material boundary for the
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
  echoing secret material. Approved `lighter.order.create` invokes this reader
  only after live public credential reads pass.
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
- `signer-adapter.ts` maps an unsigned create-order request plus privileged
  private-key material and an explicit nonce into the exact signer input
  envelope: REST base URL,
  chain id (`304` Core, `466324` RHC), account/API-key scope, nonce, and order
  fields. It validates the official integer ranges before any native
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
  payload material. This client method is reachable from agent order handlers
  only after exact approval resumes the privileged execution path.
- `order-create-execution.ts` is the only reviewed agent-side owner of the
  live create path. It is dependency-injected by the Vex main process
  with the unlocked-vault secret reader, packaged signer adapter, and Lighter
  client. Its order is: exact live key and next-nonce reads, vault
  key load, official-signer account auth, registered-public-key match,
  authenticated duplicate/readiness preflight, durable nonce observation and
  reservation, local order signing, signed-state persistence, submitted-state
  persistence before `sendTx`, API acceptance persistence, and bounded provider
  outcome reconciliation. It returns only bounded hashes/status metadata, never
  key bytes, account auth tokens, or `tx_info`.
- `lighter_order_execution_intents` stores the durable bridge between a preview
  and the signer path. It records preview identity fields,
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
  local Lighter execution intent, builds the signer-bound execution plan and
  unsigned create-order request, then continues through live revalidation,
  privileged secret loading, local signing, and provider submission.

Milestone 8 S1/S2 are closed for the documented execution boundary and
code-level guardrails: create remains approval-gated, cancel surfaces are not
registered, and submit/signing behavior remains isolated in the privileged
runtime. Live order proof belongs to the approval-gated create milestone.

Nonce foundation now has durable storage in `lighter_nonce_state` and an
internal public nonce sync helper:

- The state key is `(environment, accountIndex, apiKeyIndex)`.
- Provider nonces are stored as decimal strings after a safe-integer check. If a
  provider nonce cannot be represented exactly from the current JSON response,
  Vex refuses to reserve it rather than sign with an imprecise value.
- Preview-time `recordObserved` updates only rows that are still `observed`; it
  does not overwrite an in-flight reservation. Execution-time
  `recordExecutionObserved` may clear an unresolved reservation only after the
  live `/nextNonce` value strictly advances beyond the reserved nonce.
- `reserveObserved` is a compare-and-set transition from `observed` to
  `reserved`, copying `provider_nonce` into `reserved_nonce` and attaching a
  reservation id before the signer path can consume it.
- The status vocabulary includes `submitted` and `ambiguous` for the order path,
  so a lost response or sequencer uncertainty can be tracked without
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

## Milestone 4 Auth Boundary (REMOVED)

**Removed.** The standalone pasted read-only auth token described in this
section (`credentials.ts`, `auth-token.ts`, the `LIGHTER_CORE/RHC_READ_ONLY_AUTH_TOKEN`
vault secrets, `LighterClient`'s implicit fallback when no `privilegedAuth` is
supplied) was deleted: it was a manually-pasted, never-regenerated credential
with no mint/rotation path in Vex, and a stale one silently caused
`lighter.withdraw.prepare` and other privileged reads to fail closed with a
misleading "vault is locked" message instead of a token error — even while the
vault was genuinely unlocked and the real trading credential was registered
and active. All privileged read-only auth is now always derived fresh from the
saved trading credential via the local signer
(`deriveLighterReadOnlyAccountAuth`); there is no more BYOK read-only-token
path. The rest of this section is kept as a historical record of what Milestone
4 verified live against Lighter — the endpoint auth classifications below are
still accurate, only the token-acquisition mechanism is gone.

Milestone 4 was the read-only credential and request boundary, not account-tool
activation and not trading. It used Lighter read-only auth tokens only:
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
registered as read-only, approval-preparation, or approval-resume surfaces. The
execution resume targets are exact-intent bound and reachable only from trusted
host approval follow-ups with configured privileged dependencies.

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
| `lighter.order.create` | exact approved intent, privileged runtime dependencies | Revalidates live state, signs locally, submits, and reconciles only after trusted host approval |
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

The classifications below are a historical live-verification record from
Milestone 4 (now removed, see above). The auth *requirement* per endpoint is
still accurate; the read-only-token *mechanism* used to prove it no longer
exists in the codebase, and the `pnpm run lighter:probe:auth*` scripts /
`test:lighter:live:auth*` tests referenced below were removed with it.

Which account endpoints require a credential is live-verified per endpoint, not
inferred from the docs. Lighter's behavior is not uniform, and two endpoints
that look equally account-scoped can sit on opposite sides of the auth line.

Full Core and RHC classifications were verified on 2026-08-10 with real
read-only tokens through the now-removed
`pnpm run test:lighter:live:auth:prompt` command. The removed
`pnpm run lighter:probe:auth` command used to exit non-zero when that historical
proof was incomplete; it is not a current verification command.

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

The probe scripts that used to regenerate this matrix (`pnpm run
lighter:probe:auth`, `lighter:probe:auth:public`) were removed along with the
read-only-token mechanism they depended on.

## Verification

- Client foundation: `pnpm test src/__tests__/lighter/lighter-client.test.ts src/__tests__/lighter/lighter-throttle.test.ts`
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
- Live read-only auth proof (REMOVED): `test:lighter:live:auth` and
  `test:lighter:live:auth:prompt` were deleted along with the read-only-token
  mechanism they proved. Privileged account reads (open orders, order history,
  trades) are now verified through the signer-derived auth path exercised by
  `lighter-order-repair.test.ts` / `lighter-handlers.test.ts` instead.

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

2026-08-13 local time: direct read-only production calls to Core and RHC
`/api/v1/nextNonce` and `/api/v1/apikeys` returned `code=200`. Core account `1`,
API-key `0` reported next nonce `1`; RHC reported next nonce `0`. The all-key
reads returned real registered public-key and transaction-time records on both
venues. This proves the current public contracts used by the just-in-time nonce
and registered-key preflight. It does not prove signing, authenticated reads
with the user's encrypted trading key, `sendTx`, sequencer acceptance, or an
order outcome; those require the user's exact preview and approval through the
privileged live create path.

2026-08-17 local time: the controlled wallet-funded Phase 3 registration exit
gate passed on Lighter Core account `737810`, API-key index `4`. Vex generated
and encrypted the key locally, obtained a separate user approval, and submitted
TxType 8 hash
`c6ee84c955a5876901a30679d0074dbfcf13fed4121b79b5169d329a26af99f0cfe8eaabced45e19`.
The exact public slot matched the vault-derived key, official `CheckClient`
passed, public and durable next nonce synchronized to `1`, the vault marker
became active, and the workflow reached `ready_to_trade`. The Lighter dashboard
was not used to create, copy, or manually enter an API private key.
