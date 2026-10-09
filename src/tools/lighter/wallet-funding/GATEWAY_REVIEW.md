# Lighter gateway compatibility review — 2026-10-09

This review covers the implementation replacements used by Vex's existing
deposit, secure withdrawal and separately approved manual claim paths. It is
an integration compatibility review, not a security audit of the entire rollup.
Unexpected future implementations must continue to fail closed.

## Reviewed deployments

| Environment | Settlement chain | Gateway proxy | Reviewed implementation |
| --- | --- | --- | --- |
| Core | Ethereum, 1 | `0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7` | `0xE16c893252616dD49913969f145e733b96a3E5A7` |
| RHC | Robinhood Chain, 4663 | `0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d` | `0x998ecf039Eb110b72F5F6C1Ea31C2fA41a458FAA` |

Both EIP-1967 implementation slots were read from live settlement RPCs. The
proxy addresses are unchanged. Lighter signing domains remain 304 for Core
and 466324 for RHC; they are distinct from settlement chain IDs.

## Source and deployed code

Core's 22-file verified source package was retrieved from
[Etherscan](https://etherscan.io/address/0xE16c893252616dD49913969f145e733b96a3E5A7#code).
RHC's 22-file package was retrieved as a FULL match from Blockscout's public
Verifier Alliance lookup, using chain 4663, the implementation address and live
deployed bytecode. The corresponding
[explorer contract](https://robinhoodchain.blockscout.com/address/0x998ecf039Eb110b72F5F6C1Ea31C2fA41a458FAA?tab=contract)
identifies the same deployment.

Lookup API and schema:

- `POST https://eth-bytecode-db.services.blockscout.com/api/v2/bytecodes/sources:search-all`
- Fields: `bytecode`, `bytecodeType: "DEPLOYED_BYTECODE"`, `chain`, `address`.
- [Public API schema](https://github.com/blockscout/blockscout-rs/blob/main/eth-bytecode-db/eth-bytecode-db-proto/proto/v2/eth-bytecode-db.proto).

Both source packages were compiled with Solidity `0.8.25+commit.b61c2a91`,
IR compilation enabled, Cancun EVM and optimizer enabled with 1,000 runs.
After filling only the compiler-declared implementation self-address immutable
references, **all deployed bytes matched, including compiler metadata**.

| Environment | Gateway runtime bytes | Gateway runtime SHA-256 |
| --- | ---: | --- |
| Core | 24,421 | `fff5973a2c29db16274ae8cf6d7995a8aad21fd019278542a931141e3646092c` |
| RHC | 23,007 | `b147bf928682b2afc2dfb37fc730569630a96cd1d91e44240c2d96c2abe8f2ae` |

The live delegated deposit implementation was read from storage slot 7 in
each proxy, as defined by the reviewed Storage layout. Its complete runtime
also matched compilation of the corresponding `AdditionalZkLighter` source:

| Environment | Additional implementation | Runtime SHA-256 |
| --- | --- | --- |
| Core | `0xE1A19e35320218E41526ad619cf55985cfF20810` | `5f9a3fae9e27cfddc665f3f171fd63159638ecc034e28c37bcaa503aac1e3387` |
| RHC | `0x8E1aF081a30C5d632999b8ECA8438B911a4670EB` | `7d58e08189d6eb5871a4e8cb5eb8664ef441cca0a4d5070bf42c84b3a9cd3400` |

## Compatibility findings

- Compared with each previously reviewed implementation, Storage and
  ExtendableStorage source are unchanged. Deposit amount, beneficiary,
  ERC-20 transfer, cap, tick-size and minimum checks remain compatible.
- Core adds governance pause checks to batch processing and outbound transfers.
  RHC factors validator checks into a helper. Upgrade initialization commitments
  changed in both environments. These changes do not require new Vex calldata.
- Additional logic changes include public market index handling and a sentinel
  for registering the caller's master-account trading key. Vex's
  deposit ABI and explicit-account key-registration ABI remain available.
- `deposit(address,uint16,uint8,uint256)` remains `0x8a857083`;
  `withdrawPendingBalance(address,uint16,uint128)` remains `0x2f25807e`.
  Asset configuration, token mapping and pending-balance read interfaces match
  Vex's existing ABI. Perps route 0 and settlement asset index 3 are unchanged.
- Live Lighter metadata and chain reads confirm Core USDC and RHC USDG,
  six decimals, enabled withdrawals and the one-unit deposit minimum. RHC's
  pinned USDG token implementation and allowance storage slot remain unchanged.

Migration 177 adds only these reviewed gateway replacements to the existing
environment-specific withdrawal and claim constraints. Prior reviewed
implementations remain valid for historical records. New preparations and
trusted follow-ups accept only the current application pin; existing approvals
are never retargeted. Fresh pre-sign reads must still match the approved public
snapshot and exact calldata.

Verification includes live Core and five-USDG RHC deposit preparation and simulation, both
environments' funding/withdrawal identity checks, and a populated PostgreSQL
upgrade preserving historical records. These review checks did not sign or
submit a transaction. The subsequent owner-approved desktop deposit is
documented below.

The RHC preparation canary is opt-in: set
`VEX_LIGHTER_DEPOSIT_PREFLIGHT_LIVE=1` and
`VEX_LIGHTER_RHC_PUBLIC_FUNDED_WALLET` to a public funded EOA, then run
`src/__tests__/lighter/lighter-live-deposit-preflight.test.ts`. The address must
have at least 5 USDG and enough native gas. No signer is involved.

## Desktop RPC verification follow-up

The owner's first approval test passed deposit preparation but failed the fresh
pre-sign read. The durable intent records no token-approval or deposit hash.
Repeating the preparation-to-pre-sign read sequence in Electron reproduced the
failure: Node HTTP received a Cloudflare 403 challenge from the official
Robinhood RPC while Electron native HTTP received valid chain-ID responses.

Desktop startup now installs a native HTTP adapter only for the exact public
`https://rpc.mainnet.chain.robinhood.com/` URL. Other endpoints, including user
URLs with credentials or query parameters, retain their existing transport.
The adapter omits cookies and refuses redirects. The RPC owner still chooses
and verifies the endpoint, paces requests, and keeps signing pinned to that
same node with zero broadcast retries. Pinned transports capture their HTTP
adapter; runtime cleanup cannot rotate an existing execution's adapter.

Two live read-only sequences using the affected wallet's public address passed
both preparation and fresh pinned pre-sign checks for exactly five USDG, with
zero existing allowance and the required allowance simulation. The canary
compiled the real production preflight and main-process adapter and used real
Electron networking. It created no intent or approval and signed or submitted
no transaction.

## Funded desktop deposit and confirmation race

On 2026-10-09 the owner approved a real five-USDG RHC deposit in the desktop
app. The settlement receipt proves the exact gateway, wallet, asset, route and
amount. Lighter's live transaction and account APIs prove the same deposit
executed and was credited; the local intent and activity record were reconciled
without another submission. The owner also verified the resulting portfolio.

Execution initially reported a durable confirmation conflict. A disposable
PostgreSQL regression reproduces this when the evidence-only repair sweep
commits confirmation before the executor finishes waiting for its receipt.
Deposit confirmation now accepts the already-committed result only when every
L1 evidence field matches. A pending confirmation also requires the same
active workflow in `deposit_l2_pending`; an already-credited result requires
the persisted executed Lighter evidence. This read does not repeat a workflow
transition, overwrite a later deposit's workflow, downgrade a credit or
authorize another broadcast.

All six Core/RHC confirmation and credit interleavings failed before the repair
and pass afterwards against real PostgreSQL, including repriced deposits.
Mismatched hashes, blocks, accounts, wallets, assets, routes and amounts remain
refused; incomplete pending workflows remain refused. The original receipt,
credit and transaction-staging checks remain in place.
