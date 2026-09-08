# Lighter fee launch: release evidence

This document is the release-evidence record for Vex's Lighter fee collection.
It holds three things and nothing else: the owner's attestation of the collector
identity, the terms decided, and the live checks that must be observed before
the release may claim that fee collection works. Every claim about collection
here is either an owner attestation or an observed live result with a date.
Nothing in this file is evidence on its own that fees were credited.

Configuration owner: `src/tools/lighter/fee-policy.ts` (collector identities and
the four fixed rates). Card wording owner:
`src/vex-agent/tools/protocols/lighter/fee-authorization-disclosure.ts`.
Namespace documentation: `src/tools/lighter/Lighter.md`.

## 1. Owner attestation, 2026-09-07

The owner attested, in the integration conversation on 2026-09-07, that:

| Attested fact | Value |
| --- | --- |
| Collector wallet, both deployments | `0x10Ce97Cf3142BE2a1a28aC83A55b21fDCE493C03` |
| Lighter Core collector account index | 743799 |
| Robinhood Chain collector account index | 22869 |
| Ownership | The wallet and both accounts are Vex's |
| Rates | 10 bps (1,000 ticks) perps, 25 bps (2,500 ticks) spot, maker and taker alike |
| Duration | Ten years from approval, revocable at any time |
| Release switches | `enabled: true` for both deployments on this attestation |

The attestation covers the IDENTITY of the collector and the INTENT of the
terms. It does not stand in for the live checks in section 3: no fee credit has
been observed by Vex on either deployment yet.

