# Vex → Lighter Wallet-Funded Trading Flow

## Objective

Allow a user with no existing Lighter account to enable the Lighter integration,
fund a new account from their Vex wallet, generate and register a Lighter API key
locally, and become ready to trade without copying credentials from the Lighter
dashboard.

The user remains self-custodial throughout:

- Wallet and Lighter API private keys never leave the privileged local process.
- Enabling the integration does not itself move funds or authorize future trades.
- Every fund-moving action remains bound to an exact, user-reviewed approval.
- No workflow is considered complete from an L1 receipt alone; Lighter-side
  evidence must confirm the corresponding L2 state.
- Ambiguous outcomes block retries until reconciliation proves what happened.

## Target lifecycle

```text
integration_enabled
  → deposit_approval_pending
  → deposit_preflight_validated
  → allowance_verified
      OR approve_staged → approve_confirmed
  → deposit_staged
  → deposit_l1_confirmed
  → deposit_l2_pending
  → account_resolved
  → key_generated_encrypted
  → key_registration_approval_pending
  → change_pub_key_submitted
  → key_verified
  → nonce_synchronized
  → ready_to_trade
```

Any broadcast-capable state can transition to `ambiguous`. An ambiguous workflow
must be reconciled before Vex permits another deposit or key registration for the
same environment, wallet, and account.

---

## Phase 1 — Activation, durable workflow, and safety foundation

**Status:** Implementation and Phase 1-focused verification completed on
2026-08-17. Its approval, durability, execution-lease, and reconciliation
boundaries remain the foundation for the now-completed deposit and key-registration
legs. Broader production acceptance is tracked in Phase 4.

### Goal

Create the non-fund-moving integration toggle and the durable, fail-closed state
machine required by every later phase. Close the known lifecycle holes before a
wallet key can reach a deposit signer.

### Work

1. Add a user-level Lighter integration setting containing only public scope:
   environment, selected wallet address, enabled/disabled state, and timestamps.
   The toggle must not count as approval for a deposit, key registration, order,
   transfer, or withdrawal.

2. Define one durable onboarding workflow keyed by environment and wallet, with
   explicit states for deposit, account resolution, key registration, readiness,
   failure, and ambiguity. Persist structural evidence only—never private keys,
   signatures, auth tokens, or signed payloads.

3. Add a partial uniqueness constraint that prevents more than one unresolved
   onboarding/deposit workflow for the same environment and wallet.

4. Add a repository API where every state transition is a checked CAS. A null or
   rejected transition must abort the operation. In particular, a failed
   transaction-hash staging write must throw before broadcast.

5. Model allowance reuse explicitly with `allowance_verified`; do not represent
   a skipped approval as a submitted and confirmed approval transaction.

6. Register `lighter.deposit` as a trusted prepare → execute follow-up with its
   own intent-id grammar, exact critical-argument allow-list, canonicalization,
   expiry validation, and adversarial tests.

7. Classify the deposit as `user_wallet_broadcast` so the approval card receives
   high-risk treatment and two-step confirmation. Add deposit-specific labels and
   human-readable amount, wallet, network, contract, destination, and fee fields.

8. Include unresolved Lighter onboarding rows in the compaction money-state gate.
   Perform all session-scoped lifecycle writes under the session control lock,
   without holding that lock across provider, wallet, or signing calls.

9. Add a separate DB-backed EVM execution lease keyed by chain ID and wallet
   address so concurrent sessions cannot allocate the same pending nonce.

10. Add `lighter.deposit.status` plus a startup/background reconciliation sweep.
    The repair path may retry reads, but must never automatically rebroadcast an
    ambiguous transaction.

### Verification

- Unit-test every valid and invalid state transition.
- Test registry acceptance for deposit follow-ups and rejection of altered
  amounts, destinations, contracts, intent IDs, and extra arguments.
- Test CAS failure injection at every pre-broadcast hook.
- Test two sessions preparing deposits for the same wallet concurrently.
- Test compaction interleavings against every unresolved onboarding state.
- Restore clean TypeScript, lint, discovery-contract, and desktop test gates.

