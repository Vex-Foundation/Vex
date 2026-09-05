# Lighter fee launch

Fee collection is disabled by default. Public provider reads and local signing
checks have passed; collector ownership, customer authorization and actual fee
credits still require approved live verification before release.

## 1. Configure the public collector

Edit `src/tools/lighter/fee-policy.ts`, in `COLLECTORS.core` and `COLLECTORS.rhc`:

| Field | Required value |
| --- | --- |
| `enabled` | `false` until the deployment is ready for its controlled canary/release |
| `accountIndex` | The existing VEX-owned Lighter collector account index on that deployment |
| `l1Address` | The public wallet address that owns that collector |

Use a separately verified collector configuration for each deployment. Never add
a wallet private key, seed phrase or trading credential to this file. Lighter's
program is permissionless; an actual VEX-owned account is sufficient, without
partner whitelisting. Runtime checks match its live wallet ownership and fee caps.

The fixed maker and taker rates are **1,000 ticks for perps (0.10%)** and
**2,500 ticks for spot (0.25%)**. One tick is one millionth of executed trade
value. Agent arguments and customer requests cannot change these terms.
[Provider requirements](https://apidocs.lighter.xyz/docs/partner-integration).

## 2. Customer setup and collection

VEX continues its existing command-driven account funding and local trading-key
setup. Its normal approval card then requests one authorization covering both
spot and perps. It displays the collector, four rate limits and actual ten-year
permission expiry; normal individual trade approvals remain required. Reuse the
permission while valid. Expiry or revocation requires fresh consent.

Nonzero fees require an eligible account tier. Preserve Plus/Premium accounts.
For Standard accounts, the card includes these deployment-specific changes and
their additional exchange fees:

| Deployment | Target tier | Published exchange maker / taker fees |
| --- | --- | --- |
| Core | Plus | 0.005% / 0.005% |
| Robinhood Chain | Premium | Up to 0.0120% / 0.0350% before applicable discounts |

These exchange charges are separate from VEX's rates. After an approved tier
change, VEX must confirm the actual account tier and fees against the approved
terms before submitting the native fee authorization. Account tiers apply to the
L1 wallet's subaccounts as well.
[Core tiers](https://apidocs.lighter.xyz/docs/account-types),
[Robinhood Chain tiers](https://apidocs.rh.lighter.xyz/docs/account-types).

VEX attributes each order to the collector. Lighter credits native fees as orders
fill; there is no separate per-trade transfer from the customer's wallet. Opening
and closing trades both incur fees on their respective filled value. Unfilled or
cancelled quantities earn no fee. Core perpetual fees are documented in USDC;
spot fees use the received asset, so a spot ETH purchase pays the fee in ETH.
Robinhood Chain uses USDG collateral in VEX; verify and record the actual fee
credit asset there during the canary instead of assuming the Core USDC wording
applies. Treasury withdrawals from the collector remain manual.
[Native settlement](https://apidocs.lighter.xyz/docs/partner-integration).

## 3. Verify and enable each deployment

1. Verify the collector's live account index and owning public address. Re-read
   `systemConfig` and confirm all four VEX rates fit its current caps.
2. In a controlled local canary build, configure the verified collector and
   enable only the deployment being tested. Keep distributed releases disabled
   until its checks below pass. Use the existing VEX approval cards for every
   tier change, authorization and trade; no canary runs automatically.
3. Complete fee setup through the real card. Confirm the exact collector, four
   caps and expiry in provider `approved_integrators`; restart VEX and confirm
   valid consent is reused. Rejecting setup must stop the operation.
4. Run small approved perp and spot trades, covering maker and taker fills,
   opening/closing and spot buy/sell. Include a partial-fill/cancel and the
   modified/grouped protective order paths. Match filled quantities and provider
   fee attribution to actual collector credits and their assets. For a $1,000
   executed perp trade, the VEX fee is $1; a $1,000 spot execution has $2.50 of
   fee value in its received asset, subject to provider precision.
5. Approve revocation through `lighter.fees.approve.prepare` with `revoke: true`.
   The native operation sets all four caps and permission expiry to zero. Verify
   provider state and that new fee-bearing trades require fresh authorization.
   Keep cancellation, withdrawal and approved risk-reducing exits usable.
6. Retain deployment, account/collector IDs, approval expiry, transaction/order
   IDs, filled values, fee assets and matching collector credits in the release
   evidence. Enable the public release for that deployment only after these
   checks and the production build/package checks pass.

If a submission times out, check `lighter.fees.status`; do not blindly resubmit.
Disabling `enabled` stops fees on future preparations and does not rewrite
already submitted orders or revoke their existing terms. Do not claim fee
collection from test results or `sendTx` acceptance alone.

## Public verification, 2026-09-05

Production `LighterClient` made fresh, unauthenticated reads at approximately
11:41 UTC. Both system configurations returned code 200:

| Deployment | Perp maker / taker cap | Spot maker / taker cap | VEX rates fit |
| --- | --- | --- | --- |
| Core | 1,000 / 1,000 ticks | 10,000 / 10,000 ticks | Yes |
| Robinhood Chain | 10,000 / 10,000 ticks | 20,000 / 20,000 ticks | Yes |

The public Core liquidity-pool account `281474976710654` and Robinhood Chain
funding-rebate account `80` parsed successfully with matching identities. Both
omitted `approved_integrators`; the parser preserves that absence, so these reads
do not establish customer fee consent. Robinhood Chain's configured liquidity
and staking pool account queries returned HTTP 400, `account not found`; its
funding-rebate account query succeeded.

No authenticated account-limit read, tier change, customer authorization or
transaction was performed for this check. Core documentation was rechecked;
Robinhood Chain's published tier table was browser-reviewed during the build,
while the automated documentation recheck returned HTTP 403. Recheck published
fees before release.

Sources: [Core configuration](https://mainnet.zklighter.elliot.ai/api/v1/systemConfig),
[Robinhood Chain configuration](https://api.rh.lighter.xyz/api/v1/systemConfig).
