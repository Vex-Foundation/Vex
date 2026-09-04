# Balance-read reference audit (2026-08-31)

This note records the decisions taken from the production wallet references for
the balance-read repair arc. It follows the decision-ledger shape in
`studio-mcp/wallet-reference-audit-2026-08-24.md`. References were read at:

- `agents-colab/metamask-core` at `bf64cce`
- `agents-colab/rabby` at `91404b1`
- `agents-colab/uniswap-interface` at `da6d36f`

The references are pattern evidence, not authorities for Vex. Vex is consumed
by a model, persists local wallet state, and signs with the user's own funds, so
several display-oriented reference choices are intentionally stricter here.

## Ten checked patterns and decisions

Eight reference patterns were adopted faithfully or strengthened. Two unsafe
reference behaviors were rejected.

1. **ADOPTED: route and executability are separate facts.** MetaMask preserves
   quote rows while attaching `insufficient-source-balance`
   (`metamask-core/packages/transaction-pay-controller/src/utils/quotes.ts:762-775`).
   Rabby likewise keeps a quote while zeroing its pre-execution data and marking
   it insufficient (`rabby/src/ui/views/Swap/hooks/quote.tsx:466-482`,
   `QuoteItem.tsx:393-414`). Vex keeps the provider route, but only the
   `executable` member of the eligibility union may seed execution authority
   (`src/vex-agent/tools/protocols/quote-authority/eligibility.ts:1-7,68-105`).
   Balance-specific eligibility members are frozen for WP2 and are not claimed
   as implemented by Batch 2.

2. **ADOPTED: cached balance is advisory, direct chain balance gates spend, and
   the gate is repeated.** MetaMask exposes a cached `getTokenBalance`
   (`transaction-pay-controller/src/utils/token.ts:47-75`) but uses
   `getLiveTokenBalance` for validation (`utils/validation.ts:193-217`) and again
   immediately before submission (`strategy/server/server-submit.ts:529-565`,
   `strategy/relay/relay-submit.ts:583-618,645-655`). Vex adopts the same two-gate
   ownership in frozen contract C2: quote-time evidence for model reasoning and
   an authoritative read in the pre-sign window. WP2 owns the implementation.

3. **ADOPTED AND STRENGTHENED: unavailable is not insufficient, and shortfall
   facts remain structured.** MetaMask has separate
   `balance-unavailable` and `insufficient-source-balance` reasons
   (`transaction-pay-controller/src/types.ts:499-510`) and formats Required,
   Current and Missing without guessing decimals (`utils/validation.ts:137-190`).
   Vex adopts those distinct outcomes in frozen contract C2. Bridge metadata
   already applies the same principle by returning a typed unavailable identity
   instead of inventing symbol or decimals
   (`src/vex-agent/tools/protocols/bridge-token-identity.ts:167-200`).

4. **ADOPTED AND STRENGTHENED: raw and human amounts travel together.** MetaMask
   carries `rawBalance: Hex` and human `balance: string` on one asset
   (`assets-controllers/src/selectors/token-selectors.ts:67-95`). Uniswap carries
   a float `quantity` plus optional exact `quantityRaw`, explicitly documenting
   float64 precision loss (`uniswap-interface/packages/uniswap/src/features/dataApi/types.ts:84-98`).
   Vex strengthens both for a model-visible payload: `balanceRaw` is an exact
   base-10 integer string and `balance` is an exact human string. One owner
   derives the latter and retains unprojectable rows with a named reason
   (`src/vex-agent/tools/protocols/amount-display.ts:90-105,143-175`).

5. **ADOPTED AND STRENGTHENED: decimals are strict decision data.** MetaMask
   rejects missing decimals, disagreement with contract decimals, non-integers,
   and values outside 0 through 36
   (`assets-controllers/src/TokensController.ts:1050-1075`). Rabby still uses
   `decimals || 18` on signing displays, including
   `rabby/src/ui/views/Approval/components/SignTx.tsx:752,963,2204`.
   Vex adopts MetaMask's bound, preserves legal zero decimals, rejects Infinity,
   and never guesses 18 (`src/vex-agent/tools/protocols/amount-display.ts:60-81`).

6. **ADOPTED AND STRENGTHENED: missing valuation propagates as missing, not
   zero.** Uniswap distinguishes absent categories from a real zero and only
   computes derived change when every included slice reports it
   (`uniswap-interface/packages/uniswap/src/data/apiClients/dataApiService/balances/getWalletBalances/getWalletBalances.ts:95-148`).
   MetaMask's aggregate has no completeness field and sums only retained priced
   rows (`assets-controllers/src/balances.ts:26-31,225-241,320-332`). Rabby's
   portfolio projection defaults missing price to zero
   (`rabby/src/ui/utils/portfolio/project.ts:344-358`). Vex represents an absent
   price as `valueUsd: null` plus `priceUnavailable: true`
   (`src/vex-agent/tools/protocols/amount-display.ts:153-175`). Full inventory and
   valuation completeness remain separately owned by frozen contract C3.

7. **ADOPTED AND STRENGTHENED: a native derivative may share price, never
   balance.** MetaMask stores staked balance separately from account balance
   (`assets-controllers/src/AccountTrackerController.ts:130-140`) and gives
   staked native its own row while looking up native market data
   (`assets-controllers/src/balances.ts:152-178`). Its multichain selector uses
   the CAIP `slip44` namespace as the native discriminator
   (`assets-controllers/src/selectors/token-selectors.ts:425-447`). Vex applies
   the rule to SOL and wSOL, mapping structural asset identity, route mint,
   pricing mint and persisted address separately
   (`src/tools/solana-ecosystem/shared/solana-asset-identity.ts:1-18,36-79`). The
   snapshot always creates native SOL from account lamports and emits wSOL as a
   separate SPL row (`src/tools/solana-ecosystem/balances/wallet-snapshot.ts:95-129`).