### Exit gate

Phase 1 is complete only when an enabled integration can prepare a deposit
approval, but no code path can sign or broadcast without an exact approval,
checked durable state, privileged execution dependencies, and wallet nonce lease.

---

## Phase 2 — Deposit, L2 credit proof, and account resolution

### Status — implementation complete; live canary user-confirmed 2026-08-18

The exact deposit-evidence slice is implemented and verified. Vex now obtains
the new `account_index` from the specific L1 `Deposit` event, rather than from
account-list ordering, and requires the exact L1 hash to resolve to an executed
Lighter deposit with matching fields and a uniquely wallet-owned master account
before persisting `credited`. The production repair path is evidence-only and
never signs, broadcasts, retries, or creates replacement transactions. It can
observe and persist only an exact same-calldata fee repricing within the
original approval ceiling.

Preparation also now reads and persists the live Ethereum chain/block, selected
wallet's USDC and ETH balances, exact gateway allowance, Lighter's current
gateway/USDC metadata, exact headroomed gas limits, and EIP-1559 maximum-fee
exposure for every required leg. It binds the snapshot and an explicit native
safety reserve into the approval contract. The provider-backed read, including
the dependent deposit estimate under an exact USDC allowance state override,
has passed against real Ethereum and Lighter Core.

Immediate public-only revalidation runs before lease/key resolution and beside
each signer leg; the
serialized EIP-1559 transaction cannot exceed any approved gas or fee ceiling.
Replacement observations preserve the original hash/sender/nonce, accept only
exact fee-only repricings, and expose both identities in status. The repair
sweep rechecks the canonical Ethereum receipt before any Lighter credit and
moves disappeared or contradictory evidence to durable ambiguity. The
permanent code safety boundary remains enforced because these checks are verified.

A read-only canary-readiness command discovers Lighter's exact live USDC
minimum, caps Phase 2's first deposit at one USDC, and proves the selected
wallet's live balances, allowance, gas limits, fee ceiling, and reserve without
loading a signer or broadcasting. It passed against live Ethereum and Lighter
Core at the current 1 USDC minimum. On 2026-08-18, the user reported that the
separately approved one-USDC mainnet canary, exact L1 transaction verification,
Lighter L2 credit proof, wallet-owned account resolution, restart/reconciliation
exercise, key registration, and tiny approved order all completed successfully.
This document does not invent or embed transaction/account identifiers that were
not supplied in this session; attach the retained provider and durable evidence
before using this note as an external release attestation.

### Goal

Safely approve and deposit Ethereum-mainnet USDC, prove that Lighter processed the
specific L1 transaction, and persist the newly created `account_index`.

### Work

1. At preparation time, read live:
   - Ethereum chain ID and selected wallet address.
   - USDC address, decimals, balance, and current allowance.
   - Lighter gateway address from the live information endpoint.
   - USDC asset index from `assetDetails`.
   - Estimated gas and maximum fee exposure for both approval and deposit.
   - ETH balance sufficient for every required L1 leg plus a safety reserve.

2. Persist the exact preflight snapshot used by the approval disclosure. Pin the
   deposit recipient to the selected Vex wallet and reject any contract, chain,
   asset, route, or destination mismatch.

3. Immediately before signing, re-read chain, wallet, balances, allowance,
   contract, asset metadata, and fee exposure. Fail closed if the
   approved intent has expired or material state has drifted.

4. If allowance is insufficient, approve only the exact required amount. Stage
   hash, sender, chain, and nonce durably before broadcast; wait for a guarded
   receipt and retain its block hash/number.

5. Revalidate the deposit after approval. Estimate the dependent deposit leg
   using the confirmed approval receipt where necessary, then stage and broadcast
   it with the same durability rules.

   Vex may reissue a fresh approval only when the durable intent proves that neither
   transaction was staged, signed, submitted, replaced, or evidenced on L1/L2.
   The original approval stays in the audit trail, fresh live preflight must fit
   both transaction ceilings, and the new approval must bind to the exact intent
   before execution. Any staged transaction identity remains reconciliation-only.

