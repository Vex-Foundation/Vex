# Swap execution quality, 2026-09-09

## Authority contract

| Field | Authority | Display | Final enforcement |
| --- | --- | --- | --- |
| Wallet and chain | Selected wallet scope and matched prequote | Approval card | Scope, chain and offline signer checks |
| Assets, decimals, input, recipient and router | Digest-verified snapshot and deployment | Quote and approval card | Calldata equality and decoded fields |
| Minimum output and slippage | Original accepted quote | Quote and approval card | Unchanged encoded floor and fresh simulation |
| Vex fee and receiver | Product fee policy, bound disclosure | Quote and approval card | Fee-statement equality and calldata guard |
| Ordered transaction roles | Snapshot debit plan | Spendability card | Exact role comparison before claiming |
| Per-gas fee ceiling | Quote-time observation plus explicit headroom | Spendability card, quote and execution result | Current fees and final serialized request must fit |
| Gas units and native debit | Fresh per-leg estimate plus existing gas-unit headroom | Estimated spendability, not a total spending ceiling | Final balance check includes remaining legs at their approved fee ceilings and the reserve |
| Expiry and single use | Prequote row, digest and atomic claim | Approval expiry | Revalidated claim and pre-sign fence |

Cases covered by the design: native and ERC-20 input; no allowance, exact grant,
reset then grant; optional post-success Vex fee; EIP-1559 and legacy fees;
fee decrease, rise within ceiling, rise beyond ceiling, missing price and mode
change; expired, superseded and changed-leg proposals. Headroom is established
before approval. An existing cap never receives new headroom at execute time.

The existing approval is a per-gas maximum, not a frozen total gas bill. Gas
units remain unbound because the documented Base estimate varied 2.07x across
12 blocks. This task preserves that contract and makes its wording explicit.

## Reading record and reference decisions

Read `/home/kubas/Vex/.claude/CLAUDE.md`, all 12 Markdown rules in
`/home/kubas/Vex/.claude/rules/`, and `/home/kubas/Vex/package.json` first.
The harness file was read as startup context; its workflow was not invoked.

MetaMask reference paths under `agents-colab/metamask-core/packages/`:

- `gas-fee-controller/src/GasFeeController.ts`: refresh entry point, per-chain
  state and polling lifecycle. Adopt fresh estimates; reject a new background
  poller because these operations already own bounded request lifetimes.
- `gas-fee-controller/src/determineGasFeeCalculations.ts` and `gas-util.ts`:
  low/medium/high estimates and fallback pricing. Adopt separating observations
  from chosen fee parameters. Reject copying tiers or numerical multipliers
  without measurements on the target chains.
- `transaction-controller/src/gas-flows/DefaultGasFeeFlow.ts` and its test:
  EIP-1559 and legacy conversion. Adopt mode-specific fee fields; never add
  priority fee to maxFeePerGas when computing the maximum debit.
- `transaction-controller/src/utils/gas.ts` and `gas.test.ts`, especially
  `addGasBuffer`: adopt buffering fresh estimates. Keep Vex's independently
  measured gas-unit policy rather than copy MetaMask's 1.5 multiplier.
- `transaction-controller/src/utils/gas-fees.ts`: refresh suggested fees while
  distinguishing custom limits. Adopt sign-time repricing under an approved
  ceiling; reject replacing an approved limit with a higher estimate.
- `studio-mcp/wallet-reference-audit-2026-08-24.md`: preserve whole-card and
  digest binding, nonce ownership, offline signing and unknown-outcome handling.
  Mutable open approvals and payload-changing retries remain rejected.
- `balance-reads/wp2-signing-pin-note-2026-08-31.md`, especially WP2-K, WP2-U
  and F-EVM: the old ceiling equals the quote observation; Uniswap's live check
  correctly prevents signing an underpriced cap but therefore rejects even a
  0.05% increase. KyberSwap compares prepared fees with its sealed quote cap.

Implementation inspection includes both quote and execute handlers, their
spendability and debit-plan owners, final-request gates and tests, shared
pre-sign revert classification and tests, route USD fields, AgentScan reporting
and settlement-decode provenance, shared venue guidance, navigation declarations,
managed-body budget and generated prompt and instruction artifact tests.

## Venue guidance verification

Three new assertions failed against the old behavior: one managed-body case
and both protocol declarations. After the change, the four scoped suites passed:
213 tests. Prompt snapshots and instruction goldens were regenerated through
their existing explicit update flags. No v4 implementation or deployment table
was changed.

## Fee drift and chosen ceiling

Evidence: `src/__tests__/fixtures/swap-quality/fee-drift.json`. Five sequential
samples per configured execution endpoint, 15:15:29-15:18:18 UTC, about 169
seconds. Both selected endpoints were bundled, with no user override present.

| Chain | Observed base fees, wei/gas, in time order | Largest upward step | Largest absolute step |
| --- | --- | --- | --- |
| Robinhood 4663 | 187086000, 181368000, 182406000, 184606000, 180578000 | 1.20610% | 3.05635% |
| Base 8453 | 10675860, 10437554, 10056967, 9754633, 9248015 | None; all steps fell | 5.19361% |

Chosen headroom: **1500 bps, or 15%**, over the observed fee estimate. Twice
this sample's largest absolute interval movement is 10.38722%; rounding that
up to a five-percentage-point increment gives 15%. This covers both directions
of the measured movement rather than calibrating only to the quiet upward
sample. It is a small-sample margin, not a guarantee about future congestion.
A larger rise still requires a fresh quote and approval.

The existing viem 2.54.3 estimate already uses a default 1.2 base-fee
multiplier plus priority fee. Re-read in the installed
`_esm/actions/public/estimateFeesPerGas.js`; the new 15% is explicitly over
that observed estimate, not a claim that it is the raw base fee. Integer
arithmetic rounds ceilings upward to the next wei. Priority is bounded
separately and is never added to maxFeePerGas for total-debit arithmetic.

The quote prices all legs and its reserve at the new ceiling before sealing
it. `feeHeadroomBps` is optional for old stored quotes, is in the canonical
snapshot digest, and is displayed with the actual ceiling on the spendability
card. Old quotes receive no new headroom at execute time. Both quote and
execution outputs echo the ceiling. Uniswap refreshes fee parameters before
its final fence; KyberSwap checks the freshly prepared request against the
same sealed ceiling. Missing prices, mode changes and higher prices remain
refusals. The installed viem wallet action's unconditional `getChainId` was
re-read too; the offline account-signing boundary remains unchanged.

