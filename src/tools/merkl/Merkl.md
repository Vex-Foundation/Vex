# Merkl

Read-only client for [Merkl](https://merkl.xyz), the reward distributor that Morpho's
incentive campaigns settle through. Morpho's own Universal Rewards Distributor is
deprecated, so a "what rewards can I claim" question about Morpho is answered here.

Merkl distributes for many protocols, not only Morpho. That is a property of the
data, not a limitation of this client, and the module surfaces it rather than
hiding it - see **Attribution** below.

## Public API

| Symbol | File | Purpose |
| --- | --- | --- |
| `MerklClient`, `getMerklClient()` | `client.ts` | The two reads, behind one budgeted request method |
| `attributeMerklRewards()` | `rewards.ts` | Per-protocol attribution and claimable arithmetic |
| `MERKL_MORPHO_PROTOCOL_ID` and other pinned facts | `constants.ts` | Endpoint, identity, budget, caps |
| `MerklReward`, `MerklAttributedReward`, ... | `types.ts`, `rewards.ts` | Validated shapes |

`src/tools/merkl/` never imports `src/vex-agent/**`. The agent-facing tool that
consumes it is `morpho.rewards.get`, because the Morpho namespace is where a user
asks the question.

## Endpoints used

```
GET /v4/users/{address}/rewards?chainId=N   one wallet, ONE chain, every protocol
GET /v4/opportunities/{id}                  the campaign's protocol attribution
```

## Live-probed facts (2026-08-14)

Each of these changed the code. None is taken from documentation.

- **Keyless.** No key, no signup, no auth header.
- **The rate limit is published on every response**: `x-ratelimit-limit: 4200, 4200;w=60`
  with `x-ratelimit-remaining` and `x-ratelimit-reset` beside it, and
  `cache-control: public, max-age=60`. Vex holds itself to 120/minute.
- **`chainId` is required and does not repeat.** Omitting it answers HTTP 400.
  `?chainId=8453&chainId=1` returned Base alone, with Ethereum silently absent.
  Multi-chain answers are a fan-out of single-chain reads.
- **Unknown query parameters are silently ignored.** `?id=<opportunityId>` on the
  opportunities list returned an unrelated opportunity instead of an error, so
  there is no usable bulk-by-id fetch. No parameter is ever sent on a hope.
- **`amount` is cumulative lifetime accrual, not a claimable balance.** Claimable
  now is `amount - claimed`. `pending` is accrual not yet published into a Merkle
  root and is NOT claimable. A live Base row read `amount 27159256967843778403797`
  against `claimed 26977794427478008954964`: reporting `amount` as claimable would
  have overstated the claim by roughly 150x.
- **A claim is per token, not per campaign.** One Merkle leaf per wallet per reward
  token; the campaign `breakdowns` beneath it explain how that leaf accrued.
- **Raw amounts are decimal strings** in every observed field, including values far
  above 2^53. The validator refuses a number form rather than parsing a double.

## Attribution

A reward row names a campaign and an opportunity id. It does **not** name a
protocol. `protocol.id` lives on the opportunity, and `"morpho"` is Merkl's id for
Morpho (live-verified on `Supply to the Moonwell Flagship USDC vault on Morpho on
Base`, whose protocol block reads `{id: "morpho", name: "Morpho", tags: ["LENDING",
"drip"]}`).

So attribution costs one extra request per distinct opportunity, capped by
`MERKL_MAX_OPPORTUNITY_LOOKUPS`. The rules the module holds to:

1. **Every reward token row is reported**, whatever protocol produced it, because
   claiming takes the whole row and a Morpho-only view would hide money the same
   transaction delivers.
2. **Each row is labelled with the protocols inside it**, with Morpho's share
   computed from `protocol.id` and never inferred from a campaign name.
3. **An opportunity that cannot be resolved is labelled unresolved and counted.**
   It is never assumed to be Morpho and never dropped. `attribution.complete` is
   false whenever that happened, because "no Morpho rewards" and "we could not
   tell" are different answers.

## Not here, deliberately

- **Claiming.** Merkl returns Merkle `proofs` on every reward row, which is what an
  on-chain claim needs. This module reads them past the validator and does not
  expose them: claiming is a state-changing, gas-costing transaction and belongs to
  the mutation phase behind an approval gate, not to a read client.
- **Opportunity discovery, campaign listings, leaderboards, APR history.** Morpho's
  own GraphQL is the discovery surface for Morpho; adding a second one here would
  split an answer across two providers with different freshness.