6. Treat a successful Ethereum receipt as `deposit_l1_confirmed`, not `credited`.
   Poll with bounded backoff for the exact L1 hash through Lighter's
   `txFromL1TxHash`/deposit evidence and remain `deposit_l2_pending` until proven.

7. After L2 credit, resolve accounts owned by the wallet's L1 address. Verify the
   account owner, select the newly created/master account deterministically, and
   persist its `account_index`. Do not blindly trust the first array element when
   more than one account or subaccount exists.

8. For an existing account, prove the new deposit independently of account
   existence by matching the L1 transaction and expected amount and/or a bounded
   collateral delta.

9. Surface honest operator states: awaiting Ethereum confirmation, awaiting
   Lighter credit, credited, reverted, ambiguous, and reconciliation required.

### Verification

- Mainnet-fork tests for allowance, exact approval, calldata, insufficient USDC,
  insufficient gas, changed gateway metadata, reverts, and concurrent nonces.
- Real-Postgres crash tests before and after each stage, broadcast, and receipt.
- Provider fault tests for timeout-before-send, timeout-after-send, delayed
  receipt, reorg/replacement, Lighter 429 responses, and delayed L2 credit.
- Lighter testnet proof where the deposit bridge is available.
- No mainnet claim of completion until a tiny canary proves the exact L1 hash was
  credited to the expected account index.

### Exit gate

Phase 2 is complete when Vex can prove, recover, and display the full chain of
evidence from exact user approval through L1 execution to Lighter L2 credit and a
verified wallet-owned account index.

---

## Phase 3 — Local API-key generation and L2ChangePubKey registration

### Goal

Create a Lighter trading credential entirely on the user's device, register it on
the newly created account, and never expose or orphan its private key.

### Work

1. Fetch all API-key slots for the resolved account and select an unused index
   conservatively from `4..254`. Reserve `(environment, account_index,
   api_key_index)` transactionally so concurrent onboarding attempts cannot pick
   the same slot.

2. Generate a standard Lighter API keypair inside the privileged main process or
   pinned signer helper. Never generate it in the renderer or agent/tool layer.

3. Before submitting registration, encrypt and durably store the private key in
   the local vault with state `key_generated_pending_registration`. Persist only
   a credential reference, public key, account index, API-key index, and lifecycle
   metadata outside the vault. This prevents a crash after registration from
   creating an unrecoverable/orphaned key.

4. Prepare a security-sensitive registration approval showing wallet, Lighter
   environment, account index, API-key index, public-key fingerprint, and the
   authority being granted. Registration may be composed into a clearly disclosed
   onboarding approval, but must never be inferred silently from the toggle.

5. Revalidate account ownership, slot availability, public key, vault credential,
   and workflow state immediately before signing.

6. Build the exact `L2ChangePubKey` transaction. Have the Vex wallet sign the
   human-readable L1 ownership message locally, submit the resulting L2
   transaction through Lighter `sendTx`, and persist its structural transaction
   identity before submission. Do not store the L1 signature or signed payload.

7. Reconcile ambiguous submissions by reading the exact API-key slot. Never
   resubmit until the registered public key is proven absent.

8. Verify that the live public key at `(account_index, api_key_index)` exactly
   matches the vault-derived public key. Any other registered key is not evidence
   that Vex controls a trading credential.

9. Run the SDK `CheckClient` equivalent and fetch the next nonce. Mark the local
   credential active only after public-key match, signer check, and nonce sync all
   succeed.

10. Restrict the production signer helper to a packaged, integrity-verified
    executable. Development path overrides must be unavailable in production.

### Implementation status — 2026-08-17