## Latency evidence and changes

Evidence and replay commands are in
`src/__tests__/fixtures/swap-quality/README.md`, with complete timing tables in
`latency-baseline.json` and `latency-after.json`. The real quote and execute
handlers ran on Base and Robinhood with native input, real safety/provider/RPC
reads, an isolated in-memory ledger, and an account signer that always throws
before producing bytes. All four final paths reached that disabled signer.
No transaction hash was staged and no broadcast method was permitted.

| Venue and chain | Quote, ms | Execute through final pre-sign checks, ms | Execute HTTP reads | RPC/provider time within execute, ms |
| --- | --- | --- | --- | --- |
| KyberSwap Base | 7950 | 6256 | 14 | 2459 |
| KyberSwap Robinhood | 7621 | 5506 | 12 | 2331 |
| Uniswap Base, full-discovery baseline | 9560 | 8014 | 20 | 2440 |
| Uniswap Base, accepted-path refresh | 6700 | 6711 | 16 | 2174 |
| Uniswap Robinhood, full-discovery baseline | 14288 | 12050 | 27 | 4846 |
| Uniswap Robinhood, accepted-path refresh | 11857 | 5606 | 13 | 2022 |

The baseline reproduces a 26.338-second quote-to-pre-sign path on Robinhood.
The after capture is 17.463 seconds. Quote/cache/provider variation contributes
to that difference; the directly attributable saving is the route phase:
1515 -> 300 ms on Base and 6709 -> 412 ms on Robinhood. Execute totals improve
by 1303 ms and 6444 ms respectively. The probe adds 250 ms of pacing per HTTP
read, so these totals deliberately include politeness overhead. The baseline
also ran alongside fixture tests; its CPU load is a comparison limitation.

Production transition logs now carry one operation identifier, named phases,
outcome and elapsed time, without addresses, payloads or keys. Independent
input/output metadata reads start together and both settle before continuing.
Uniswap stores a bounded, digest-bound route hint and refreshes that path with
one chain quote instead of searching every candidate again. The fresh output
is still compared with the original floor before claiming. A vanished path
requires a new quote rather than silently changing the transaction's floor.
Old snapshots without a hint retain full route discovery.

Not shortened: fresh gas estimation, the per-wallet nonce lock and reservation,
current fee reads, final balance/debit checks, remaining legs priced at their
approved ceilings, L1 fee reads, calldata/floor validation and the single-use
claim. KyberSwap's advisory quote-time build is not promoted into executable
calldata; execute still builds from the sealed provider summary and verifies
that build. The measurement did not reproduce 20-30 seconds on these small
KyberSwap native-input routes and did not measure an allowance confirmation or
a human's approval wait.

The first direct Robinhood quote probes correctly returned
`balance_unavailable` when the installed pending-debit database read was not
available. The isolated live harness demonstrates the chain and handler path;
it does not prove that installation's pending ledger is healthy.

## Slippage refusal and observed shortfall

The remedy now says to re-quote at the same slippage first. An increase must
stay inside the user's stated limit or receive new authorization. The floor
is never lowered for execution, and no signature or broadcast is retried.

After a definitive pre-sign slippage refusal, a separate, bounded three-second
`eth_call` can observe output using a private one-unit diagnostic floor. That
copy is local to a module accepting only a read client and returning only an
amount. It cannot reach a signer or replace the approved request. The refusal
remains a refusal even if this later read succeeds. Results explicitly label
the amount as a post-refusal diagnostic, state quoted output, approved floor,
simulated output and exact raw-unit shortfall. If the diagnostic cannot run,
the amount and shortfall stay null. V2 fee-on-transfer methods return no output
amount and are deliberately not guessed at.

Live evidence: `output-diagnostics.json`. Counterfactual high floors were used
only in read-only calls to force the refusal, then the output was observed:

| Venue / chain | Quoted output raw | Diagnostic output raw | Difference from quote |
| --- | --- | --- | --- |
| KyberSwap / Base | 248311 | 248308 | 3 USDC raw units |
| KyberSwap / Robinhood | 359501266213279104 | 359496902919931880 | 4363293347224 VIRTUAL raw units |
| Uniswap V3 / Base | 248172 | 248172 | 0 |
| Uniswap V3 / Robinhood | 359682455560571200 | 359682455560571200 | 0 |

These prove the observation mechanism, not a naturally occurring 10%-slippage
failure: the refusal floor in the probe was deliberately counterfactual. A
zero diagnostic floor was rejected by KyberSwap; one raw unit worked on both
chains. The output is from the later diagnostic call, not an invented return
value from the reverted estimate. Uniswap dependent-leg errors retain their
existing outer handling; an exact output is unavailable on that branch.

## Price-reference decisions

Previously KyberSwap computed `(amountInUsd - amountOutUsd) / amountInUsd`
from its provider's two USD legs. Uniswap computed impact only for a direct V2
path using its pool reserves; V3 and multihop paths had no measured impact.

KyberSwap now prefers an independent DexScreener reference when available.
The existing public price reader and normalized, outlier-screened pool selector
supply prices for the exact chain and assets, including quote-side inversion
and wrapped-native resolution. The final-review fix below requires a full pool population per pricing
asset; a population is reused between assets only when their pricing addresses
are identical. Token amounts remain integers through valuation. A
negative provider impact, an unusable USD leg, or an absolute discrepancy above
one dollar marks the provider reference unreliable; the chosen independent
reference still decides even for smaller discrepancies. Its source is explicit
in the verdict. This is an absolute discrepancy flag, not a tolerance that
scales with trade size or weakens the output floor.

Uniswap keeps its existing direct-V2 reserve reference. Where that measurement
is unavailable, it uses the same independent reference for impact and USD
estimates. The 15% cap remains in the shared eligibility owner. The accepted
USD prices are sealed in quote provenance and carried into activity estimates;
the actual AgentScan mapper revalues against those same prices, refusing to
fall back to inflated columns if the stored reference identity is malformed.
KyberSwap's fee-USD estimate uses the corrected input valuation too.

The requested `agentscan-reporting.ts` is the reporting repository and
`agent-activity/settlement-decode.ts` carries receipt-decoder identity hints.
Neither computes these USD prices. The actual mapper is
`src/vex-agent/agentscan/mapper.ts`; that is the consumer changed, alongside
both activity producers. No reporting SQL or settlement-decoder contract was
changed.