The rates are fixed in code and cannot be changed by an agent argument or a user
request. One tick is one millionth of executed trade value, so 1,000 ticks is
0.10% and 2,500 ticks is 0.25%. 10 bps is Lighter's documented maximum
integrator fee on perps; the spot maximum is 1%.
See [partner attribution](https://docs.lighter.xyz/integrations/partner-attribution.md).

## 2. Terms the approval card states

The single fee-authorization card covers spot and perps together and states, all
of it rendered from the persisted intent and never from model text:

- the four rate caps and the collector account and wallet;
- the authorization expiry as an ISO timestamp and its duration in words, "valid
  for 10 years, revocable at any time with `lighter__fees_approve_prepare`
  revoke";
- the account tier today and the tier the change targets, with the exchange fees
  of each side by side;
- why the tier change is needed: Lighter rejects integrator-attributed trades
  from Standard accounts from 2026-09-14;
- that Vex does not switch the tier back, that upgrades apply immediately, and
  that a downgrade is allowed once 24 hours have passed since the last tier
  change;
- that fee-bearing authorization is required to open positions, while orders
  that only reduce an existing position stay available without a Vex fee.

Individual trades still require their own approval. Revocation goes through
`lighter__fees_approve_prepare` with `revoke: true`, which sets all four caps and
the expiry to zero.

Tier targets per deployment, from the provider's own tier tables
([Core](https://apidocs.lighter.xyz/docs/account-types),
[Robinhood Chain](https://apidocs.rh.lighter.xyz/docs/account-types)):

| Deployment | Target tier for a Standard account | Published exchange maker / taker |
| --- | --- | --- |
| Core | Plus | 0.005% / 0.005% |
| Robinhood Chain | Premium | Up to 0.0120% / 0.0350% before discounts |

Robinhood Chain has no Plus tier, which is why its target is Premium.

## 3. Release evidence: live checks still required

Each row is filled by the live lane after the owner gives an explicit go for
that exact step, environment and amount. The status cell is either `pending` or
`observed on YYYY-MM-DD`; nothing else is a valid value, and a green test suite
is never a substitute for a row. `src/__tests__/lighter/lighter-fee-launch-evidence.test.ts`
holds that format to the file.

| ID | Deployment | Check | Evidence to record | Status |
| --- | --- | --- | --- | --- |
| E1 | Core | Fee authorization approved and submitted on the owner's funded account | Account index, approval id, the four caps and the expiry read back from provider `approved_integrators` | pending |
| E2 | Core | One small approved order, opening a fee-bearing position | Order id, market, filled base and quote value, the integrator fee terms carried on the signed order | pending |
| E3 | Core | One approved cancel of a live order | Order id, provider cancel result, and that no fee was attributed to an unfilled quantity | pending |
| E4 | Core | Integrator fee credit observed on the collector account | Collector account index, credited amount and asset, and the fill it corresponds to | pending |
| E5 | Robinhood Chain | Fee authorization approved and submitted on the owner's funded account | Account 24226; approval `approval-1788863693050-qfxko5`, intent `lighter-fees-851489ff-928e-4afe-8347-0949bb983c01`, Lighter tx `cad9b2a686496139098a19fa5229bf83d461c64cb98da2c1f877a0d3b125398337893c72874c8e85`, tier Standard to Premium; read back from provider `approved_integrators` on the public account endpoint: collector 22869, max_perps_taker_fee 1000, max_perps_maker_fee 1000, max_spot_taker_fee 2500, max_spot_maker_fee 2500, approval_expiry 2104223693004 (2036-09-05); `lighter.fees.status` ready. Evidence: `agents_dm/lighter-live-evidence/fee-authorization-2026-09-08T10-34-36-119Z/` | observed on 2026-09-08 |
| E6 | Robinhood Chain | One small approved order, opening a fee-bearing position | Order 562949887334777 (client order index 40253714670725), market 0 ETH perpetual, IOC buy filled 0.0050 ETH at 2484.97, quote value 12.424850 USDG, trade 491032980; the signed order carried integratorAccountIndex 22869, integratorMakerFee 1000, integratorTakerFee 1000; the authenticated trade record stamped integrator_taker_fee 1000 for collector 22869 beside the exchange taker_fee tick 350. Evidence: `agents_dm/lighter-live-evidence/ioc-order-2026-09-08T10-38-49-548Z/` | observed on 2026-09-08 |
| E7 | Robinhood Chain | One approved cancel of a live order | Resting GTT buy 0.0081 ETH at 1236.83 on market 0, provider order 562949887279277 (client order index 88020260210630), placed through the create card and read back open with filled 0.0000; cancel intent `lighter-lifecycle-bc0e2ae2-0bb5-40c5-bb64-95c39b9b6503`, approval `approval-1788868168929-x12l6p`, TxType 15 tx `84f66b12fb059b1950a0969c04f5aa41244d3c10a61726e28695edafe020134dd4a3bd3362283084`, resume status `canceled`, lifecycle intent completed, open orders after: none. No trade record exists for the order, so no integrator fee was attributed to the unfilled quantity. Evidence: `agents_dm/lighter-live-evidence/cancel-2026-09-08T11-30-00-428Z/` (placement) and `cancel-2026-09-08T11-49-11-750Z/` (cancel) | observed on 2026-09-08 |
| E8 | Robinhood Chain | Integrator fee credit observed on the collector account | Collector account index, credited amount and asset, and the fill it corresponds to | pending |

Notes that bind how a row may be filled:

- An `sendTx` acceptance is not a fee credit. E4 and E8 are filled only from the
  collector account's own state, not from an order result.
- Core perpetual fees are documented in USDC and spot fees are taken from the
  asset received. Robinhood Chain uses USDG collateral in Vex; record the actual
  credit asset observed there rather than reusing the Core wording.
- A submission that times out is checked with `lighter.fees.status`. It is never
  blindly resubmitted.
- Setting `enabled` back to false stops fees on future preparations. It does not
  rewrite already submitted orders and does not revoke an existing authorization.

## 4. Public reads already performed, 2026-09-05

These are unauthenticated reads. They establish the provider's public
account-to-wallet mapping and the current fee caps. They do not establish
possession of the wallet's signing key, customer consent, or receipt of any fee.

| Deployment | Perp maker / taker cap | Spot maker / taker cap | Vex rates fit |
| --- | --- | --- | --- |
| Core | 1,000 / 1,000 ticks | 10,000 / 10,000 ticks | Yes |
| Robinhood Chain | 10,000 / 10,000 ticks | 20,000 / 20,000 ticks | Yes |

Fresh reads at approximately 12:51 UTC returned code 200 and exactly one account
for each configured index, with the exact wallet address in the attestation
table above, on both deployments. The production fee-policy validator accepted
each identity against the caps in this table. Both provider account statuses
were recorded as `0`, and that undocumented value was not treated as proof of
anything. No authenticated account-limit read, tier change, authorization or
transaction was performed for this check.

Sources:
[Core configuration](https://mainnet.zklighter.elliot.ai/api/v1/systemConfig),
[Robinhood Chain configuration](https://api.rh.lighter.xyz/api/v1/systemConfig),
[Core collector](https://mainnet.zklighter.elliot.ai/api/v1/account?by=index&value=743799),
[Robinhood Chain collector](https://api.rh.lighter.xyz/api/v1/account?by=index&value=22869).
