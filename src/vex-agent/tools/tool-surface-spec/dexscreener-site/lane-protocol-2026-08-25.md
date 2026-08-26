# DexScreener website-API lane - closing protocol (2026-08-25)

Status at write time: builder S10 (final fix round) in flight; owner decree:
S10 is the LAST fix round for this tool surface - findings after S10 become
documented known issues, not new rounds, unless a blocking money-path defect
surfaces (which goes to the owner, never silently fixed or ignored).

## What was built

18 agent tools on DexScreener's own website channels, replacing the 12
public-API tools (retired whole, alias-free, D-DS2):

- Screening: pairs.trending, pairs.top, gainers, losers, pairs.new,
  launchpad.pairs, tokens.screen
- Resolve/context: search, tokenPairs, pair.get, pairs.batch (v8), spotlight,
  trending (narratives), chains
- Deep dive: pair.details (safety card: GoPlus + QuickIntel + holders + LP +
  supply + listings), candles (1s..1mo, HTTP+WS), trades (cursor walks,
  maker filter, aggregates), top.traders

Infrastructure: protobuf codecs generated from checked-in descriptors
(evidence/dexscreener-descriptors.pb - the only source of wire names),
dsavro decoder, lexeme-preserving JSON parser (no float on money), issuer
sanitizer (4 invisible/control classes), two transports (Electron site
bridge with Chromium fingerprint for gated hosts: vex-app/src/main/
dexscreener-bridge/; degraded headless transport: api.dexscreener.com +
dd. chain catalog, and nothing else).

Prompt integration: D-DS9 always-injection (all 18 schemas in every
request's tools array, ~66k tokens, cache-amortized, owner-accepted;
reversal = one set edit) + the source-hierarchy card (18 publicNames named
in the Protocols declaration, "Always loaded" exception to the ToolSearch
doctrine, Market Research Source Hierarchy in the Research layer:
DexScreener + WebResearch + Twitter primary, other market namespaces
fallback; budget ceilings raised +1,675 B/mode with a reviewed diff).

## How it was verified (rule 10 lineage)

1. Builder-stage live smokes per tool (S1-S4), Codex 4-lens final review
   (each lens tested live), fix rounds S6/S7b.
2. Wave 1: 15 agents, 1 agent = 1 endpoint, every parameter probed live.
   3 blocking defects (GoPlus tax fractions 100x, inverted high/low
   transposition, RANK_BY_KEY_MARKETCAP wire name) + 20 important -> S8.
3. Wave 2: 14 agents re-verified EVERY S8 fix red-to-green on live bytes.
   Residue -> S9 (22 items, all fixed or declared; S9-19 settled by live
   measurement of the WS after-triple exclusivity).
4. Coordinator personal test: 5 intelligence missions through
   executeProtocolTool over live bytes (fresh-Solana hunt with rug gate,
   Robinhood chain, VEX trend read, market pulse, batch watchlist).
5. Wave 3: 10 Opus trading personas, each with all 18 tools, production
   workflows on live API. Verdicts 9 NOT READY / 1 READY; 61-item ledger
   (S10-LEDGER.md) with locations and fix directions. Convergent diagnosis:
   envelope layer exemplary (floor accounting, missing-vs-zero, truncation
   reporting, validation gates - nobody broke them); defects cluster in
   summaries not derived from envelope facts, derived aggregates not
   reconciled with raw columns, batch row/identity invariant, unvalidated
   vocabularies, and a few false manifest claims.
6. S10 builder: fixes the ledger with rule-10 live re-verification and
   red-on-revert regressions. FINAL round by owner decree.

Evidence archives (scratchpad, session-local): endpoint-wave/, endpoint-
wave2/, wave3/P1..P10/raw/, personal-test/raw/, s7/ s8/ s9/ s10/ probe
archives with SHA256 provenance.

## Decisions in force

D-DS1..D-DS9 (see tool-plan-v1.md section 10 + revision log), plus:
- CoinGecko lane cancelled (D-DS8).
- S10 = final fix round (owner, 2026-08-25).
- S11 data-source swap ordered: six consumers of the surviving OLD
  public-API client (vex-app $VEX widget, price-watch-poller/loop_defer,
  own-token banner, uniswap quote-safety, evm balances, + gecko removal)
  migrate to the new surface, then the old client is deleted whole.
  loop_defer phase 2 (WS push) shares the bridge subscription extension
  with the board lane - built once.