Limits: the existing DexScreener reader has a 30-second local cache; that does
not prove upstream freshness. If no independent price is available, the venue's
existing conservative eligibility behavior remains and the result says that
no independent reference was available. Old activity rows without reference
provenance cannot be retroactively corrected without historical evidence.

## File-growth decisions

- `src/tools/uniswap/execute.ts`: 817 -> 454 lines. The fee-cap classes and
  policy moved behind the stable facade to `fee-cap-gate.ts`; new fee logic is
  there. No growth of the existing execution facade.
- KyberSwap `quote-spendability.ts`: 945 -> 945 lines. Retained its cohesive
  debit-plan and pre-sign ownership. Only quote-ceiling wiring and the named
  refusal changed; new policy lives in sibling/shared modules.
- `studio/managed-block.test.ts`: 765 -> 767 lines. Added two assertions to the
  existing maximum-input budget experiment. Splitting that cohesive suite for
  two assertions would obscure the budget it protects.

## Regression evidence

- Venue text: 3 new failures against old wording, then green source, generated
  prompt and instruction artifacts. Both managed-body and static-prompt
  ceilings remain unchanged; repetition was shortened in the venue sections.
- Fees: old behavior failed the headroom snapshot assertion and sign-time
  repricing assertion. Both venue gates test a 0.05% rise, an above-ceiling
  refusal and preservation of old ceilings.
- Slippage: the old remedy failed the same-slippage/user-limit assertion.
- References and AgentScan: restoring old provider-only valuation produced
  5 failures. Restoring full rediscovery and unmeasured Uniswap impact produced
  3 failures. The genuine 47% independent-reference case still refuses.
- Diagnostics: removing the output observation produced a red handler test;
  the real calldata tests prove the diagnostic changes only its private floor
  and never changes or stages the approved request.

No commits, branch changes, stash, reset, dependency additions or v4 changes.
`src/tools/uniswap/deployments.ts`, `quote.ts` and `types.ts` are untouched.

## Resume review

The preserved diff was reviewed again against all four requested items. The
resume review added fee-ceiling echoes on Uniswap pre-sign refusal, mined-revert
and pending results, and removed a floating-point USD round trip from KyberSwap
independent-reference eligibility. The exact 15% boundary now uses the integer
valuation result. Three regression cases failed before those corrections and
passed afterwards. The boundary reproducer values the input at 0.3 USD and
output at 0.255 USD, where floating-point subtraction previously produced an
impact just below 15%. A persisted approval-preview test checks the numerical
ceiling and its explicit 15% headroom text.

Optional snapshot fields preserve the old canonical digest when absent. New
rows include their headroom, route hint and chosen price reference in the seal.
An older runtime that drops those fields cannot match the new digest and must
request a new quote; it cannot silently execute with less authority bound.

Verification on resume uses one process at a time and Vitest `--maxWorkers=3`.
No new archive or comparison tree was made. The earlier test-type ratchet
reported 87 over-baseline diagnostic fingerprints versus 88 at the starting
commit, with no additions in the comparison. That optional check was not
claimed green; the final production TypeScript check is reported separately.

## Final verification, 2026-09-10

All resumed verifiers ran sequentially. Vitest used `--maxWorkers=3` on every
run. No comparison archive was created on resume.

| Check | Exact result |
| --- | --- |
| `pnpm exec tsc --noEmit -p tsconfig.json` | Exit 0, no diagnostics |
| Required root Vitest command below | 550 files passed, 2 skipped; 9999 tests passed, 3 skipped; exit 0 |
| Prompt and AgentScan command below | 31 files, 375 tests passed; exit 0 |
| Live handler command below | 1 test passed; all four venue/chain paths reached the disabled signer; exit 0 |
| `pnpm run check:em-dash` | Exit 0, no added em dashes |
| `pnpm run test:unsafe-escapes` | Exit 0, no unsafe escapes, focused tests, test deletions or baseline changes |
| `git diff --check` | Exit 0 |

```sh
pnpm exec vitest run --maxWorkers=3 src/__tests__/tools/uniswap src/__tests__/tools/kyberswap src/__tests__/vex-agent/tools src/__tests__/tools/evm-chains src/__tests__/vex-agent/studio
pnpm exec vitest run --maxWorkers=3 src/__tests__/vex-agent/engine/prompts src/__tests__/vex-agent/agentscan/mapper.test.ts src/__tests__/vex-agent/sync/agent-activity-repair-mined-revert-reason.test.ts
VEX_SWAP_QUALITY_LIVE=1 pnpm exec vitest run --maxWorkers=3 src/__tests__/tools/evm-chains/swap-quality-live.test.ts
```

The default required-suite skips include the opt-in live test, which was then
run explicitly. Prompt snapshots and AGENTS/VEXGUIDE goldens match the committed
artifacts without update flags. The managed-body maximum fixture is 24,537 of
24,576 bytes, leaving 39 bytes. Static prompt ceilings were not raised.

A final repository-wide search found no consumer of
`SWAP_VENUE_UNISWAP_OCCASIONS`; the now-unused constant was deleted. Its removal
changes no rendered bytes. The final static follow-up passed 4 files and 217 tests (exit 0):

```sh
pnpm exec vitest run --maxWorkers=3 src/__tests__/vex-agent/tools/registry-venue-tool-surface.test.ts src/__tests__/vex-agent/engine/prompts/promptsnaps.test.ts src/__tests__/vex-agent/studio/managed-block.test.ts src/__tests__/vex-agent/studio/render-goldens.test.ts
```

The repeat live pass is preserved in `latency-resume.json`:

| Venue / chain | Quote ms | Execute to disabled signer ms |
| --- | --- | --- |
| KyberSwap / Base | 7739 | 6162 |
| KyberSwap / Robinhood | 7671 | 5543 |
| Uniswap / Base | 6630 | 6551 |
| Uniswap / Robinhood | 12058 | 5576 |

The intentionally disabled signer returns a refusal, so these live tool
results are unsuccessful by design. This is successful verification of the
pre-sign path, not a successful trade. The in-memory ledger remains a named
limit; this pass did not certify a production database or spend funds.

## Final changed-file inventory

92 files, including generated artifacts and measurement fixtures:

- `src/__tests__/fixtures/swap-quality/README.md`
- `src/__tests__/fixtures/swap-quality/dex-base.json`
- `src/__tests__/fixtures/swap-quality/dex-robinhood.json`
- `src/__tests__/fixtures/swap-quality/fee-drift.json`
- `src/__tests__/fixtures/swap-quality/latency-after.json`
- `src/__tests__/fixtures/swap-quality/latency-baseline.json`
- `src/__tests__/fixtures/swap-quality/latency-resume.json`
- `src/__tests__/fixtures/swap-quality/output-diagnostics.json`
- `src/__tests__/tools/evm-chains/pre-sign-revert-refusal.test.ts`
- `src/__tests__/tools/evm-chains/refused-swap-output.test.ts`
- `src/__tests__/tools/evm-chains/slippage-remediation-contract.test.ts`
- `src/__tests__/tools/evm-chains/swap-output-shortfall.test.ts`
- `src/__tests__/tools/evm-chains/swap-quality-live.test.ts`
- `src/__tests__/tools/uniswap/final-request-gate.test.ts`
- `src/__tests__/tools/uniswap/refresh-route.test.ts`
- `src/__tests__/vex-agent/engine/prompts/prompt-stack-protocol-doctrine-and-reveal-safety.test.ts`
- `src/__tests__/vex-agent/engine/prompts/protocol-declarations.test.ts`
- `src/__tests__/vex-agent/engine/prompts/protocols.test.ts`
- `src/__tests__/vex-agent/studio/managed-block.test.ts`
- `src/__tests__/vex-agent/tools/_uniswap-approved-snapshot.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/evm-client.test-fixtures.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/negative-price-impact-note.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/pre-sign-revert-refusal.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/pre-sign-total-debit.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/price-floor-gate.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/quote-balance-eligibility.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/quote-bound-execute.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/quote-eligibility.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/quote-safety.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/registry-validation.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/swap-fee.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/venue-unavailable-fallback.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/vex-fee-record.test.ts`
- `src/__tests__/vex-agent/tools/protocols/quote-authority/spendability.test.ts`
- `src/__tests__/vex-agent/tools/swap-reference-estimates.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-quote-bound-execute.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-quote-eligibility.test.ts`
- `src/tools/evm-chains/pre-sign-revert-refusal.ts`
- `src/tools/evm-chains/swap-execution-timing.ts`
- `src/tools/evm-chains/swap-fee-ceiling.ts`
- `src/tools/evm-chains/swap-output-shortfall.ts`
- `src/tools/evm-chains/swap-price-reference-read.ts`
- `src/tools/evm-chains/swap-price-reference.ts`
- `src/tools/kyberswap/evm/observe-refused-output.ts`
- `src/tools/uniswap/execute.ts`
- `src/tools/uniswap/fee-cap-gate.ts`
- `src/tools/uniswap/observe-refused-output.ts`
- `src/tools/uniswap/refresh-route.ts`
- `src/utils/error-summary/remediation.ts`
- `src/vex-agent/agentscan/mapper.ts`
- `src/vex-agent/agentscan/swap-reference-estimates.ts`
- `src/vex-agent/engine/prompts/__promptsnaps__/agent-full.jupiter.md`
- `src/vex-agent/engine/prompts/__promptsnaps__/agent-full.nojupiter.md`
- `src/vex-agent/engine/prompts/__promptsnaps__/agent-restricted.jupiter.md`
- `src/vex-agent/engine/prompts/__promptsnaps__/agent-restricted.nojupiter.md`
- `src/vex-agent/engine/prompts/__promptsnaps__/mission-run-full.jupiter.md`
- `src/vex-agent/engine/prompts/__promptsnaps__/mission-run-full.nojupiter.md`
- `src/vex-agent/engine/prompts/__promptsnaps__/mission-run-restricted.jupiter.md`
- `src/vex-agent/engine/prompts/__promptsnaps__/mission-run-restricted.nojupiter.md`
- `src/vex-agent/engine/prompts/__promptsnaps__/mission-setup-full.jupiter.md`
- `src/vex-agent/engine/prompts/__promptsnaps__/mission-setup-full.nojupiter.md`
- `src/vex-agent/engine/prompts/__promptsnaps__/mission-setup-restricted.jupiter.md`
- `src/vex-agent/engine/prompts/__promptsnaps__/mission-setup-restricted.nojupiter.md`
- `src/vex-agent/scripts/measure-swap-fee-drift.ts`
- `src/vex-agent/studio/installer/render/__goldens__/AGENTS.fresh.md`
- `src/vex-agent/studio/installer/render/__goldens__/AGENTS.merged.md`
- `src/vex-agent/studio/installer/render/__goldens__/VEXGUIDE.fresh.md`
- `src/vex-agent/studio/installer/render/__goldens__/VEXGUIDE.merged.md`
- `src/vex-agent/tools/protocols/kyberswap/handlers/swap/execute-broadcast.ts`
- `src/vex-agent/tools/protocols/kyberswap/handlers/swap/execute-failure.ts`
- `src/vex-agent/tools/protocols/kyberswap/handlers/swap/execute-handler.ts`
- `src/vex-agent/tools/protocols/kyberswap/handlers/swap/execute-plan.ts`
- `src/vex-agent/tools/protocols/kyberswap/handlers/swap/quote-handler.ts`
- `src/vex-agent/tools/protocols/kyberswap/handlers/swap/quote-spendability.ts`
- `src/vex-agent/tools/protocols/navigation/entries-market/kyberswap.ts`
- `src/vex-agent/tools/protocols/navigation/entries-market/uniswap.ts`
- `src/vex-agent/tools/protocols/quote-authority/debit-plan.ts`
- `src/vex-agent/tools/protocols/quote-authority/fee-ceiling-disclosure.ts`
- `src/vex-agent/tools/protocols/quote-authority/restore.ts`
- `src/vex-agent/tools/protocols/quote-authority/snapshot.ts`
- `src/vex-agent/tools/protocols/quote-authority/spendability.ts`
- `src/vex-agent/tools/protocols/quote-authority/uniswap-route-hint.ts`
- `src/vex-agent/tools/protocols/quote-authority/uniswap.ts`
- `src/vex-agent/tools/protocols/uniswap/handlers/swap/execute-broadcast.ts`
- `src/vex-agent/tools/protocols/uniswap/handlers/swap/execute-failure.ts`
- `src/vex-agent/tools/protocols/uniswap/handlers/swap/execute-handler.ts`
- `src/vex-agent/tools/protocols/uniswap/handlers/swap/execute-plan.ts`
- `src/vex-agent/tools/protocols/uniswap/handlers/swap/execution-binding.ts`
- `src/vex-agent/tools/protocols/uniswap/handlers/swap/quote-handler.ts`
- `src/vex-agent/tools/protocols/uniswap/handlers/swap/route-quote.ts`
- `src/vex-agent/tools/registry/swap-venue-guidance.ts`
- `src/vex-agent/tools/tool-surface-spec/balance-reads/swap-quality-2026-09-09.md`

