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
