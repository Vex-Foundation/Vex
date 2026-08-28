# Swap-integrity reference audit (2026-08-28)

Decisions adopted and rejected against the reference checkouts (agents-colab:
metamask-core, rabby, uniswap-interface) and the providers' primary sources,
for the quote-bound execution rebuild (Kyber + Uniswap lanes) and the
wrap/unwrap capability. Template: studio-mcp/wallet-reference-audit-2026-08-24.md.
Incident that forced this arc: 2026-08-27, Robinhood 4663 - quote 313,879.7 CCF
at 500 bps, execute re-quoted at broadcast time, confirmed fill 1,190.145 CCF
(263x worse, no revert).

## Measured provider facts (live, 2026-08-27, archives in the session scratchpad)

- Kyber POST route/build builds calldata from WHATEVER routeSummary the client
  passes: an original 4-minute-old summary, a tampered one (amountOut x10) and
  a stale-timestamp/garbage-checksum body were all accepted with code 0. The
  calldata minReturnAmount equals passed amountOut x (10000-slippageBps)/10000,
  decoded from both probes. No stale-route error code exists; checksum and
  timestamp are declared but not required on the POST body.
- Docs (OpenAPI 2.12.1): build "must contain the routeSummary as exactly
  returned by Get Swap Route". slippageTolerance omitted defaults to 0.
- Kyber serves wrap/unwrap as a "wrapped-native" pseudo-pool (1:1 on GET,
  1-raw-unit drift on build, slippage applied on top, ~105k gas vs ~28k for a
  bare deposit()).

## Adopted

1. One trade object from display to signature; no execute-time re-quote.
   Evidence: MetaMask ships calldata inside the quote and stops polling at
   submit (bridge-status-controller submitTx); Uniswap reads min-out off the
   quote with a conservative fallback; Rabby carries quote.tx unchanged. Ours:
   the approved routeSummary is persisted verbatim (raw JSON string + digest in
   swap_prequotes.route_ref) and the execute builds from it.
2. Decode-and-bind before signing (Rabby verify.tsx): the built calldata's
   embedded floor is asserted against the approved quote's floor immediately
   before the swap-leg signature. Failure is fail-closed and typed, never a
   warning.
3. Single-use, atomically claimed quote authority with supersession (a newer
   same-identity quote invalidates the older one even unexpired/unclaimed).
   No reference implements multi-execute of one quote; MetaMask's stop-polling
   at submit is the same intent.
4. Wrap/unwrap as a first-class non-swap (Uniswap WrapTrade: slippageTolerance
   0 and swapFee undefined at the TYPE level; Universal Router WRAP_ETH /
   UNWRAP_WETH are 1:1 commands with no price bound; Rabby DEX_ENUM.WRAPTOKEN
   bypasses aggregator/approval/verification). Ours: dedicated
   WalletWrapPrepare/WalletWrapConfirm, locally derived deposit()/withdraw()
   calldata, byte-for-byte {to,data,value} re-derivation at confirm.
5. Zero fee on wrap. Code-verified in Uniswap (WrapTrade swapFee: undefined)
   and Rabby (fee.ts: isWrapToken -> SWAP_FEE_RATE.FREE as the first branch).
   Ours is structural: kind='wrap' admits no fee role by DB constraint
   (migration 088), and an architecture test proves vex-fee.ts unreachable.
6. Price-impact gating thresholds: warn from 5 percent, ineligible from 15
   percent (Uniswap PRICE_DIFFERENCE_WARNING_THRESHOLD = 5, critical 10,
   legacy hard block 15; Rabby refuses at -5 percent USD loss and disables a
   quote whose simulation failed). Ours adds the distinct `unpriceable_output`
   state (output USD exactly 0 with priced input) that no reference needed,
   because their quotes carry server-priced minimums.
7. Honest venue errors (rule 90): the Uniswap no-route text now states what was
   probed (V2/V3 only; a v4-only pool is structurally invisible) instead of
   "may have no liquidity".

## Rejected

1. Routing wrap/unwrap through Kyber's wrapped-native pseudo-pool. Works, but
   applies slippage to a deterministic 1:1 conversion, drifts 1 raw unit at
   build, costs ~4x gas, and adds the 4221/unsupported-chain failure class.
   Contradicts all three references.
2. A per-chain router allowlist (my v1 plan). The lane already pins the one
   known router by strict equality; an allowlist would be a second source of
   truth. (Codex review, adopted.)
3. Uniswap-style re-quote-plus-re-acceptance at execute (1 percent adverse
   threshold, asymmetric). Richer UX than we need: our approval already binds
   one proposal; building from the approved summary and letting the chain
   enforce the floor is simpler and stricter. The pattern is recorded for a
   future auto-refresh feature.
4. Citing MetaMask for the zero-wrap-fee precedent. Not verifiable from the
   metamask-core clone (fee policy moved server-side; the old client rule
   lived in metamask-extension, which is not cloned). Uniswap + Rabby carry
   the citation.
5. "Type confirm above X percent impact" as a gating mechanism. Does not exist
   in current Uniswap code (the gate is a modal acknowledgement boolean plus
   the legacy 15 percent hard block). Not cited, not copied.
6. Rabby's two-sided 5 percent relative tolerance on the calldata min-out
   comparison. Our repo rule requires absolute money tolerances; we bind the
   floor exactly (with the measured 1-raw-unit build allowance) and refuse
   only a floor BELOW the approved one.
7. Re-creating the 2026-07-25 zero-tolerance floor. The removed design
   compared quote-floor vs build-floor at the same slippage, which reduced to
   "price must not have moved". The new binding has ONE base (the approved
   amountOut) with slippageBps as the tolerance; within-slippage movement
   passes by construction and a superseded/claimed/expired quote answers with
   a typed "request a fresh quote".