## Final review fixes

Scope: the three findings from review of `30c4348b5`, without v4 wording,
fee-policy, slippage-cap, dependency, signing or wrap-permission changes.
This section supersedes the initial representative-pool selection and claimed
signal-only diagnostic timeout above. Earlier latency captures remain historical.

### 1. Full price populations and the read budget

`swap-price-reference-read.ts` now calls `readTokenPools` (`/token-pairs/v1`)
for each pricing asset before using the existing outlier selector. Membership
in an output token's pair list cannot establish completeness for the input
asset. Reuse between input and output is allowed only when the resolved
pricing addresses are identical. The helper never uses representative rows.

Uniswap shares the exact full-output-population promise between its liquidity
check and independent-price read, so a slow safety check cannot cause an extra
HTTP request after cache expiration. The liquidity threshold and selection
predicate are unchanged; it can see the full population instead of a single
representative when pricing needs that population. Existing consumers that
only ask for liquidity retain their existing reader.

Worst case per quote: **two DexScreener token HTTP reads**, one full population
per distinct pricing address, with the existing 30-second cache and request
deduplication. Cache hits cost zero HTTP reads. A direct V2 quote that already
has pool-reserve impact needs at most its existing one liquidity read. Compared
with the former one-population shortcut this adds at most one price request;
Uniswap no longer adds a third, separate liquidity request. RPC route, balance,
fee, and safety-provider calls are unchanged by this budget statement.

Regression evidence: the old reader failed three cases, including a stale
representative output price of 20 against multiple consistent prices of 1.
The real selector, exact valuation, eligibility owner and AgentScan mapper now
produce 10 USD input / 5.3 USD output and refuse 47% impact instead of calling
106 USD output executable. Other cases prohibit inferring input coverage from
an output pool and permit reuse for identical pricing identities. The one-dollar
absolute discrepancy flag and shared 15% cap are untouched.

### 2. Complete diagnostic deadline and cancellation ownership

Both RPC facades forward per-request options. Installed viem 2.54.3's fallback
also drops those options, so read requests with options bind them into each
endpoint transport for that request. This retains viem's endpoint ordering,
method scopes and existing retry policy instead of implementing a second
failover loop. An aborted signal stops the fallback and does not emit an
endpoint-failure transition. A pinned transport still never advances.

`swap-output-deadline.ts` owns a three-second timer and AbortController. It
races the complete call, including body reading, against a rejecting deadline;
timeout aborts the underlying read, and both venue diagnostic helpers map it
to unavailable. The timer is cleared on success or failure, and Promise.race
observes late rejections. The original transaction is unchanged and no signer
is accepted by this helper. A non-cooperating client may finish later, but
cannot delay the refusal or publish a late diagnostic amount.

Regression evidence: six cases failed against the old implementation. Real
public clients and RPC forwarding use a fake HTTP endpoint that never answers
or returns headers then stalls its body. At 2999 ms the diagnostic remains
pending; at 3000 ms it is unavailable, and amount/shortfall remain null. The
abort reaches the endpoint and does not advance to a second endpoint. Ordinary
503 failover with a live signal and already-aborted callers are also tested.
The live verification harness now combines its own timeout with the incoming
signal instead of replacing the incoming cancellation.

Reference reading, patterns only:

- `agents-colab/metamask-core/packages/network-controller/src/rpc-service/rpc-service.ts`,
  especially `isConnectionError` and `retryFilterPolicy`, plus its
  `rpc-service.test.ts` service-failure and non-retriable-error cases. Adopted:
  classify actual connection/server failures before changing endpoint health.
  The checkout has no dedicated AbortSignal case in these two files; an
  AbortError is not a recognized connection error. Vex therefore checks the
  caller signal explicitly, rather than assuming every fetch error is an
  endpoint failure. Rejected: copying its circuit breaker or retry policy,
  because Vex already owns method-specific failover and forbids signing retries.
- `agents-colab/vscode/src/vs/base/common/async.ts` (`raceCancellation`,
  `raceCancellationError`, `raceTimeout`) and
  `src/vs/base/test/common/async.test.ts` cancellation and both timeout-race
  outcomes. Adopted: independent caller deadline and cleanup whichever outcome
  wins. Rejected: returning an ambiguous undefined value inside the primitive;
  the deadline rejects, and the existing diagnostic boundary returns null.
  Also abort the underlying operation, rather than only abandon the wait.

### 3. Native pricing coverage without wrap authority

KyberSwap passes `getKyberWrappedNativeAddress(slug)` as an optional, explicitly
pricing-only identity to the shared reader. This registry already covers every
aggregator chain. No entries or permissions in `evm-chains/wrapped-native.ts`
were changed. Uniswap retains its existing verified deployment identities.

The quote-handler table test enumerates all 18 aggregator chains and asserts
that the second full-pool read names the venue's wrapped-native address.
Restoring the old lookup caused exactly ten failures and eight passes. Empty
populations return no independent reference and never crash the quote.

Live probe, 2026-09-10 10:03:38-10:03:45 UTC: one sequential full-pool request
per chain, spaced by 300 ms. No wallet, key or transaction was accessed. Evidence:
`src/__tests__/fixtures/swap-quality/native-reference-coverage.json`. Reproduce:

```sh
pnpm exec tsx src/vex-agent/scripts/measure-swap-native-reference.ts
```

| Chain key | Returned rows matching chain | Usable native price |
| --- | --- | --- |
| ethereum | 30 | yes |
| bsc | 30 | yes |
| arbitrum | 30 | yes |
| polygon | 30 | yes |
| optimism | 30 | yes |
| avalanche | 30 | yes |
| base | 30 | yes |
| linea | 30 | yes |
| mantle | 30 | yes |
| sonic | 30 | yes |
| berachain | 30 | yes |
| ronin | 0 | no |
| unichain | 30 | yes |
| hyperevm | 30 | yes |
| plasma | 30 | yes |
| monad | 30 | yes |
| megaeth | 20 | yes |
| robinhood | 30 | yes |