Phase 3 is live-complete on `Lighter-Integration`. The code path includes full-slot
reservation, privileged key generation and encrypted pending storage, exact
approval binding, offline TxType 8 signing, structural pre-submit identity,
privileged execution, evidence-only ambiguity reconciliation, exact public
key comparison, official `CheckClient`, nonce `+1` synchronization, and vault
activation. The separate `lighter.key.register.status` path cannot sign or call
`sendTx`.

The controlled live exit gate passed on Lighter Core account `737810`, reserved
API-key index `4`. Lighter accepted TxType 8 transaction
`c6ee84c955a5876901a30679d0074dbfcf13fed4121b79b5169d329a26af99f0cfe8eaabced45e19`.
The exact public slot matched the vault-derived key, the official `CheckClient`
passed, the public and durable post-registration nonce synchronized to `1`, and
the workflow reached `ready_to_trade`. The private key remained encrypted in
the local Vex vault; no dashboard API-key entry or credential copy/paste was
used.

### Verification

- Deterministic key-generation and public-key derivation tests without printing
  private material.
- Vault lock/unlock, restart, corruption, and crash-after-encryption tests.
- Concurrent API-key-index reservation tests.
- Adversarial ChangePubKey approval-binding tests.
- Crash and ambiguity tests before signing, after signing, after submission, and
  before final verification.
- Testnet registration followed by an exact public-key match and `CheckClient`.
- Rotation and orphaned-pending-key recovery tests.

### Exit gate

Phase 3 is complete only when Vex holds an encrypted local private key, Lighter
shows the matching public key at the reserved account/index pair, the signer check
passes, and the nonce is synchronized. A generic non-zero key on the account is
never sufficient.

---

## Phase 4 — Ready-to-trade orchestration and production hardening

### Goal

Compose activation, deposit/account creation, key registration, and the existing
order path into one resumable user experience, then prove it safely in production.

### Work

1. Build a state-driven onboarding orchestrator that reads current evidence and
   runs only missing legs. It must resume after restart and remain idempotent:
   - Existing L2 credit skips deposit.
   - Existing verified Vex key skips registration.
   - Ambiguous state routes to reconciliation, never a new write.

2. Define `ready_to_trade` as all of:
   - Integration enabled for the selected wallet/environment.
   - Verified wallet-owned account index.
   - Required collateral available on Lighter.
   - Encrypted local API private key present.
   - Exact live public-key match.
   - `CheckClient` success.
   - Current nonce synchronized and reservable.

3. Connect the ready credential to the existing Lighter preview → exact approval
   → pre-submit revalidation → sign → submit → reconcile order flow. The integration
   toggle must not bypass per-trade approvals under the current product policy.

4. If "funds in Vex" includes native ETH rather than mainnet USDC, add the
   acquisition leg as its own separately approved milestone: quote ETH→USDC, reserve
   gas for all later legs, obtain approval, execute, verify received USDC, and then
   recompute the onboarding plan.

5. Add a user-facing status surface with precise states and recovery actions,
   including integration disabled, funding required, deposit pending, Lighter
   credit pending, key registration pending, ready, and reconciliation required.

6. Add structured, secret-free observability for lifecycle transitions, latency,
   provider rate limits, receipt ambiguity, and reconciliation results. Never log
   wallet keys, API keys, auth tokens, signatures, or
   signed payloads.

7. Keep exact user approvals independent for deposit, key registration,
   acquisition, trading, and withdrawal. Do not add operator environment gates,
   wallet allowlists, rollout caps, or kill switches to these approved flows.

8. Triage production dependency advisories and restore a reproducible install
   using the repository's pinned package-manager version before packaging.

9. Execute production validation in order:
   - Unit/property and real-Postgres lifecycle suite.
   - Mainnet fork and Lighter testnet.
   - Dedicated-wallet tiny mainnet deposit canary.
   - Key registration and signer verification canary.
   - Tiny approved order and order reconciliation.
   - Restart/recovery exercise with funds still observable.
   - User-focused production validation and monitored expansion.

10. Keep withdrawal as a separate security project and approval surface. Lighter
    API keys have withdrawal authority, but no withdrawal path may be reachable
    from integration, deposit, key-registration, or trade approval alone.

