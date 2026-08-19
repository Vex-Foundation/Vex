# Morpho

EVM variable-rate lending. Two products under one namespace: **Blue markets**
(one loan asset borrowed against one collateral asset at a fixed liquidation
threshold, rates floating with utilization, no maturity) and **curated vaults**
(a curator spreads one asset across many markets and takes a fee from the
yield). Vex reads both, and executes on both.

This file is the map. It says how the lane works today, why the load-bearing
decisions were made, and what is deliberately absent so a later session does not
"fix" an intentional gap.

## Layout

| Where | What |
| --- | --- |
| `src/tools/morpho/` | Provider layer. GraphQL read client, on-chain reads, the mutation engine, market policy, decoders, allowance plan, preflight. Never imports `src/vex-agent`. |
| `src/tools/merkl/` | Merkl rewards provider. Morpho deprecated its own distributor, so reward claims go through Merkl. |
| `protocols/morpho/` (here) | Agent surface. Manifests, handlers, read-params, projectors. |
| `protocols/morpho/handlers/signed-broadcast*` | The one owning write module: sign, broadcast, record. Mirrors the Pendle shape. |

## Provider surface: APIs, SDKs, docs

| Surface | What | Where |
| --- | --- | --- |
| Morpho GraphQL API | All indexed reads (markets, vaults, positions, activity, curation) | `POST https://api.morpho.org/graphql`, configured in `src/tools/morpho/client.ts`; schema notes and probe dates in `src/tools/morpho/request/*.ts` headers |
| Morpho SDK | Mutation building via `getRequirements()` then `buildTx()`, client runs `supportSignature: false` | `@morpho-org/morpho-sdk@5.5.0` (direct dependency in root `package.json`) |
| SDK transitive packages | `MarketParams` and `blueAbi` come from `@morpho-org/blue-sdk@6.5.0` and `blue-sdk-viem`; contract addresses were extracted from `@morpho-org/morpho-ts@2.9.0` into `src/tools/morpho/constants.ts` with provenance comments; `@morpho-org/midnight-sdk@1.3.0` is installed as a transitive package and deliberately UNUSED (Midnight is out of scope) | imported in `src/tools/morpho/mutations/`, declared only transitively - a version bump of the root SDK can move them |
| Merkl API | Reward reads; Morpho deprecated its own URD, claims go through Merkl | `https://api.merkl.xyz` in `src/tools/merkl/constants.ts`; Distributor contract address pinned there too |
| Official docs | Product and integration reference | `https://docs.morpho.org` (Blue, MetaMorpho vaults, Midnight), `https://docs.merkl.xyz` |
| Per-tool parameters | The authoritative parameter list for every tool is its manifest; `describe_tools` renders exactly that | `protocols/morpho/manifests/`; a full rendered export from the 2026-08-18 audit sits in `agents_dm/morpho-audit/catalog.md` (local, gitignored) |
| On-chain reads | Everything a signature depends on | viem clients in `src/tools/morpho/evm-client.ts`, RPC table shared with KyberSwap, fallback transports per chain |

## What the agent can do

**Read.** Screen markets and vaults with full range filters, inspect one of
either in depth, read a wallet's positions with health factors, read market
activity including liquidations, read claimable Merkl rewards, read balances and
the allowances that matter before acting, and compare curated vaults against
supplying a market directly.

**Execute.** Deposit to a CURATED vault, and withdraw from any vault. Supply and withdraw
the loan asset of a market directly. Supply and withdraw collateral, borrow, and
repay. Claim Merkl rewards. Every execution is consent-gated. Every execution
that moves a priced amount is also quote-gated: the vault pair and all six market
operations register a prequote kind in `protocols/prequote/registry.ts`. The
Merkl claim deliberately registers none, exactly like `pendle.claim`, because an
income sweep has no price, no slippage, no counterparty and no size, so there is
no figure a prequote could bind an approval to.

**Chains.** The nine where Vex can both bridge to and swap on the chain:
Ethereum, Base, Arbitrum, Optimism, Polygon, Unichain, HyperEVM, Monad and
Robinhood. Robinhood resolves through the shared `evm-chains` registry so a user
RPC override applies; the rest derive from the shared KyberSwap RPC table.

## The decisions that shape this lane

**No signature paths anywhere.** The client runs `supportSignature: false`, so
every approval is a plain exact-amount `approve()` to the pinned
GeneralAdapter1. Permit2 was the original policy and was abandoned after a fork
run showed the SDK's Permit2 signature being rejected on chain. An unbounded
approval to an adapter is never issued: the adapter is designed to hold no funds
between calls, so a standing grant turns any future adapter bug into a drain of
that token.

