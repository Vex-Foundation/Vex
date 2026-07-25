# Jupiter Swap API V2

Local reference for `src/tools/solana-ecosystem/jupiter/jupiter-swaps`.

## Verified From
- `https://dev.jup.ag/docs/llms.txt`
- `https://dev.jup.ag/docs/swap/index.md`
- `https://dev.jup.ag/docs/swap/order-and-execute.md`
- `https://dev.jup.ag/docs/swap/build/index.md`
- `https://dev.jup.ag/docs/swap/build/other-instructions.md`
- `https://dev.jup.ag/docs/swap/fees.md`
- `https://dev.jup.ag/docs/swap/migration.md`
- `https://dev.jup.ag/docs/swap/routing/index.md`
- `https://dev.jup.ag/docs/swap/advanced/gasless.md`
- `https://dev.jup.ag/docs/swap/advanced/compute-units.md`
- `https://dev.jup.ag/docs/swap/advanced/reduce-transaction-size.md`
- `https://dev.jup.ag/docs/swap/advanced/reduce-latency.md`
- `https://dev.jup.ag/portal/migrate-from-lite-api`
- Verified on `2026-03-30`
- `/build` param/response additions (`tipAmount`, `computeUnitPricePercentile`,
  `forJitoBundle`, `tipInstruction`) and `POST /tx/v1/submit` verified against
  `https://developers.jup.ag/docs/swap/build/index.md`,
  `https://developers.jup.ag/docs/transaction/submit.md`, and a live-recorded
  `GET /build` response, on `2026-07-23`.
- `2026-07-24`: `/tx/v1/submit` request hardening — `signedTransaction` now
  validated as base64, `tipAmount` as a non-negative integer. No new API
  research; internal review pass on the SDK layer added `2026-07-23`.
- `2026-07-24` (W5 design §6/R4, migration 049): the `/build` + `/tx/v1/submit`
  atomic flip. `solana.swap.quote`/`solana.swap.execute` (the only production
  callers of this module) now build EVERY quote/execute through `/build` with
  a pinned 25bps platform fee to the Vex treasury ATA (see `fee-swap.ts`), and
  submit exclusively through `/tx/v1/submit` (see `submit-prepared-tx.ts`) —
  `/build` and `/tx/v1/submit` are consequently no longer "unreachable from the
  agent" (the note below under `POST /tx/v1/submit` is now stale — kept as a
  record of the SDK-layer-only period, see the Local Module Map for the
  current wiring). `/order` + `/execute` (`service.ts`) have NO production
  caller left — see "Migration Notes".
- `2026-07-24` (B2, legacy cleanup): `service.ts` (the `/order`+`/execute`
  wrapper layer flagged above as callerless) DELETED — `getJupiterSwapQuote`/
  `executeJupiterSwap`/`buildSwapTransaction` and their `getSwapQuote`/
  `executeSwap`/`getSwapBuild` aliases, plus the file's own test
  (`jupiter-swap-v2-service.test.ts`), confirmed zero production callers by a
  fresh full-tree grep before deletion. `client.ts`'s low-level
  `jupiterSwapOrder`/`jupiterSwapExecute` bindings were left in place
  (`jupiterSwapBuild` is still live, used by `fee-swap.ts`) — out of this
  card's named scope; see "Migration Notes".

## Overview
Jupiter Swap API V2 unifies two swap paths behind:

- Base URL: `https://api.jup.ag/swap/v2`
- Auth: `x-api-key` header on every request

The two main paths are:

- `/order` + `/execute`
  - Jupiter's own "best default" integration path
  - Returns an assembled transaction
  - Competes across Metis, JupiterZ, Dflow, OKX
  - Managed landing via `/execute`
  - **W5 (2026-07-24): no production caller in this repo; B2 (2026-07-24):
    the wrapper layer deleted.** `service.ts`'s `getJupiterSwapQuote`/
    `executeJupiterSwap`/`buildSwapTransaction` (and their `getSwapQuote`/
    `executeSwap`/`getSwapBuild` aliases) are gone since the atomic flip
    below left them callerless; see "Migration Notes". The raw
    `jupiterSwapOrder`/`jupiterSwapExecute` bindings still exist in
    `client.ts` (unused, out of B2's scope)
- `/build`
  - Advanced path for custom transactions — returns raw instructions, you
    assemble/sign/send yourself
  - Metis only
  - **W5 (2026-07-24): THIS is Vex's production swap path.**
    `solana.swap.quote`/`solana.swap.execute` build every quote and execute
    through `/build` via `fee-swap.ts` (pinned 25bps platform fee to the Vex
    treasury ATA) and land exclusively through `/tx/v1/submit` via
    `submit-prepared-tx.ts` — see the Local Module Map below

## Local Module Map
- `types.ts`
  - Full wire contracts for `/order`, `/build`, `/execute`, `/tx/v1/submit`
  - Local summary result types for service helpers
- `validation.ts`
  - API key enforcement
  - param dependency and mutual-exclusion checks
  - query normalization
- `client.ts`
  - Low-level HTTP bindings
  - no UI amount conversion
  - no token symbol lookup
- `constants.ts` (W5)
  - product-owner-reviewed, hardcoded `/build` economics: `platformFeeBps=25`,
    default/max SOL tip, default CU-price strategy, landing mode
  - never derived from model/tool params
- `fee-swap.ts` (W5)
  - the ONE place that constructs a real fee-bearing `/build` request
    (`prepareFeeBearingJupiterSwap`) — `platformFeeBps`/`feeAccount` are ALWAYS
    the hardcoded constant + the derived treasury ATA, never caller-supplied
  - agent-controlled knob parsing/bounds (`resolveJupiterFeeSwapKnobs`)
  - the persisted fee disclosure (`jupiterFeePreviewSchema`/`buildJupiterFeePreview`)
    consumed by the approval preview and the prequote gate
- `build-assembly.ts` (W5)
  - turns a `/build` response's raw wire instructions into a real, unsigned
    `VersionedTransaction` (instruction ordering, address-lookup-table
    reconstruction)
- `fee-swap-revalidate.ts` (W5)
  - execute-time revalidation of a FRESH `/build` response against the
    PERSISTED quote (R4/R4b): economic floor, knob equality, fee-policy match,
    mint/amount equality
- `build-response-guard.ts` (Codex batch-4 closure blocker C2)
  - hostile-`/build`-RESPONSE validation, called from `fee-swap.ts`'s
    `prepareFeeBearingJupiterSwap` right after the response arrives and
    BEFORE any instruction is assembled/signed (both quote and execute):
    request-identity echo (mints/inAmount), the tip instruction's amount
    (decoded as a real System Program transfer, never trusted from
    label/position), the treasury fee ATA's presence in the swap
    instruction's own accounts, and every `computeBudgetInstructions` entry
    actually being a ComputeBudget-program instruction within an owner
    exposure cap. Fixes the gap `fee-swap-revalidate.ts`/the prequote
    hash-match gate never covered: those check the RESPONSE against a
    PERSISTED quote or a request hash — nothing previously checked the
    response against reality itself.
- `submit-prepared-tx.ts` (W5)
  - the ONLY consumer of `jupiterSwapSubmit` for a signed, staged transaction;
    compares the `/tx/v1/submit` response signature against the local
    (canonical) one — see `../shared/solana-transaction/prepare.ts` for the
    sign-without-send seam this feeds

## Endpoint Coverage

### `GET /order`
Purpose:
- quote-only when `taker` is omitted
- quote + assembled transaction when `taker` is present

Local low-level function:
- `jupiterSwapOrder(params)`

Covered request fields:
- `inputMint`
- `outputMint`
- `amount`
- `taker`
- `receiver`
- `swapMode`
- `slippageBps`
- `referralAccount`
- `referralFee`
- `payer`
- `priorityFeeLamports`
- `jitoTipLamports`
- `broadcastFeeType`
- `excludeRouters`
- `excludeDexes`

Covered response fields:
- `mode`
- `inputMint`
- `outputMint`
- `inAmount`
- `outAmount`
- `inUsdValue`
- `outUsdValue`
- `priceImpact`
- `swapUsdValue`
- `otherAmountThreshold`
- `swapMode`
- `slippageBps`
- `priceImpactPct`
- `routePlan`
- `referralAccount`
- `feeMint`
- `feeBps`
- `platformFee`
- `signatureFeeLamports`
- `signatureFeePayer`
- `prioritizationFeeLamports`
- `prioritizationFeePayer`
- `rentFeeLamports`
- `rentFeePayer`
- `swapType`
- `router`
- `transaction`
- `lastValidBlockHeight`
- `gasless`
- `requestId`
- `totalTime`
- `taker`
- `quoteId`
- `maker`
- `expireAt`
- `errorCode`
- `errorMessage`
- `error`

Local service helper:
- none (B2, 2026-07-24: `getJupiterSwapQuote` deleted, callerless since the
  `/build` atomic flip) — only the raw `jupiterSwapOrder(params)` binding
  above remains, itself unused in production

### `GET /build`
Purpose:
- fetch raw instructions for custom transaction assembly

Local low-level function:
- `jupiterSwapBuild(params)`

Covered request fields:
- `inputMint`
- `outputMint`
- `amount`
- `taker`
- `slippageBps`
- `mode`
- `dexes`
- `excludeDexes`
- `platformFeeBps`
- `feeAccount`
- `maxAccounts`
- `payer`
- `wrapAndUnwrapSol`
- `destinationTokenAccount`
- `nativeDestinationAccount`
- `blockhashSlotsToExpiry`
- `tipAmount` (SOL tip in lamports; adds `tipInstruction` for `/tx/v1/submit`)
- `computeUnitPricePercentile` (`"medium"` / `"high"` / `"veryHigh"` / integer 0-10000 bps)
- `forJitoBundle`

Covered response fields:
- `inputMint`
- `outputMint`
- `inAmount`
- `outAmount`
- `otherAmountThreshold`
- `swapMode`
- `slippageBps`
- `priceImpactPct` (DOCS-GAP: the live API returns this on `/build` too; the
  official `/build` reference page does not list it — only `/order` does)
- `routePlan`
- `computeBudgetInstructions`
- `setupInstructions`
- `swapInstruction`
- `cleanupInstruction`
- `otherInstructions`
- `tipInstruction` (present, possibly `null`, only reliably observed when `tipAmount` was requested)
- `addressesByLookupTableAddress`
- `blockhashWithMetadata`

Local service helper:
- none (B2, 2026-07-24: `buildSwapTransaction` deleted, callerless since the
  `/build` atomic flip) — production `/build` calls go through `fee-swap.ts`'s
  `prepareFeeBearingJupiterSwap` (see the Local Module Map), not a
  `service.ts` wrapper

### `POST /execute`
Purpose:
- execute a signed transaction returned by `/order`

Local low-level function:
- `jupiterSwapExecute(request)`

Covered request fields:
- `signedTransaction`
- `requestId`
- `lastValidBlockHeight`

Covered response fields:
- `status`
- `signature`
- `code`
- `inputAmountResult`
- `outputAmountResult`
- `error`

Local service helper:
- none (B2, 2026-07-24: `executeJupiterSwap` deleted, callerless since the
  `/build` atomic flip). Its old flow (resolve tokens → convert UI amount →
  `/order` with `taker` → sign locally → `/execute` → combined result) is
  superseded by `solana.swap.execute`'s `/build` + `/tx/v1/submit` staged
  write protocol (`handlers/core.ts`).

### `POST /tx/v1/submit`
Purpose:
- submit ANY signed Solana transaction (not tied to a prior `/order`) through
  Jupiter's self-managed, tip-based landing pipeline
- the only way to land a `/build`-assembled transaction: `/build` output has
  no `requestId`, so it cannot go through `/execute`

Local low-level function:
- `jupiterSwapSubmit(request)`

Covered request fields:
- `signedTransaction`

Covered response fields:
- `signature`

**W5 (2026-07-24): wired.** `submit-prepared-tx.ts`'s `submitPreparedTx` is the
ONE caller — `solana.swap.execute` submits every fee-bearing `/build`
transaction through it (see the Local Module Map). Building the transaction,
computing the required ≥0.001 SOL tip to one of Jupiter's 16 designated tip
accounts (done in `fee-swap.ts`, owner-reviewed default/cap), and staying
within Solana's 1232-byte transaction limit remain the caller's
responsibility; this module still only validates that `signedTransaction` is
non-empty and base64-encoded before calling the endpoint.

## Validation Rules Implemented
- `JUPITER_API_KEY` is mandatory
- `referralAccount` and `referralFee` must be provided together
- `dexes` and `excludeDexes` are mutually exclusive on `/build`
- `destinationTokenAccount` and `nativeDestinationAccount` are mutually exclusive on `/build`
- `feeAccount` is required when `platformFeeBps > 0`
- atomic `amount` must be a positive integer string
- supported `swapMode` is `ExactIn`
- supported build `mode` is `fast`
- `computeUnitPricePercentile` must be `medium`/`high`/`veryHigh` or a numeric value in range 0-10000 bps
- `tipAmount` must be a non-negative integer (lamports)
- `/tx/v1/submit`'s `signedTransaction` must be non-empty and base64-encoded
- Solana public keys are normalized and validated for wallet/account params

## Routing Notes
- `/order` without optional params can route across Metis, JupiterZ, Dflow, OKX
- `/order` with optional params may fall into `manual` mode and reduce router availability
- `/build` is Metis only
- `receiver`, `referralAccount`, `referralFee`, and `payer` can disable RFQ routing

## Fee Notes
- `/order`
  - Jupiter platform fee may apply
  - referral fee support exists through `referralAccount` + `referralFee`
- `/build`
  - no Jupiter swap fee
  - integrator fee support via `platformFeeBps` + `feeAccount`

Do not hardcode pricing tiers or portal commercial plans here.
Use:
- `https://portal.jup.ag/pricing`
- `https://dev.jup.ag/portal/rate-limit.md`

## Gasless Notes
- `/order` can be gasless in Jupiter-managed flows
- `gasless` is preserved from `/order` in the low-level response
- `payer` is supported on both `/order` and `/build`

## Build-Specific Notes
- `/build` returns instruction groups in this logical order:
  1. compute budget
  2. setup
  3. your pre-swap instructions
  4. swap
  5. your post-swap instructions
  6. cleanup
- `blockhashWithMetadata` is preserved
- `addressesByLookupTableAddress` is preserved
- compute unit limit is not returned by Jupiter and should be simulated separately

## Migration Notes
- Old Ultra `/order` + `/execute` logic should be treated as replaced by Swap V2 `/order` + `/execute`
- `lite-api.jup.ag` should not be used for this module
- future rewiring should migrate legacy consumers to `src/tools/solana-ecosystem/jupiter/jupiter-swaps`
- **W5 (2026-07-24, design §6/R4, migration 049) — the `/build` atomic flip:**
  `solana.swap.quote`/`solana.swap.execute` moved from `service.ts`'s
  `getJupiterSwapQuote`/`executeJupiterSwap` (`/order` + `/execute`) to
  `fee-swap.ts`'s `prepareFeeBearingJupiterSwap` (`/build` +
  `/tx/v1/submit`), so the quote and execute paths share the exact same
  pinned economics (25bps fee, treasury ATA, tip/CU/DEX-filter knobs) by
  construction.