8. **ADOPTED AND STRENGTHENED: indexer residue and display bounds are explicit.**
   MetaMask's ordered balance fetchers carry `remainingChains`,
   `unprocessedChainIds`, and `unprocessedTokens` into later fetchers
   (`assets-controllers/src/TokenBalancesController.ts:895-1008`). Rabby's
   low-value collapse reports both count and value and provides the full-list
   interaction (`rabby/src/ui/views/CommonPopup/AssetList/TokenLowValueItem.tsx:35-60`,
   threshold in `src/ui/utils/portfolio/expandList.ts:5-34`). Vex's Blockscout
   client keeps valid residue, reports invalid rows and unprocessed addresses,
   and marks the inventory incomplete rather than empty
   (`src/tools/blockscout/client.ts:188-193,220-271`; validator accounting at
   `src/tools/blockscout/validation.ts:199-283`). Agent balance trimming likewise
   reports omitted unpriced holdings (`src/vex-agent/tools/internal/wallet/read.ts:661-710`).

9. **REJECTED: silently presenting indexer failure as a complete short list.**
   MetaMask catches token-detection errors without surfacing them and returns
   whatever its fetchers accumulated
   (`assets-controllers/src/TokenBalancesController.ts:958-965,1009-1029`). Vex
   WP6a returns a typed incomplete result, so provider failure is never evidence
   of an empty wallet (`src/tools/blockscout/client.ts:68-93,115-140,262-269`).
   Frozen contract C3 requires WP6b to preserve old verified rows without
   refreshing their timestamp; wallet publication is not part of WP6a.

10. **REJECTED: filtering identity rows by provider risk or core-token labels.**
    Rabby's default portfolio filters remove suspicious, unverified and
    non-core rows before display (`rabby/src/ui/utils/portfolio/lpToken.ts:5-29`).
    Vex shows every identified token. Provider reputation remains an optional
    verbatim label and cannot remove a valid ERC-20 candidate
    (`src/tools/blockscout/validation.ts:29-41,181-192`). A recognized non-ERC-20
    row is omitted only because this client is explicitly ERC-20-scoped, and its
    type and count are reported (`validation.ts:221-231,268-279`).

## Four deliberate money-path contradictions

These departures are intentional and must not be normalized back to the
reference behavior during later cleanup.

1. **Decimal raw strings instead of reference-native hex or float fields.**
   MetaMask's public asset row uses hex raw balance and Uniswap exposes a float
   first (`token-selectors.ts:84-94`; Uniswap `types.ts:84-94`). Vex returns a
   base-10 atomic string beside a full-precision human string because its
   consumer is a model. Hex invites unit confusion and float loses exactness.
   The reason and the incident are recorded at
   `src/vex-agent/tools/protocols/amount-display.ts:90-99,143-160`.

2. **No `pending` to `latest` safety fallback.** MetaMask first reads pending but
   falls back to latest after an error
   (`transaction-pay-controller/src/utils/token.ts:369-389`). Rabby reads latest
   for native gas balance (`rabby/src/utils/transaction.ts:746-793`). Frozen
   contract C2 requires pending state for spend authorization: failure becomes
   `balance_unavailable`, because latest can ignore an in-flight spend. This is
   a WP2 obligation, not a Batch 2 implementation claim.

3. **Balance-read failure stays unavailable instead of becoming insufficient.**
   MetaMask's bridge catches a balance-read error and sets insufficient true so
   its backend still returns quotes
   (`bridge-controller/src/bridge-controller.ts:620-640`). Vex may still return
   route information, but its authorization result preserves the unavailable
   state and fails closed. That distinction is frozen in C2 and mirrored by the
   current typed bridge metadata degradation
   (`src/vex-agent/tools/protocols/bridge-token-identity.ts:167-200`).

4. **EVM native aliases use a sentinel predicate; Solana native identity is
   structural.** MetaMask itself accepts four leaked native encodings, including
   zero address, empty string and SLIP-44 fragments
   (`bridge-controller/src/utils/bridge.ts:187-201`). Vex's EVM bridge adapters
   also receive provider-defined native aliases and decide native identity at
   that adapter boundary
   (`src/vex-agent/tools/protocols/bridge-token-identity.ts:75-99`). This is safe
   for the EVM lane because native ETH and wrapped ETH have distinct provider
   addresses and no balance row is keyed by the route alias. Solana is different:
   native SOL and wSOL share Jupiter's route and pricing mint. An address
   predicate there would recreate the exact native/wrapped balance collision
   this arc removes, so `kind` is authoritative and address-shaped values are
   storage or routing forms only
   (`src/tools/solana-ecosystem/shared/solana-asset-identity.ts:1-18,62-90`).

## Reference caveats

- MetaMask has both strict token-add decimals validation and a weaker portfolio
  display check (`assets-controllers/src/balances.ts:104-105`). The strict path
  is the adopted money-path precedent.
- Rabby's security and portfolio provider types are partly supplied by external
  packages. This audit cites only behavior visible in the pinned checkout.
- Uniswap's portfolio completeness model concerns requested aggregate
  categories, not token-enumeration indexers. Vex adopts its zero-versus-missing
  discipline, not an unsupported claim that it solves inventory discovery.