**Borrow is a direct Blue call, never a bundle.** The SDK's bundled borrow
requires `setAuthorization(generalAdapter1, true)` - a permanent, global,
unbounded grant across every market on the chain. Vex encodes the borrow itself
with `msg.sender == onBehalf`, so no authorization ever exists. The same is true
of loan-asset withdraw and collateral withdraw. The price is that atomic
combinations (supply-and-borrow, repay-and-withdraw) are unreachable; each
operation is its own gated transaction, and the intermediate states are safe by
ORDERING rather than by atomicity: collateral goes in before debt comes out,
debt goes down before collateral comes out.

**A market must earn the right to be operated on.** Morpho Blue is
permissionless: anyone can deploy a market with any oracle. Three layers gate
execution, and none is redundant.

1. Morpho's own curation (`listed: true`), read live and uncached. This is an
   off-chain assertion, so it is never the sole basis of a signing decision.
2. The pinned MorphoChainlinkOracleV2 factory. This proves the oracle contract
   is the standard implementation with no arbitrary code, and it is the layer
   that still stands when the API is wrong or unreachable.
3. Feed liveness read on chain at execution time. This is the only layer that
   sees the present moment, and it catches a market whose feed rotted after
   curation.

Why all three: a survey of the top markets found the factory layer alone would
have admitted an Arbitrum market holding 4.89B reported USD whose feed had been
stale for 335 days, and an Ethereum market holding 2.97B whose feed reverts
outright. Both are uncurated, so layer 1 refuses them. Conversely a curated
market can rot after listing, which only layer 3 sees.

Exchange-rate adapters (Pendle PT discount adapters, vault share-price readers,
and the wstETH/stETH and weETH/ETH class) report `updatedAt == 0` because they
derive from live chain state rather than a pushed round. A zero timestamp is NOT
a blanket exemption from layer 3: the allowance is a RECOGNIZED-ADDRESS TABLE in
`market-policy/zero-round-feeds.ts`, seeded by surveying every listed market on
the six chains that carry them. Only an address IN THAT TABLE may pass on a
positive answer alone. The code does not identify an adapter class by its nature
and makes no such claim - it recognises addresses somebody measured - so any feed
not in the table that reports zero is a feed whose age cannot be established, and
it is refused rather than waved through. Layers 1 and 2 apply either way, and
widening the table is an owner decision under rules/00.

`MORPHO_MANUAL_ORACLE_ALLOWLIST` in `src/tools/morpho/constants.ts` is the
owner's escape hatch for a curated market whose oracle predates the factory. It
is MARKET-SCOPED and must stay that way: an entry admits one oracle for the one
market triple it names, never that oracle wherever it appears, so an allowlisted
oracle reused by a different market gets no free pass. It short-circuits layer 2
ONLY; curation and liveness still apply to an allowlisted oracle. Each entry
carries its evidence as a field, not a comment, so tests can assert on it. Adding
an entry is a security-posture decision under rules/00 and needs explicit owner
approval, never a builder's judgement.

**A vault must be CURATED to be deposited into, and delisting must never trap
a depositor.** `src/tools/morpho/mutations/vault-policy.ts` reads Morpho's
`listed` flag live and UNCACHED, bound to the exact vault address and chain, and
refuses a deposit into a vault Morpho does not list. It runs TWICE on a deposit:
once in the handler before the approval is broadcast, and again in
`signed-broadcast/operation-leg.ts` immediately before the deposit is signed,
because the first call is a transaction and a confirmation earlier than the
signature it would otherwise authorise. Both `listed` and the governance
disclosure ride on the approval output, so an approval card cannot omit them.

Deliberately UNCACHED and deliberately SEPARATE from the vault detail read that
also carries `listed`: that read is served through a 15-second cache and reads
the flag tolerantly, which is right for a screen and wrong for a signing gate.
And a clean simulation is not a substitute - it proves the deposit call would
succeed, never that anyone vouches for the curator choosing the markets
underneath or that the minted shares stay redeemable.

WITHDRAWALS ARE EXEMPT, permanently and on purpose. Delisting is the moment a
depositor most needs to leave; refusing to build their exit because a curator
lost Morpho's endorsement would turn an off-chain judgement into a lock on the
user's own self-custodied funds. A withdrawal keeps every check that is about
CORRECTNESS - the fresh rebuild against current state, the pinned receiver, the
target re-assertion and the simulation - and gives up only the one that is about
desirability. `vault-operation-leg-regate.test.ts` pins the asymmetry in both
directions, so a later change that gates both "for consistency" fails.