This is point-in-time indexing evidence, not a freshness guarantee. Ronin
answered with an empty array, so it correctly has no independent reference.

### Scope and file-size decisions

No file edited in this fix round was already 750 lines long. New deadline and
request-option mechanics are named sibling modules; existing facades stay
stable. Test changes outside the new regressions add the full-pool method to
existing provider fakes so quote tests remain isolated from live HTTP.

Before each Vitest or TypeScript process, `pgrep -f "vitest|tsc --noEmit"
--ignore-ancestors` must report no matches. The ancestor exclusion removes the
execution wrapper whose command itself contains that pattern, not another
verifier. All test runs use `--maxWorkers=3`; no two verifiers run together.

### Final review fix gates

All commands below completed with exit 0, after the process-presence checks
above. These results are for the uncommitted review fixes on `30c4348b5`.

| Gate | Result |
| --- | --- |
| Affected suites below | 10 files, 129 tests passed |
| Requested broad Vitest gate below | 618 files passed, 4 skipped; 10698 tests passed, 5 skipped |
| `pnpm exec tsc --noEmit -p tsconfig.json` | No diagnostics |
| `pnpm run check:em-dash` | No added em dashes |
| `pnpm run test:unsafe-escapes` | No unsafe escapes, focused tests, deletions or baseline edits |
| `git diff --check` | Clean |

```sh
pnpm exec vitest run --maxWorkers=3 src/__tests__/tools/evm-chains/rpc-diagnostic-deadline.test.ts src/__tests__/tools/evm-chains/rpc-transport-behaviour.test.ts src/__tests__/tools/evm-chains/swap-price-reference-read.test.ts src/__tests__/tools/evm-chains/refused-swap-output.test.ts src/__tests__/tools/evm-chains/swap-output-shortfall.test.ts src/__tests__/vex-agent/tools/kyberswap-handlers/quote-eligibility.test.ts src/__tests__/vex-agent/tools/uniswap-quote-eligibility.test.ts src/__tests__/vex-agent/tools/swap-reference-estimates.test.ts src/__tests__/vex-agent/agentscan/mapper.test.ts src/__tests__/dexscreener/s11a-consumer-characterization.test.ts
pnpm exec vitest run --maxWorkers=3 src/__tests__/tools src/__tests__/vex-agent/tools src/__tests__/vex-agent/agentscan src/__tests__/vex-agent/engine/prompts
pnpm exec tsc --noEmit -p tsconfig.json
pnpm run check:em-dash
pnpm run test:unsafe-escapes
git diff --check
```

The expected red-on-old runs were: three price-population failures; six
cancellation/deadline failures; ten native-chain failures (eight covered
chains still passed). The broad gate's opt-in tests remain skipped; the
explicit native-reference probe above covers the live HTTP change in this
round. No signatures, broadcasts or database mutations were performed.

Remaining limits: the provider's full-pool endpoint still returns its own
bounded window (30 rows on most measured chains), and the 30-second local
cache cannot prove upstream freshness. Ronin supplied no independent native
price. Existing no-reference behavior remains. An adapter that ignores abort
can retain its own pending work, but the diagnostic race returns unavailable
at its deadline and ignores late completion. The only related scope expansion
was sharing Uniswap liquidity's full-pool request to preserve the two-request
budget; thresholds and signing checks were not changed.

Changed files in this review-fix round:

- `src/__tests__/fixtures/swap-quality/native-reference-coverage.json`
- `src/__tests__/tools/evm-chains/rpc-diagnostic-deadline.test.ts`
- `src/__tests__/tools/evm-chains/swap-price-reference-read.test.ts`
- `src/__tests__/tools/evm-chains/swap-quality-live.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/negative-price-impact-note.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/pre-sign-total-debit.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/price-floor-gate.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/quote-balance-eligibility.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/quote-bound-execute.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/quote-eligibility.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/quote-safety.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/registry-validation.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/swap-fee.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/venue-unavailable-fallback.test.ts`
- `src/__tests__/vex-agent/tools/kyberswap-handlers/vex-fee-record.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-balance-preflight-handler.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-debit-plan-binding.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-execute-final-request-gate.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-execute-staged-broadcast.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-fee-ordering.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-post-buy-delivery.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-pre-sign-revert-refusal.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-pre-sign-total-debit.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-quote-balance-eligibility.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-quote-bound-execute.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-quote-eligibility.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-tracked-token-pin.test.ts`
- `src/__tests__/vex-agent/tools/uniswap-vex-fee-presign-binding.test.ts`
- `src/tools/evm-chains/rpc-request-options.ts`
- `src/tools/evm-chains/rpc-transport.ts`
- `src/tools/evm-chains/swap-output-deadline.ts`
- `src/tools/evm-chains/swap-price-reference-read.ts`
- `src/tools/kyberswap/evm/observe-refused-output.ts`
- `src/tools/uniswap/observe-refused-output.ts`
- `src/vex-agent/scripts/measure-swap-native-reference.ts`
- `src/vex-agent/tools/protocols/kyberswap/handlers/swap/quote-handler.ts`
- `src/vex-agent/tools/protocols/uniswap/handlers/swap/quote-handler.ts`
- `src/vex-agent/tools/protocols/uniswap/handlers/swap/quote-safety.ts`
- `src/vex-agent/tools/tool-surface-spec/balance-reads/swap-quality-2026-09-09.md`

## Merged with v4

Reconciliation of `3d9c6caa1` with the coordinator-started merge of
`95dd1a4ce` (`origin/feat/uniswap-v4-direct`). No commit is made here.

### Conflicts and resolutions

- `rpc-transport.ts`: retained the module-owned `RpcRequestPacer`, Base quota
  groups, cancellable admission, single-flight endpoint discovery and default
  transport, and zero fallback retries. Signal-bearing requests instantiate
  only their endpoint option bindings. Cancellation is propagated into the
  shared pacer and checked before exhaustion classification, so AbortError
  retains its identity and consumes no queued slot. No signal-bound instance
  is cached or shared with another caller.
- `fee-cap-gate.ts` and `execute.ts`: retained the measured 1500-bps quote-time
  headroom and live repricing within the sealed ceiling. Exported the existing
  prepared-request and live-cap assertions needed by the post-success fee leg.
  Kept the typed exceeded, unreadable and pricing-mode refusals. No headroom is
  added to an old snapshot at execution; no approval or floor is broadened.