### Phase 4 implementation status — started 2026-08-18

The first Phase 4 hardening slice is implemented and verified. The managed
onboarding status path no longer treats a saved credential scope plus an
arbitrary nonzero live key as sufficient for `ready_to_trade`. Its privileged
main-process readiness resolver now requires all of the following at read time:

- an active Vex-managed credential marker in the unlocked encrypted vault;
- the durable key-registration lifecycle in `active`, including recorded
  official client-check, nonce-synchronization, and activation evidence;
- the exact live account/API-key slot to match the registered public key;
- a fresh official `CheckClient` result derived inside the privileged process;
- the exact slot nonce and `nextNonce` to agree; and
- no unresolved local nonce reservation, submission, or ambiguity blocking the
next reservation.

Nonce blockers are returned as `reconcile_order_state` with an evidence-only
`lighter.order.status` action, while key/provider inconsistencies return
`reconcile_trading_access`. Neither case is mislabeled as a request to register
a replacement credential.

The agent-facing result contains only boolean readiness checks and a bounded
reason; private key material stays inside Electron main. A missing resolver,
provider failure, live-key drift, client-check mismatch, stale nonce, or held
reservation reports not ready. Focused verification passed 48 Lighter handler
tests and four privileged readiness tests. Root TypeScript and production builds,
the Electron main production build, and the process-boundary check passed.
The desktop repository's broader pre-existing type baseline remains separate
from this slice.

The second Phase 4 slice adds automatic crash recovery for stranded order nonce
reservations. App startup and a durable five-minute periodic job inspect at most
five unresolved intents per pass using Lighter's public `nextNonce` endpoint.
The unattended worker can reset a reservation after the live nonce proves it
was consumed, release an operation durably proven never submitted, or reject an
expired create whose nonce is still unconsumed. It never infers the order's
provider outcome from nonce movement alone.

This background path is intentionally separate from the full
`lighter.order.status` evidence flow. It cannot derive account authorization,
unlock the vault, sign, submit, retry, or call authenticated active/inactive
order and trade endpoints. Lighter documents `nextNonce` at request weight 6
and inactive-order history at weight 100, so the automatic lane is bounded to
public nonce evidence instead of turning every unresolved row into aggressive
high-weight history polling. Full terminal classification remains user-driven
until the production order stream lands.

Verification passed 56 focused repair/scheduling/dispatcher tests, root
TypeScript and production builds, the Electron main production build, and the
Electron process-boundary check. Direct read-only production calls through the
shipped client returned `code=200` from Core and RHC `/api/v1/nextNonce` on
2026-08-18. No credential, signer, signature, signed payload, `sendTx`, order,
cancel, deposit, transfer, or withdrawal was used for that live proof.

The third Phase 4 slice originally added temporary operator rollout controls for
deposits. On 2026-08-18 those controls were removed from preparation and
execution: there is no deposit environment flag, wallet allowlist, rollout cap,
or operator kill switch. Exact user approval, live preflight, fee ceilings,
wallet ownership, nonce leasing, durable transaction staging, and evidence-only
ambiguity recovery remain mandatory.

The fourth Phase 4 slice hardens the root production dependency and install
boundary. CI and every release build now fail before installation unless Node
satisfies the declared minimum and pnpm is exactly the repository-pinned
`10.32.1`. The root lockfile was regenerated with that version, cleanly passes
`--frozen-lockfile`, and explicitly allows only esbuild's required install
script. Optional and nonessential install scripts remain disabled, including
the unpatched `bigint-buffer` native binding.

Compatible transitive pins removed 42 of the 44 root production advisories.
The two remaining Solana paths are not mislabeled as fixed. They are exact,
machine-checked exceptions with a mandatory 2026-09-18 review:

- `bigint-buffer@1.1.5` has no patched upstream release. Vex reaches it through
  fixed-width SPL layouts that slice 8-to-32-byte inputs before conversion, and
  its native binding is not allowed to build.