**Health factor floor 1.25 is a buffer, not a guarantee.** It is projected from
post-accrual state and re-read immediately before signing, but the direct Blue
calldata carries no Vex floor, so an oracle move between signing and inclusion
can land a position below 1.25 while still above Morpho's own 1.0 liquidation
threshold. Morpho has no close factor: crossing 1.0 permits the entire debt to
be repaid and the collateral seized at up to a 15 percent incentive, which is
why the floor sits well above 1.0. A supply or withdrawal of the loan asset does
not move the health factor at all; a withdrawal is bounded instead by the
market's available liquidity and by the caller's own supplied position.

**Full repayment uses the shares overload.** Repaying by assets cannot close a
debt: interest accrues between the read and inclusion and the rounding is
against the borrower, so dust always remains. The shares path approves the
ceiling the on-chain guard enforces and the bundle sweeps the over-pull back; a
small residual allowance can remain and is reported in the tool output with its
number rather than described as nothing.

**Every transaction is decoded before it is signed.** Whether the SDK built it
or Vex did, the calldata is walked leg by leg: exact leg count and order, every
target pinned by role, the pull destination asserted, amounts within the
intent's bounds, zero value, no skipped reverts, empty callbacks. An unknown
selector or an undecodable leg is a named refusal, never a pass-through. The
selector allowlist is derived from the SDK's own ABIs at load time and each
addition cites the fork capture that produced it.

**Ambiguity is never terminalized by the handler.** A broadcast whose receipt
cannot be read, or whose amounts cannot be decoded, returns `unproven` and leaves
its ledger row PENDING, and the operation is never retried. Pending is not
permanent: the generic EVM repair sweep (`sync/agent-activity-repair.ts`) later
re-reads the receipt and status-confirms the row from a definitive one even
though it can decode no amounts, while the executed-amount fallback fills the
money separately or declines it by name. What the handler refuses to do is
manufacture a terminal verdict it cannot prove. A funded probe hit exactly this
when an RPC refused `eth_getTransactionReceipt`: the approval landed, the deposit
was never sent, and the honest output said so.

## Ledger contract

| Operation | kind | role |
| --- | --- | --- |
| Vault deposit / withdraw | `lend` | `lend_deposit` / `lend_withdraw` |
| Market supply / withdraw of the loan asset | `lend` | `lend_deposit` / `lend_withdraw` |
| Collateral, borrow, repay | `lend` | `lend_borrow_operate` |
| Reward claim | `yield` | `yield_claim` |

One venue, two kinds, because the ledger's kinds describe the OPERATION rather
than the protocol: a Merkl sweep is income, not lending. A claim records one row
per transaction because a unique `tx_hash` index deliberately allows exactly one
activity row per broadcast. Exactly one token's credit is PROVEN from the
receipt's own logs and anchored on the leg; the remaining tokens ride on the
leg's route provenance as the PLANNED claim set Vex submitted, not as proven
executed credits. Do not read the provenance breakdown as settlement evidence.
Market rows and vault rows share their roles and are distinguished by their
intent params.

**Completeness.** `roleLegsIncomplete` and its SQL mirror require an executed leg
from the LEND roles only where the row itself populated that token side. A vault
deposit or withdrawal swaps asset for shares, populates both sides, and owes
both. A direct-market supply or withdrawal moves ONE token, populates one side,
and owes one. Demanding both would hold every correctly settled market row
"incomplete" until the reporting grace expired.

Migrations: `079` admits EVM lend rows and approval legs, `080` adds the vault
prequote kinds, `081` adds the four per-operation borrow kinds. All expand-only.

**AgentScan volume**: borrow-lane operations deliberately do NOT count toward
reported volume. The operation name lives in `intent_params`, which the ingest
contract does not carry, so the server sees only which leg is populated - and
that cannot separate a collateral supply from a repayment, or a borrow from a
collateral withdrawal. Counting by direction would book a repayment as new
volume. Undercounting was chosen over overcounting, deliberately, and it is
recorded as an open question on the server PR. The lender's rows do count, both
the vault pair and the direct-market pair: they carry `lend_deposit` /
`lend_withdraw`, whose direction alone is unambiguous.

## Deliberately absent

- **Liquidating other people's positions.** A keeper and MEV business: it needs
  capital, speed and infrastructure to win the race against bots.
- **Atomic supply-and-borrow and repay-and-withdraw.** They require the standing
  authorization the approval policy forbids. See above.
- **Midnight**, Morpho's fixed-rate order-book product. A separate protocol with
  its own data model, Base only, with routes its own docs call unstable.