- Board lane approved in design (declarative spec, atomic composition,
  prose separate, internal-only, hydration from the surface); recon
  REPORT.md + PATTERNS.md done; Codex plan review dispatched
  (harness-vex-board); implementation AFTER this lane closes.

## Known issues and residual risk (documented, not scheduled)

- P3 evidence gaps: no live non-zero GoPlus tax observed this session (path
  verified by code + recorded Saitama discrimination); populated hpi block
  verified by code reading only. S10 attempts opportunistic closure.
- Two flaky-under-load test timeouts (lexical-retrieval, pools
  launch-preview) - pass in isolation, tracked.
- Depth gaps named, not built: no batched deep-dive reads, no server-side
  aggregate flow, launchpad vocabulary not enumerable (S10-27), priceChange
  server filter pending the S10-56 wire probe result.
- Provider-side realities the surface reports honestly rather than hides:
  unstable totals under drift, provider-opaque rankings, tokens-channel
  hybrid semantics, narrative classification lag, 30-day trader windows.

## Remaining steps to lane close

1. S10 report -> coordinator inspection (ladder rerun + spot-checks).
2. Codex FINAL turn on harness-dexscreener-tools (live re-test mandate) -
   acceptance review; non-blocking findings become known issues (freeze).
3. Integration: mount createDexScreenerBridgeTransport in vex-app agent
   startup (+ dispose in teardown), merge/PR per owner instruction, full
   gates on the merged tree, pnpm tool-reembed + first dense baseline
   (floors recall@5>=0.95, blind>=0.94, mrr@5>=0.88), in-app smoke.
