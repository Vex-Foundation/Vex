# Jupiter Lend Borrow fixtures — provenance

Recorded live, this session (Agent Scan Phase 3 Batch 5, card B3 — the
Codex-blocked wire-contract rebuild). B1 had NO fixtures and NO OpenAPI spec
for Borrow ("fixtures beat docs beat types" could not be followed at the
time); this directory closes that gap. `recon-docs-lend.md` §3.2 already
documented the real (nested-object, string-factor) shape from
`docs/openapi-spec/lend/borrow.yaml` — B1 missed it and modeled
`supplyToken`/`borrowToken` as bare mint-address strings and
`collateralFactor`/`liquidationThreshold` as JSON numbers. These fixtures are
the ground truth `borrow-api/types.ts`/`schemas.ts` are now built against.

## Recording method

`GET /borrow/vaults` and `GET /borrow/positions` were fetched **keyless**
against `https://lite-api.jup.ag/lend/v1/borrow/*` (Jupiter's public,
unauthenticated "lite" mirror — same response shape as the production
`https://api.jup.ag/lend/v1/borrow/*` host our client (`client.ts`) calls with
an `x-api-key`; the swap domain has the same lite/main host split, noted in
`recon-docs-lend.md` §4.3). No `JUPITER_API_KEY` was available or used.
`POST /borrow/operate` was NOT live-called — it requires a real funded,
signing-capable Solana wallet, which is out of scope for a builder card with
no live wallet; `operate-doc-example.json` instead copies the request/response
example straight from Jupiter's own interactive API reference page.

## Files