- **Creating markets or vaults, and curating.** A business model, not an agent
  action.
- **Public Allocator invocation.** Vex READS reallocatable liquidity but cannot
  trigger a reallocation. Niche, and it matters only at size.
- **Pre-liquidations.** Opt-in softer liquidation terms, relevant for leveraged
  positions.
- **Raw historical timeseries.** Averaged windows are served; full charts are
  not.

## Known gaps, verified by audit 2026-08-18

Found by an independent coverage audit against live GraphQL introspection and
`@morpho-org/morpho-sdk@5.5.0`. These are UNDECLARED omissions, distinct from
the "Deliberately absent" list above, recorded here until fixed.

Filter and sort depth on discover tools is the widest gap. The agent sees each
object in near full resolution, but can ask the population few questions:

- `markets.discover` sends 15 of 43 `MarketFilters` and 6 of 23 sort keys.
  Missing with real agent value: `oracleAddress_in`, `irmAddress_in`,
  `uniqueKey_in` (batch-fetch a known market set), `isIdle`, loan and
  collateral asset tags.
**CLOSED 2026-08-18.** Every filter and sort key named by the audit now ships,
verified against live introspection AND a live result count on that date:

- `markets.discover` gained `uniqueKey_in` (as `marketIds`), `oracleAddress_in`,
  `irmAddress_in`, `isIdle`, and both asset-tag predicates, and its sort
  vocabulary went from 6 keys to 18 of the 24 `MarketOrderBy` declares.
- `vaults.discover` gained `assetTags_in` and `marketUniqueKey_in` (as
  `suppliesMarketIds`), both V1-ONLY - `VaultV2sFilters` declares neither, so
  they are refused by name when v2 is in scope rather than half-applied. Its
  sort vocabulary went from 4 keys to 13 across the two generations, with a
  refusal that names the `version` able to serve a key.
- `markets.activity` gained `hash` (as `txHash`), `liquidatorAddress_in`,
  `badDebtAssets_gte` and `seizedAssets_gte`, and its `marketIds` now accepts a
  real array as well as a comma string.

What remains deliberately absent, with the reason, per the Provider Integration
Depth decree:

- Market sorts `UniqueKey` (ranks by an opaque hash), `BorrowAssets`,
  `SupplyAssets`, `BorrowShares` and `SupplyShares` (raw base units and share
  counts are not comparable across markets at different decimals; the `*Usd`
  twins are offered), and `RateAtUTarget` (deprecated in the live schema).
- Vault sorts `Address` and the raw-unit twins `TotalAssets`, `TotalSupply`,
  `Liquidity`, `RealAssets`, `IdleAssets`, for the same comparability reason.
- The asset-tag vocabulary is a CAPTURE, not a schema enum: Morpho types these
  filters `[String!]`, so `MORPHO_ASSET_TAGS` in `@tools/morpho/request/markets.ts`
  is every distinct `Asset.tags` member across all 5,520 indexed assets, paged
  in full on 2026-08-18. It is enforced as a closed set anyway, because an
  unknown tag is not an error to Morpho - it is a predicate matching nothing,
  and the empty page would read as "no such markets exist". Refresh it by
  re-running that sweep.
- `markets.activity` sends 6 of 20 `MarketTransactionFilters`. Missing: `hash`
  lookup, `liquidatorAddress_in`, `badDebtAssets_gte`, `seizedAssets_gte`.

Capability and read gaps:

- **V2 forced deallocation is shown but not executable.** STILL OPEN, and the
  projector no longer implies otherwise: as of 2026-08-18 it states outright
  that `forceDeallocatableLiquidity` needs a forced deallocation Vex HAS NO TOOL
  FOR, so the agent must not count it toward what this session could withdraw.
  The SDK builds `forceWithdraw` / `forceRedeem` with no `getRequirements` - no
  approval and no authorization - so both fit the approval policy, and the
  scoped follow-up is: capture the calldata each builder produces, extend the
  bundle and direct-call decoders FROM that capture (never add a selector to the
  allowlist without it), wire the consent card, and gate it exactly as the
  existing vault withdrawal is. It was deferred rather than rushed because it is
  a money path and a half-verified one is worse than none.
- **Vault exit is assets-only.** STILL OPEN. `redeem` by shares is not built,
  although this file argues shares-first for full repay for exactly the same
  rounding reason, so a full vault exit by assets can leave share dust. The
  approved shape is an explicit alternative param on `morpho.vault.withdraw`,
  mutually exclusive with `withdrawAmountRaw` and refused by name when both
  arrive, dispatched on `state.generation` the way `mutations/build.ts` already
  dispatches the deposit. It needs the SDK redeem calldata CAPTURED before the
  decoder allowlist grows by one selector, the quote path able to price the
  shares exit so the prequote gate can pair it, and the approval card to say
  which denomination is being burnt. Deferred in the same pass and for the same
  reason as the forced deallocation above.
