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
and wrapped-native resolution. A pair containing both assets can supply both
prices in one read. Token amounts remain integers through valuation. A
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