- `uuid@8.3.2` is owned by Jayson. Jayson imports UUID v4 only; the advisory is
  specific to v3/v5/v6 calls with caller-provided output buffers.

The audit gate rejects any new advisory as well as a changed, stale, or expired
exception. Verification used supported Node 24 with pinned pnpm 10.32.1: frozen
install, exact production audit, root production build, Electron main build,
and process-boundary checks passed. The full root suite passed 12,988 tests;
the ten network-sandbox failures then passed all 82 tests when rerun with live
provider access. The separate Electron dependency tree still has two moderate
findings and remains the next dependency slice; this root slice does not claim
that desktop audit closed.

The fifth Phase 4 slice closes that desktop advisory gap. The direct Sentry
Electron dependency moved from 7.13 to 7.16, which removes the vulnerable
OpenTelemetry 2.6.1 HTTP-instrumentation chain. The Electron updater has an
explicit 6.8.9 security floor, its YAML parser is pinned to patched 4.3.1, and
the two Solana WebSocket paths have patched floors. Those constraints also
remove six advisories that were still present in the old committed desktop
lock. The desktop audit now has one finding: the same exact
Jayson-to-UUID-8.3.2 path already reviewed above. It is independently
machine-checked and expires on 2026-09-18. The desktop CI build, E2E job, and
release workflow now run this audit after frozen installation.

Verification on supported Node with pinned pnpm 10.32.1 passed the frozen
desktop install, audit, all 5,088 desktop tests, main/preload/renderer production
bundles, build-artifact checks, and process-boundary checks. A further 115
focused updater, Sentry-lifecycle, and Solana tests passed. The user's existing
compatible-package lock refresh was retained in the working tree and backed up
before Sentry resolution; the commitable security lock was generated separately
from the repository baseline so those unrelated refreshes are not silently
published. The aggregate desktop lint ratchet still reports six existing type
groups, now tracked as the next packaging slice rather than normalized into the
baseline.

The sixth Phase 4 slice restores the aggregate Electron type and packaging gate
on the refreshed dependency graph. The migration runner now contains the only
explicit bridge between the root and independently installed desktop
`@types/pg` package identities. Key-registration tests use the complete durable
lifecycle record and preserve the pending-registration state as a literal, and
the two renderer live-cache consumers use TanStack's supported updater form.
No new error was accepted into the ratchet baseline.

Verification on supported Node with pinned pnpm 10.32.1 passed 155 focused
migration, key-registration, updater, market, preload, and renderer tests. The
aggregate production command rebuilt all six packaged Lighter signer targets,
then passed the type ratchet, process-boundary checks, main/preload/renderer
bundles, CSP and renderer storage checks, migration mirroring, and artifact
validation. Three unrelated pre-existing type groups are now below their saved
baseline; the baseline was intentionally left unchanged so this compatibility
slice does not absorb unrelated work.

The seventh Phase 4 engineering slice adds the production order-outcome stream.
While the Vex vault is unlocked, Electron main discovers approved nonterminal
orders and opens one Lighter read-only `account_all_orders` subscription for
each exact environment/account scope. Account auth is derived only inside the
privileged process from the encrypted Vex-managed credential. Tokens,
credential identifiers, signatures, and signed payloads are never persisted or
included in diagnostics, and vault lock synchronously closes every authenticated
socket before asynchronous lock cleanup continues.

Inbound frames have strict byte and order-count limits and must match the
authenticated account plus each market-map key. Reconciliation matches the
lossless string `client_order_id`, serializes updates, and permits only guarded
monotonic durable transitions. Missing orders are never treated as filled,
canceled, or rejected. Because Lighter does not document a resumable cursor,
each successful connection performs one bounded active/inactive account-order
resnapshot and records that REST provenance separately from live stream
evidence. Connections enforce handshake timeout, application ping/pong,
staleness closure, bounded exponential reconnect, queue backpressure, and auth
rotation before the short-lived token expires. Explicit `lighter.order.status`
remains the user-controlled fallback.