- ~~**`market.get` supplier list is silently V1-only.**~~ **CLOSED 2026-08-18.**
  The detail query now reads `supplyingVaultV2s` beside `supplyingVaults` and
  merges them into one list with a `version` tag per row. The two nest
  differently - V1's APY is under `state`, V2's is flat - so each is read
  through its own shape. On the Base cbBTC/USDC market this had been reporting
  13 suppliers and hiding 14, including a V2 vault sharing the exact NAME of a
  V1 one already in the list, which is why the version tag is per row and the
  projector tells the agent to identify a route by address.
- ~~**Curator disclosure metadata is unread.**~~ **CLOSED 2026-08-18.**
  `vault.get` now returns a `disclosure` block on both generations:
  `Vault.metadata` / `VaultV2.metadata` (the curator's published description and
  image), the curator's own `description`, `image`, `socials` links and
  `state.aum`, and on V1 `VaultState.curatorMetadata` classifying the account
  holding the curator role (`safe` or `aragon`). All display-only and therefore
  nullable, and the block says in words that it is the curator's own claim
  rather than an audit, and that an EMPTY classification list is an absence of
  information rather than evidence a single key controls the vault. Paid for on
  the DETAIL reads only: the curator connection cost 8,530 extra complexity on
  one V2 vault (45,560 to 54,090, measured 2026-08-18), which a 50-row screen
  could not carry for information nobody reads while screening. V2 exposes no
  `curatorMetadata` equivalent.
- **No vault activity read.** Markets have history; vaults do not.
  `vaultV1Transactions` and `vaultV2AllocationTransactions` are unconsumed.

Funded-run defects, found by the live 3-chain audit the same day (full
evidence in `agents_dm/morpho-audit/report.md` and `runs/`):

- **D1 HIGH**: a deposit was refused as DEFINITIVE because the post-approval
  simulation ran against a node that had not yet seen the approval this
  execution had just broadcast. The identical call minutes later confirmed.
  The fix is to require the simulation block to be at or past the approval's
  inclusion block, else classify unproven.
- **D2 HIGH**: `wallet.balance` silently drops an array `tokenAddress`
  (`readAddressCsv` returns undefined for arrays) and reports native-only
  with no warning, despite the manifest promising array support.
- **D3 HIGH**: `wallet.balance` `nextStep` still says "Vex has no Morpho
  mutating tools yet" while nine mutators ship.
- **D4 HIGH, owner decision**: the market lane re-runs curation + oracle +
  liveness for EXIT operations too, so `market.withdraw`, `market.repay` and
  `market.withdrawCollateral` are gated on Morpho's off-chain API being
  reachable. The vault lane deliberately never gates a withdrawal. A blocked
  repay pushes a position toward liquidation. Fired live from a plain
  "fetch failed".
- **D5 MEDIUM**: `failure_reason` is persisted truncated at 512 chars, cutting
  off the standing-allowance disclosure and remediation.
- **D6-D8 LOW**: `route:"both"` summary never mentions the comparison fields;
  vault dust invisible to `positions.get` while coverage claims complete;
  `chainIds` rejects a bare number and `marketIds` is plural but rejects
  a list.

Agentscan-side, verified the same day (owned by vex-agentscan, not this lane):

- A vault deposit's share leg is unquotable by the price feed, so every vault
  deposit lands in "could not be fully priced" and drops out of realized
  result and win rate, although volume itself books correctly.
- `supplyCollateral` volume is counted as zero until the ingest contract
  carries the operation name or per-operation roles. Borrow, repay and
  withdrawCollateral are correctly zero; a lender's market supply maps to
  `lend_deposit` and IS counted.

## Do not

- Do not let a number from the indexed API decide an amount that gets signed.
  State that a transaction depends on is read from the chain at build time.
- Do not add a selector to the decoder allowlist without the capture that
  produced it.
- Do not widen an oracle predicate, add an allowlist entry, or relax a gate
  without explicit owner approval; these are stored-security decisions.
- Do not treat `listed: true` as sufficient on its own, and do not treat the
  factory check as proof that an oracle's feeds are legitimate. It proves the
  code is standard, nothing more.
- Do not describe the health factor floor as a guarantee.
- Do not report a quoted amount in a column that means an executed one.