- Snapshot authority and execution: both canonical v4 binding fields and
  independent price/route-hint fields remain in the digest. V4 uses its own
  revalidation and never receives a V2/V3 route hint. Old snapshots without a
  hint still discover V2/V3 routes, without silently enabling v4. The approved
  floor is compared before claim. The selected price reference remains sealed
  through execution and reporting.
- Execution result conflicts preserve timing, approved fee disclosure, v4
  native settlement and reduced post-success fees, typed RPC/revert facts,
  and the separate post-refusal output diagnostic. The diagnostic cannot sign
  or change the approved request; timeout remains three seconds.
- `mapper.ts` retains independent-reference estimates and v4 route disclosure.
  Slippage remediation remains re-quote at the same slippage first, increasing
  only within the user's stated limit or after fresh authorization.
- Guidance, protocol declarations, module docs and generated artifacts now
  consistently describe V2/V3/v4. KyberSwap stays the usual default; Robinhood
  quotes both venues when both price the pair and prefers direct Uniswap when
  it has a route, explaining the quiet-pool index and lagging USD reference.
  The same swap section was shortened by restating complete instructions;
  no content is cut at runtime and no byte or slippage ceiling was increased.
  Prompt snapshots and AGENTS/VEXGUIDE goldens were regenerated with
  `UPDATE_PROMPTSNAPS=true` and `UPDATE_TOOLSNAPS=true` respectively.
- The KyberSwap wrapped-native registry header now acknowledges pricing use;
  its addresses and execution permissions are unchanged.

### Typed ledger refusal

Added the closed `fee_bound_refused` code because the existing vocabulary
could not distinguish a local fee-bound refusal from a router revert or an
unknown failure. Migration 159 expands the SQL constraint and restricts this
code to failed, hashless rows. The TypeScript vocabulary and lockstep test
change together; the packaged migration mirror is regenerated through
`node vex-app/scripts/copy-migrations.mjs`. Existing rows are not rewritten.
Deploy the expanded vocabulary before its writer; retain that vocabulary
while recorded rows use it when rolling back application code.

The affected unsigned leg is finalized with the sanitized typed reason before
remaining unsigned plans are aborted. Cleanup cannot overwrite its code.
The result also names the specific fee refusal kind and whether a fresh read
can help. Nothing signs or broadcasts on this path. A confirmed earlier leg
is unaffected, and this change does not retry a fee or a swap.

### Reference and size decisions

Re-read the wallet-reference audit and the existing MetaMask rpc-service
failure/retry policy and its tests, plus VS Code async cancellation/timeout
races and their tests. Adopted explicit error classification and cleanup on
both race outcomes. Rejected copying their retry/circuit-breaker policies or
sharing caller cancellation with unrelated work. The existing Vex owners
already enforce signing authority and endpoint-specific retry rules.

No edited production module crosses 750 lines. The managed-block test was
already above 750 lines; its changes reconcile existing assertions in that
single generated-document contract suite, so no new lifecycle or policy owner
justifies extracting a facade. Generated snapshots/goldens remain renderer
outputs. This chronological audit remains one document.

### Verification

Live read-only pinned-transport smoke on 2026-09-10 at 16:31 UTC:
Robinhood 4663 returned block 59547818 in 1713 ms; Base 8453 returned block
51134270 in 908 ms. Calls were sequential, with chain identity probes and one
block read per chain. No wallet, signature or broadcast was accessed.

The new concurrent regression exercises real public clients and HTTP transport
forwarding: cancelling a queued request on both read and pinned transports
preserves AbortError, does not become exhaustion, leaves another signal live,
and dispatches surviving same-client and peer-client requests at the shared
250-ms intervals without reserving the cancelled slot. Added regressions also
cover typed fee ledger writes, cleanup ordering, real-Postgres persistence,
and v4 snapshot construction alongside independent prices.

Gate results:

- Initial requested broad group: 836 files passed, 2 failed, 7 skipped;
  13,520 tests passed, 10 failed, 23 skipped. Failures were four stale tool
  snapshots and six static prompt budgets, each 12 bytes above its unchanged
  ceiling. The Uniswap preview sentence was shortened without removing its
  contract, and the artifacts were regenerated.
- Corrected prompt/tool/golden contracts: 5 files, 447 tests passed.
- Initial full root suite (`pnpm test --maxWorkers=3`): 1,490 files passed,
  1 failed, 18 skipped; 22,214 tests passed, 1 failed, 75 skipped. The one
  failure was the MCP inventory's four description-byte counts. Regenerated
  with `UPDATE_TOOLSNAPS=true`; its suite passed all 3 tests. A final full
  root run is recorded below.
- Final full root suite (`pnpm test --maxWorkers=3`): exit 0; 1,491 files
  passed, 18 skipped; 22,215 tests passed, 75 skipped, in 548.21 seconds.
  This pass covers the corrected artifacts and the complete requested broad
  group. No implementation change followed the passing type or app gates.
- `pnpm run check:em-dash`, `pnpm run test:unsafe-escapes` and
  `git diff --check`: exit 0 on the completed reconciliation. No compiler,
  test baseline, dependency or static prompt ceiling was increased.
- `pnpm run test:studio-postgres --maxWorkers=3`: exit 0; 47 files passed,
  599 tests passed and 31 skipped. Migration 159 applied and the typed refusal
  survived real repository cleanup.
- `pnpm exec tsc --noEmit -p tsconfig.json`: exit 0, no diagnostics.
- From `vex-app`, `pnpm run lint`: exit 0. Strict projects and process
  boundaries passed; the type ratchet retained 312 known baseline errors
  with no increase. No baseline or compiler setting was changed.
- From `vex-app`, `VEX_REQUIRE_BRIDGE_CONFORMANCE=1 pnpm test --maxWorkers=3`:
  exit 0; 878 files passed, 10 skipped; 12,119 tests passed, 29 skipped.
  The Linux bridge conformance prerequisite was required, not silently skipped.
- Linux bridge prerequisite: `PATH=/home/kubas/.local/go/bin:$PATH
  GOCACHE=/tmp/swap-merge-go-cache GOMODCACHE=/tmp/swap-merge-go-mod
  GOFLAGS=-p=1 GOMAXPROCS=1 bash bridge/build.sh linux amd64`: exit 0 using
  the repository-pinned Go 1.27.0. This enables the app's CI conformance flag.