| File | Source | Notes |
|---|---|---|
| `vaults-main.json` | `GET /borrow/vaults` (market omitted → `main`), 2026-07-24 | Trimmed from a live 79-vault array to 2 representative vaults: id `1` (WSOL/USDC, `collateralFactor`/`liquidationThreshold` "800"/"850" — the exact pair the docs' own prose example uses) and id `40` (JUP/USDC, "500"/"700" — a WIDER collateralFactor↔liquidationThreshold gap, evidence the two are NOT a fixed +50 offset). Confirms: `id`/`totalPositions` are JSON integers; `supplyToken`/`borrowToken` are NESTED objects with `address`/`decimals` (integer)/`symbol`/`price` etc; `collateralFactor`/`liquidationThreshold`/every liquidity-magnitude field are JSON STRINGS, not numbers. |
| `vaults-ethena.json` | `GET /borrow/vaults?market=ethena`, 2026-07-24 | 1 vault (id `5`, USDe/USDG, "920"/"940"). Confirms the market-scoped id space is real (a DIFFERENT vault `5` exists per market) and gives a second collateralFactor/liquidationThreshold pair for the raw/10=percent scale check. |
| `positions-empty.json` | `GET /borrow/positions?users=<32-char placeholder, not a real wallet>`, 2026-07-24 | `[]` — confirms the empty-array shape for a wallet with no Borrow positions. A real, non-empty `BorrowPosition` was NOT recorded (would require a real wallet with an open position — personal data this factory avoids per the owner's "no wallet addresses/position data in fixtures" rule); the interactive API reference's own example object (`id`, `vaultId`, `address`, `supply`, `beforeSupply`, `borrow`, `beforeBorrow`, `isLiquidated`, `supplyLiquidation`, `borrowLiquidation`, `isSupplyPosition`, `tick`, `tickId`, `dustBorrow`, `ownerAddress`, embedded `vault`, `config`) was used instead to confirm the position row's field list and types (all consistent with `recon-docs-lend.md` §3.2's own listing). |
| `operate-doc-example.json` | `docs/api-reference/lend/borrow/operate` (interactive reference's own example), 2026-07-24 | DOC EXAMPLE, not a live recording — see the file's own `_provenance` field. Confirms `OperatePayload`'s `colAmount`/`debtAmount` are base units of each token's OWN decimals (`"100"` debtAmount = 1 USDC-cent-ish unit language the docs use elsewhere — "1.1 USDC" ↔ `"1100000"` — i.e. 6-decimal USDC base units, matching the vaults' own token `decimals` field, NOT a fixed 1e9 scale) and that the response is `{ nftId: integer, transaction: base64 }`. |

## REST position/vault numeric-field unit contract (closes a B1 DOCS-GAP)

No live doc page states outright whether `BorrowPosition.supply`/`borrow`/
`dustBorrow` (and `BorrowVault.totalSupply`/`totalBorrow`/etc.) are raw atomic
units of the respective underlying token (the SAME unit `colAmount`/
`debtAmount` use) or the Read SDK's own internal, DIFFERENT fixed-1e9 "shares"
scale (`developers.jup.ag/docs/lend/borrow/read-vault-data`, quoted verbatim:
"Exchange prices are in 1e12 decimals. Balances are in 1e9 decimals." — this
describes the on-chain program's internal share/exchange-price
representation used by the SDK's own decode path, a DIFFERENT surface from
the plain REST JSON). Resolved here from the live fixture data itself
(fixtures beat docs):

- `vaults-main.json` vault `1`: `supplyToken` = WSOL (9 decimals), `totalSupply`
  = `"1857732346412971"` → `1857732346412971 / 1e9` ≈ 1,857,732 SOL ≈ $137M at
  the same object's own `supplyToken.price` ("73.96"); `borrowToken` = USDC (6
  decimals), `totalBorrow` = `"64467924946859"` → `/ 1e6` ≈ $64.5M. A ~47%
  utilization well under the vault's own 80% `collateralFactor` — economically
  sane.
- `vaults-ethena.json` vault `5`: `supplyToken` = USDe (9 decimals), `totalSupply`
  ≈ $263M; `borrowToken` = USDG (6 decimals), `totalBorrow` ≈ $238.8M — ~90%
  utilization, just under the vault's own 92% `collateralFactor` — again sane.
- `operate-doc-example.json`'s OWN docs page states amounts are in
  "base units" and elsewhere gives "`"1100000"` for 1.1 USDC" (6-decimal USDC
  base units) as the worked example for `colAmount`/`debtAmount` — i.e. the
  SAME per-token-decimals convention, not a fixed 1e9 scale.

Both independent vaults resolve to plausible, LTV-consistent USD totals ONLY
under the "each field is raw base units of ITS OWN token's `decimals`"
reading — the fixed-1e9 reading would make the ethena vault's numbers off by
several orders of magnitude for one leg and not the other (USDe happens to be
9-decimal, USDG is 6-decimal). **Conclusion, with citation**: `BorrowVault`'s
supply-side fields are raw base units of `supplyToken.decimals`; its
borrow-side fields are raw base units of `borrowToken.decimals`; `BorrowPosition.supply`/
`borrow`/`dustBorrow` follow the SAME convention (they are the position-level
decomposition of the same vault totals) — matching `colAmount`/`debtAmount`'s
own confirmed base-units contract exactly, so `borrow-risk-preview.ts`'s
existing bigint arithmetic (treating `position.supply`/`.borrow` as directly
addable to a resolved `colAmount`/`debtAmount` delta) was already unit-correct;
this was a confirmed-vs-assumed gap in the CITATION, not a bug in the
arithmetic. This is fixture-based inference, not an explicit doc sentence —
still short of 100% certainty, and named as a residual risk in `deltas/B3.md`.

## `dustBorrow` vs `borrow` (closes a second B1-adjacent DOCS-GAP)

`recon-docs-lend.md` §3.2 describes `dustBorrow` as "residual sub-
`minimumBorrowing` debt". A live doc search (`developers.jup.ag/docs/lend/borrow/api`)
adds: "Repaying the exact `borrow` amount can leave interest dust below
`minimumBorrowing`, which fails with `VaultUserDebtTooLow`" and a Code4rena
audit note for the underlying protocol describes a "dust phantom debt
position where the debt is not counted in the tick, but exists on the
position." Read together, `dustBorrow` is ADDITIONAL debt sitting on the
position ALONGSIDE `borrow` (accrued interest that has not been folded into
the tracked `borrow` figure), not a component already included inside it —
`borrow-risk-preview.ts` now computes existing debt as `borrow + dustBorrow`
(the conservative, never-understate-risk reading). Not a first-party doc
formula; flagged as inference in `deltas/B3.md`.

## Regeneration

Re-run the `curl` commands in `deltas/B3.md`'s "Mandatory sources consulted"
section and re-copy the sanitized/trimmed output here. Point-in-time
snapshots — rates, oracle prices, and `totalPositions` will drift; treat
these as **shape** ground truth, not values to assert unchanged indefinitely.