- **B2 (2026-07-24, legacy cleanup) — `service.ts` deleted:** the `/order`+
  `/execute` wrapper functions (`getJupiterSwapQuote`/`executeJupiterSwap`/
  `buildSwapTransaction` and their `getSwapQuote`/`executeSwap`/`getSwapBuild`
  aliases) had zero production callers left as of the flip above (confirmed
  by the K4 delta log, re-confirmed by a fresh full-tree grep before
  deletion) — removed along with their own test file
  (`jupiter-swap-v2-service.test.ts`) and the `index.ts` barrel export. The
  raw `jupiterSwapOrder`/`jupiterSwapExecute` bindings in `client.ts` are now
  also unreferenced by production code as a consequence, but were left in
  place — out of this card's named scope (`jupiterSwapBuild` stays live via
  `fee-swap.ts`).

## Local Usage Guidance
- Use `client.ts` when exact wire payloads matter
- Use `fee-swap.ts` for the production Vex swap path (`/build` +
  `/tx/v1/submit`, fee-bearing, wallet-scoped)
- `service.ts` (the `/order` + `/execute` wrapper layer — symbol-to-mint
  resolution, UI amount conversion, signed `/execute`, normalized summaries
  with `raw` preserved) was deleted (B2, 2026-07-24, no production caller).
  A FUTURE consumer needing the plain `/order` + `/execute` path would build
  a new wrapper on `client.ts`'s `jupiterSwapOrder`/`jupiterSwapExecute`
  rather than resurrecting the deleted file verbatim.