4. Commit + push (this lane's paths only; no AI attribution; no em dashes).
5. S11 swap + board lane follow after, as their own work.

## Codex final acceptance (harness-dexscreener-tools, 2026-08-25 evening)

Verdict: BLOCKED on ONE defect (S10-31b, below - owner decision under the
freeze decree). Every other requested high-consequence check PASSED through
current handlers or fixture-backed full-chain replays: batch
unrequested-row withholding + reconciled summary + unknown_chain;
pool-holder exclusion; LP share withholding; trades raw/pageAggregate
summaries; inverted-candle summaries naming quote token and basis; metaIds
refusal with the correct id; marketCap sort failing closed; WS single-flight
keyed on URL+command digest. Ladder in the review sandbox: tsc, ratchet,
S10 acceptance 297/297, dexscreener-site 477 green; 11 unrelated failures
in other lanes (bridge-alias, uniswap live-network, morpho timeout);
network egress was denied in the sandbox so no fresh live capture - the
decisive evidence is the same-day live JUP capture driven through the
CURRENT production detector.

S10-31b (BLOCKING, awaiting owner decision): priceDivergence computes AFTER
limit-slicing (handlers/resolve.ts:2241 slices, :2256 detects; same order
screening.ts:664; project.ts:895 uses the sliced median). Measured with the
same-day JUP capture: full 30 rows -> 9 junk pools correctly flagged at
~5,000x; limit:5 -> all-junk slice, mutual spread 1.04x, NO flag, and the
$172.56M fabricated pool is still named deepestPair; limit:10 -> junk is
the sliced majority, the detector flags the two HONEST pools instead.
Clearance: compute divergence on the full pre-limit provider population,
annotate emitted rows, mark the inconsistent token group (at minimum a
deepestPair drawn from it) unusable rather than declaring the minority
wrong; pin limit:5 and limit:10 regressions on the captured JUP ordering.

## Known issues added by final review (documented per the freeze)

- pairs.top top-level description still recommends marketCap sorting though
  the schema rejects it (manifests/screening.ts:205); price-artifact
  warning absent from pairs.top and token_pairs_list main descriptions.
- Batch chain and metaIds validation fail OPEN when their catalogs cannot
  be read (recreates old misclassification during that failure mode).
- Durable regressions absent for: batch-summary collapse prose, narrowed
  pair-details coverage, trades summary counts, metaIds refusal wording,
  inverted-candle summary wording (behavior fixed; prose unpinned).
- pairs.new still claims launchpad origin in normal output while the field
  group is not pinned on that board.
- Review-sandbox ladder incomplete (eval/prompts + vex-app not rerun
  there); coordinator's own full ladder was green same day.

## Dense baseline attempt (2026-08-25, measured outcome)

Reembed clean: 18 new dexscreener embeddings, 9 old deleted, 122 untouched,
0 errors (embeddinggemma 300M, dim 768, live sidecar; eval DB
vex-eval-db:27433). Dense capture: relay and virtuals PASSED floors and
were recaptured (recall@5 1.0, blind 1.0); 11 targets measured BELOW the
planned floors (dexscreener 0.887/0.781/0.816 vs 0.95/0.88/0.94; canonical
0.936/0.832 vs an April-corpus baseline of 0.975/0.906) and the harness
correctly REFUSED to capture them. Established facts: (a) the canonical
stored baseline predates most of the current 140-tool catalog; (b) the 9
per-namespace dense targets have never had a green capture (dense needs
the eval DB that existed only in the batch3 session); (c) the floors were
set as plan aspirations, not measurements, at a much smaller catalog size.
NOT a lane blocker: dexscreener discovery is architecturally bypassed by
D-DS9 always-injection, and lexical (the fallback) baselines are green.

OPEN DECISION for the owner (next lane, proposed as D-DS10): exclude
always-injected namespaces from the ToolSearch discovery candidate pool -
their rows in discovery results are pure noise post-D-DS9 (the tools are
already in the tools array), they consume result slots for every other
namespace, and exclusion shrinks the dense candidate pool to 122
non-dexscreener embeddings, which is the honest population for the other
namespaces' floors. Alternative: recalibrate the dense floors to the
measured 140-tool reality and ratchet from the first green capture.

## S10-31b resolution (owner-authorized fix, 2026-08-25)

FIXED and red-verified BOTH ways on a fresh live wire capture
(search-jup-solana-pricedivergence fixture, sha256 5b7acdf2..., 30 JUP
pools: 21 honest at median 0.2150, 9 junk at 1053-1109; the 5 deepest are
all junk because the inflation hits liquidityUsd too): divergence now
assessed on the FULL pre-limit population in both handlers
(assessPriceDivergence(population) + inconsistentTokens verdict);
deepestPair from an inconsistent token group is WITHHELD with a named
reason and the summary derives from the same flag. Revert proofs printed
the exact defect (limit:5 no flag + junk deepestPair; limit:10 honest
pools flagged). Bonus finding: an existing screening fixture already
carried a genuine 4,636x divergence (wire key priceUSD vs priceUsd read)
- the screening-population test runs on those unmutated bytes.

NEW KNOWN ISSUE (money display, named for a future decision):
totalLiquidityUsd / totalVolumeUsd / liquiditySharePct on token_pairs_list
still SUM over inconsistent-token pools (JUP totals inflated ~5,000x on
9/30 rows); the envelope note marks every dollar figure on an inconsistent
token unusable as a ranking, but the totals are not withheld. Decision
needed: withhold vs per-cluster split vs annotation-only (current state).
Also: detectPriceDivergence survives as a second exported entry with the
same documented full-population precondition.

## LANE CLOSED with this commit

## D-DS10 WITHDRAWN; D-DS9 REVERTED (owner, 2026-08-26)

D-DS10 is WITHDRAWN. It was reasoned on top of D-DS9, and the revert removes
its premise.

Specifically, the dense-floor DISMISSAL recorded under D-DS10 is invalidated.
It was argued that a retrieval floor mattered less because the dexscreener
tools were in every tools array regardless of what discovery returned. They are
not any more: after D-DS9-R a dexscreener tool is callable ONLY once ToolSearch
has returned it, so retrieval quality is again the single thing standing
between the model and the market-research surface.

That is a reopened question, not a decided one. Recalibrating the dense floors
stays OUTSIDE this arc and remains the owner's decision. The release gate in
the meantime is unchanged and is the discovery-routing goldens (62 queries),
which are green after the revert.

STUDIO MCP EXCLUSION OF BoardCompose: DONE, on origin. Recorded here because
this protocol still listed it as outstanding. `src/vex-agent/mcp/export-scope.ts`
line 58 excludes it; no further work is owed.