Staging was attempted for all 28 resolved conflict files. The session's
filesystem policy makes `/home/kubas/Vex/.git/worktrees/swap-quality` read-only,
so `git add` failed creating `index.lock`. No workaround or git-state change
was attempted. The coordinator must stage the resolved files and additions;
the worktree contents are preserved and contain no conflict markers.

### Gate commands for the merged tree

Before each verifier, `pgrep -f "vitest|tsc --noEmit" --ignore-ancestors`
reported no matches. This turn's Vitest and TypeScript processes were awaited
sequentially. The app lint script also runs its compiler projects sequentially.
The process runner isolates PID visibility, so these checks do not establish
absence of processes outside the runner's namespace.

```sh
pnpm exec vitest run --maxWorkers=3 src/__tests__/tools src/__tests__/vex-agent/tools src/__tests__/vex-agent/engine/prompts src/__tests__/vex-agent/studio src/__tests__/vex-agent/agentscan src/__tests__/vex-agent/sync src/__tests__/vex-agent/db
pnpm test --maxWorkers=3
pnpm run test:studio-postgres --maxWorkers=3
pnpm exec tsc --noEmit -p tsconfig.json
pnpm run check:em-dash
pnpm run test:unsafe-escapes
git diff --check
# From vex-app:
pnpm run lint
VEX_REQUIRE_BRIDGE_CONFORMANCE=1 pnpm test --maxWorkers=3
```

The required fee-cap search matched five test files; all were run in the
initial affected gate and again by the root suite. The final root suite also
subsumes every directory in the requested broad group.

### Reconciliation file inventory

The following 55 files differ from the coordinator-created automatic merge
result, including the two new source files. Incoming v4 files that required
no reconciliation are not counted here.

```text
src/__tests__/integration/agent-scan/agent-activity-staged-broadcast.int.test.ts
src/__tests__/tools/evm-chains/rpc-shared-pacing.test.ts
src/__tests__/vex-agent/db/repos/agent-activity-failure-code-lockstep.test.ts
src/__tests__/vex-agent/engine/prompts/protocol-declarations.test.ts
src/__tests__/vex-agent/studio/managed-block.test.ts
src/__tests__/vex-agent/studio/vex-guide.test.ts
src/__tests__/vex-agent/tools/uniswap-handlers/v4-binding.test.ts
src/__tests__/vex-agent/tools/uniswap-pre-sign-revert-refusal.test.ts
src/__tests__/vex-agent/tools/uniswap-quote-bound-execute.test.ts
src/tools/evm-chains/rpc-transport.ts
src/tools/kyberswap/KyberSwap.md
src/tools/kyberswap/wrapped-native.ts
src/tools/uniswap/Uniswap.md
src/tools/uniswap/execute.ts
src/tools/uniswap/fee-cap-gate.ts
src/utils/error-summary/remediation.ts
src/vex-agent/agentscan/mapper.ts
src/vex-agent/db/migrations/159_agent_activity_fee_bound_refusal.sql
src/vex-agent/db/repos/agent-activity/types/status-and-failure.ts
src/vex-agent/db/repos/agent-activity/validation.ts
src/vex-agent/engine/prompts/__promptsnaps__/agent-full.jupiter.md
src/vex-agent/engine/prompts/__promptsnaps__/agent-full.nojupiter.md
src/vex-agent/engine/prompts/__promptsnaps__/agent-restricted.jupiter.md
src/vex-agent/engine/prompts/__promptsnaps__/agent-restricted.nojupiter.md
src/vex-agent/engine/prompts/__promptsnaps__/mission-run-full.jupiter.md
src/vex-agent/engine/prompts/__promptsnaps__/mission-run-full.nojupiter.md
src/vex-agent/engine/prompts/__promptsnaps__/mission-run-restricted.jupiter.md
src/vex-agent/engine/prompts/__promptsnaps__/mission-run-restricted.nojupiter.md
src/vex-agent/engine/prompts/__promptsnaps__/mission-setup-full.jupiter.md
src/vex-agent/engine/prompts/__promptsnaps__/mission-setup-full.nojupiter.md
src/vex-agent/engine/prompts/__promptsnaps__/mission-setup-restricted.jupiter.md
src/vex-agent/engine/prompts/__promptsnaps__/mission-setup-restricted.nojupiter.md
src/vex-agent/mcp/__toolsnaps__/studio-exported-surface.json
src/vex-agent/studio/installer/render/__goldens__/AGENTS.fresh.md
src/vex-agent/studio/installer/render/__goldens__/AGENTS.merged.md
src/vex-agent/studio/installer/render/__goldens__/VEXGUIDE.fresh.md
src/vex-agent/studio/installer/render/__goldens__/VEXGUIDE.merged.md
src/vex-agent/studio/instructions/project-brief.ts
src/vex-agent/tools/__toolsnaps__/kyberswap__swap_execute.json
src/vex-agent/tools/__toolsnaps__/kyberswap__swap_quote.json
src/vex-agent/tools/__toolsnaps__/uniswap__swap_execute.json
src/vex-agent/tools/__toolsnaps__/uniswap__swap_quote.json
src/vex-agent/tools/protocols/navigation/entries-market/uniswap.ts
src/vex-agent/tools/protocols/quote-authority/uniswap.ts
src/vex-agent/tools/protocols/uniswap/handlers/swap/activity-recording.ts
src/vex-agent/tools/protocols/uniswap/handlers/swap/execute-broadcast.ts
src/vex-agent/tools/protocols/uniswap/handlers/swap/execute-failure.ts
src/vex-agent/tools/protocols/uniswap/handlers/swap/execute-handler.ts
src/vex-agent/tools/protocols/uniswap/handlers/swap/execution-binding.ts
src/vex-agent/tools/protocols/uniswap/handlers/swap/fee-refusal.ts
src/vex-agent/tools/protocols/uniswap/handlers/swap/quote-handler.ts
src/vex-agent/tools/protocols/uniswap/handlers/swap/route-quote.ts
src/vex-agent/tools/registry/swap-venue-guidance.ts
src/vex-agent/tools/tool-surface-spec/balance-reads/swap-quality-2026-09-09.md
src/vex-agent/tools/tool-surface-spec/studio-mcp/exported-tools.md
```
