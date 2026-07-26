# Jupiter Lend Borrow REST in `src/tools`

Local source-of-truth for `https://api.jup.ag/lend/v1/borrow`.

Verified live from `https://developers.jup.ag/docs/lend/borrow/api` on
2026-07-24 (Agent Scan Phase 3 Batch 5, card B1; wire contract REBUILT from a
live fixture recording in card B3 after B1's original types/schemas diverged
from the real wire shape — see
`../../../../../__tests__/solana/fixtures/lend-borrow/README.md`).

## Implemented Endpoints
- `GET /borrow/vaults`
- `GET /borrow/positions`
- `POST /borrow/operate`

## Deliberately Excluded
- `POST /borrow/operate-instructions` — owner decision (B1 card). This shelf
  never composes/signs raw instructions itself, only the ready-made
  `/operate` transaction.

## Local Module Rules
- `client.ts` mirrors upstream HTTP endpoints and returns raw wire responses.
- `validation.ts` enforces API key presence, Solana address validation,
  market-param reject-not-clamp, and signed-integer-string delta shape.
- `schemas.ts` (hardened card B4 — a Codex batch-5 blocker) validates every
  FINANCIALLY CONSUMED response field for real, not just its JSON type:
  `supplyToken`/`borrowToken.address` and `position.ownerAddress` are real
  base58 Solana addresses (32-byte decode, reusing `validateSolanaAddress`);
  `collateralFactor`/`liquidationThreshold`/`borrowable`/`withdrawable`/
  `minimumBorrowing`/`supply`/`borrow`/`dustBorrow` are unsigned base-10
  digit strings; `id`/`vaultId`/`nftId` are non-negative integers; `decimals`
  is bounded to the valid SPL range. Unknown keys still `.passthrough()`.
- `service.ts` adds no normalization — Borrow's response shapes are
  unambiguous (unlike Earn's documented `earnings`/`*-instructions`
  inconsistencies).
- No `lite-api.jup.ag` usage is allowed here.
- No `src/tools/chains/solana/*` imports are allowed here.

## Markets
- Two disjoint markets: `main` (default) and `ethena`. Vault/position IDs are
  scoped PER MARKET — the same numeric `vaultId`/`positionId` in different
  markets refers to different vaults/positions. Every endpoint accepts an
  optional `market` query param; an unrecognized value is REJECTED (never
  silently coerced to `main`).

## Read Endpoints
- `vaults` — `supplyToken`/`borrowToken` are NESTED token objects (`address`,
  `decimals`, `symbol`, `price`, ...) — NOT bare mint-address strings (B1's
  original mistake, fixed in card B3). Collateral factor (max LTV),
  liquidation threshold, borrowable/withdrawable liquidity, minimum borrowing
  are all DIGIT-STRING fields on the wire (also fixed in B3 — B1 modeled them
  as JSON numbers).
- `positions` — accepts one or more wallet addresses, returns raw supply
  (collateral), borrow (debt), and dust-borrow (residual ADDITIONAL debt —
  see "dustBorrow vs borrow" below) per open position (NFT), plus
  `ownerAddress` (used for a defense-in-depth owner match — never trust
  `positionId` alone to identify "this wallet's position", since ids are
  scoped per MARKET, not globally).
- Both endpoints' numeric amount fields (`totalSupply`/`totalBorrow`/`supply`/
  `borrow`/etc.) are raw BASE UNITS of the respective token's OWN `decimals`
  — the SAME convention `/operate`'s `colAmount`/`debtAmount` use, NOT the
  Read SDK's separate, internal fixed-1e9 "shares" scale. See the fixture
  README's citation (resolved from live vault-economics sanity checks across
  two independent markets, since no doc page states this explicitly).

## `/operate`
- One endpoint models the FULL lifecycle (create/deposit/withdraw/borrow/
  repay) via the sign of `colAmount` (collateral delta) and `debtAmount`
  (debt delta): `>0` = deposit/borrow, `<0` = withdraw/repay, `"0"` =
  untouched leg. `positionId: 0` creates a new position. The MIN_I128
  sentinel (`"-170141183460469231731687303715884105728"`) on either field
  means "close that leg entirely" (repay all debt incl. dust / withdraw all
  collateral).
- Returns `{ nftId, transaction }` — an unsigned base64 `VersionedTransaction`
  with NO `blockhashWithMetadata` (same transaction-only shape as Earn
  deposit/withdraw) — the caller (`vex-agent/tools/protocols/solana-jupiter/
  handlers/lend.ts`) always runs `prepareVersionedTx` in REPLACE/
  MANDATORY-HEIGHT mode.
- No documented error/rejection response shape exists (verified live) — same
  gap Earn's deposit/withdraw already has; a rejected request surfaces as a
  redacted, bounded HTTP error, mapped to the `route_not_found` pre-broadcast
  failure code (K1's stage/error mapping table default) by the handler.
- WSOL: the API does not wrap/unwrap native SOL (same behavior as Earn) — a
  vault whose `supplyToken`/`borrowToken` is the canonical WSOL mint
  (`So11111111111111111111111111111111111111112`) requires the wallet to
  already hold wrapped SOL; this shelf does not auto-wrap. Card B3 added an
  active pre-broadcast balance check (`handlers/lend-borrow.ts`'s
  `checkWsolFunding`) that fails CLEARLY, before requesting a transaction,
  when a deposit/repay leg needs WSOL the wallet does not have — the manifest
  description and the approval disclosure both state this requirement too.

## Unit-scale caveat (DOCS-GAP, see B1 + B3 delta logs)
`collateralFactor` is CONFIRMED live (raw/10 = percent, e.g. `"800"` = 80%).
`liquidationThreshold`'s own scale is NOT independently documented by prose —
three live fixtures (see the fixture README) all show a plausible
collateralFactor < liquidationThreshold < liquidationMaxLimit ordering under
the SAME raw/10 scale, so the protocol projector
(`vex-agent/tools/protocols/solana-jupiter/borrow-projector.ts`) applies it,
but this is STILL flagged explicitly wherever the formatted value is shown —
including, since card B3, in the human-facing approval disclosure text
itself ("scale unconfirmed ... pending live-gate verification"), not only in
code comments.

## `dustBorrow` vs `borrow` (DOCS-GAP, see B3 delta log)
`dustBorrow` is ADDITIONAL residual debt (accrued interest not yet folded
into the tracked `borrow` figure) sitting on the position ALONGSIDE `borrow`
— NOT a component already included inside it. True existing debt for risk
purposes is `borrow + dustBorrow` (the conservative, never-understate-risk
reading); see the fixture README's citation. `borrow-risk-preview.ts` sums
both when reading an existing position.