Verification passed 560 root Lighter tests, all 5,100 desktop tests, the desktop
type ratchet and process-boundary check, root production build, and the full
Electron production build including all six packaged signer binaries and
artifact checks. The ten sandbox-blocked full-root live regressions passed all
82 tests with provider access. Direct Core and RHC production WebSocket
handshake/pong checks also passed. The authenticated subscription,
reconnect/resnapshot, and real terminalization exit proof still requires an
unlocked Vex session with a real approved watchable order, so Phase 4 S7 is not
yet labeled live-complete.

The eighth Phase 4 slice removes the temporary operator rollout layer from the
production Lighter path. Deposit preparation/execution, key registration, and
approved order creation no longer read or install release flags. The deposit
wallet allowlist, per-deposit cap, rolling-24-hour cap, and kill switch were also
removed. A source guard now prevents those obsolete environment variables and
dependency hooks from returning.

This change does not create blanket trading authority. Every fund-moving action
still requires its exact host approval, and the approved intent must pass fresh
wallet/account/market validation before the privileged process can load a key,
sign, or submit. Fee ceilings, wallet nonce leases, order nonce reservation,
durable pre-broadcast transaction identity, and evidence-only ambiguity recovery
remain enforced.

Verification passed the 492-test focused Lighter set, 24 real-PostgreSQL deposit
lifecycle tests, all 5,097 desktop tests, root and Electron production builds,
process-boundary and artifact checks, plus the full root suite with its 82
read-only live-provider tests rerun successfully with network access. No wallet
was unlocked and no transaction or order was signed or submitted.

The ninth Phase 4 slice makes trade-triggered funding deterministic. When the
user states a Lighter trade amount in USDC (including "USDC worth"), Vex passes
that amount into the live onboarding check and returns one explicit funding
decision:

- `ready` when current Lighter collateral already covers the request;
- `prepare_deposit` when the selected Vex wallet's Ethereum-mainnet USDC covers
  the exact collateral shortfall, raised to Lighter's one-USDC deposit floor;
- `insufficient_wallet_usdc` when directly depositable wallet USDC cannot cover
  the required deposit.

For `prepare_deposit`, the agent must prepare the exact shortfall in the same
turn so the host displays the deposit approval card. It must not ask "shall I
prepare" or require another chat confirmation. The card remains the only consent
surface: preparation does not sign or move funds, and only the trusted approval
resume can execute the deposit. The later trade remains a separate approval.

For `insufficient_wallet_usdc`, Vex must stop before preparation and show the
requested collateral, live Lighter collateral, selected-wallet USDC, required
deposit, and wallet USDC shortfall. ETH and other assets are not counted as
depositable USDC merely because they are present; acquiring USDC requires a
separate live quote and approval.

Verification covers the reported 2-USDC SUI case (1 USDC on Lighter and 2.07
USDC in the wallet produces an exact 1-USDC deposit preparation) plus insufficient
USDC and sub-minimum-gap cases. Seventy-six focused tests and a broader 371-test
Lighter suite passed, along with root type checking/build, Electron lint,
process-boundary checks, all production bundles, artifact validation, migration
mirroring, and all six packaged Lighter signer targets. The local shell warned
that its Node/pnpm versions are below the repository's declared versions; CI and
release remain responsible for the pinned toolchain gate. No wallet was unlocked
and no transaction or order was signed or submitted. A live app walkthrough of
the new funding-decision-to-card routing remains the acceptance proof for this
slice.

The tenth Phase 4 slice removes short-lived Ethereum gas quotes from Lighter
deposit consent. The approval card is now bound to the exact deposit amount,
selected wallet, settlement token, destination contract, and deposit-only
scope; it no longer displays or records gas limits, per-gas prices, maximum
network fees, native-fee reserves, or required ETH as approval fields.

After approval, Vex re-reads the live public preflight beside each signer leg
and signs with the current EIP-1559 fee estimate. Normal fee movement between
the card and execution therefore does not invalidate consent. A four-times
live-quote sanity boundary remains internal to the signer path only to reject
abnormal provider values; it is derived after approval and is not shown on or
bound into the card. Deposit amount, wallet, chain, gateway, asset, route, and
the possible addition of an ERC-20 approval transaction remain fail-closed.

The pristine approved-intent retry path now replaces stale public preflight
evidence before issuing its fresh approval card. This repairs the observed
case where fee movement stopped execution before signing or broadcast and the
same no-transaction intent then remained unresolved. Any staged transaction
hash or settlement evidence still blocks this retry and routes to
reconciliation.

Verification passed 107 focused approval/disclosure/execution/repository tests,
the broader 368-test Lighter and shared staged-signer set, root type checking
and production build, Electron type ratchet and process-boundary checks, all
production bundles, artifact validation, migration mirroring, and all six
packaged Lighter signer targets. The full root suite completed with 12,981
passing tests; its 13 failures were unrelated existing live-network and
manifest checks. The local shell remains below the repository's declared
Node/pnpm versions. No wallet was unlocked and no transaction was signed or
broadcast. A live approved deposit retry is still required as the acceptance
proof for this slice.

### Managed onboarding UX status — 2026-08-17

The normal-user entry path is implemented. Requests such as "set up my Lighter
account", "I need to trade on Lighter", and "I want to trade perps on Lighter"
first inspect the selected Vex wallet and compute only the missing onboarding
legs. If funding is required, Vex asks exactly how much USDC the user wants to
deposit. It activates the local integration from that explicit onboarding
intent and never asks the user to enable a Settings toggle.

Account indexes, API-key indexes, nonces, fingerprints, and locally encrypted
credential references stay internal. After exact deposit credit and wallet
ownership are proven, Vex prepares the remaining secure trading-access approval
using an automatically selected unused slot. The user is never sent to the
Lighter dashboard to create or copy an API key. Deposit and registration remain
separate approval-gated actions, and "ready to trade" requires both adequate
collateral and an active local credential whose saved account/slot is occupied
on live Lighter.

This completes the conversational abstraction and state-routing slice. The user
reported the controlled fresh-wallet real-money flow and tiny approved order as
successfully verified on 2026-08-18. Exact retained transaction/account evidence
still needs to be attached to the release record.

The pre-submit restart path is resumable without technical user input or
session affinity. A user may start a completely new chat with "I need to trade
on Lighter". After the user supplies the deposit amount, Vex may retire an older
session's deposit only when durable state proves no approval/deposit transaction
was staged or submitted and no L1/L2 settlement evidence exists. It then creates
a brand-new current-chat intent and approval atomically under deterministic
multi-session locks. The old approval is never rebound or reused, and stale
callbacks cannot revive the retired row. The user is never told to reopen an old
chat, retry an intent, or provide an intent ID, account index, or API-key index.
Any transaction identity or ambiguous evidence remains reconciliation-only.

### Verification

- End-to-end fresh-wallet test: enable → deposit → L2 credit → account index →
  local key → ChangePubKey → verification → tiny approved order.
- Restart the app at every lifecycle boundary and verify deterministic recovery.
- Exercise duplicate-click, concurrent-session, provider-timeout, stale approval,
  changed wallet, changed network, and missing privileged-dependency cases.
- Confirm renderer, transcript, logs, crash reports, database, and process
  environment contain no private key or signed-payload material.
- Prove the user can disable the integration without deleting recovery evidence or
  silently revoking/overwriting credentials.

### Exit gate

The flow is production-ready only after a fresh Vex wallet reaches
`ready_to_trade` and places a tiny approved order with end-to-end live evidence,
while restart, ambiguity, and reconciliation tests show that no action can be
duplicated or falsely reported as complete.

## Explicitly out of scope for these four phases

- Silent or blanket approval of future trades.
- Withdrawal bundled with onboarding or trading consent.
- Cross-chain funding routes beyond the separately approved acquisition milestone.
- Treating mocks, unit tests, an L1 receipt, or account existence as proof of L2
  credit or production completion.
