# DexScreener tool surface v2 - handoff

## STATE UPDATE 2026-08-25 (goal run; supersedes everything below on conflict)

OWNER GOAL ACTIVE (Stop-hook): finish integration fully -> fix -> SECOND
1-agent-1-endpoint wave -> Codex -> commit+push to PR; DexScreener embedded in
the agent's main prompt (DONE via declaration card + D-DS9 always-injection).

Position in sequence:
- S1-S8 all landed in worktree /home/kubas/Vex/.claude/worktrees/agent-a00fdee79b4f5d6bc
  (18 tools; S8 = consolidated fix round from wave 1, all 3 blocking + 20
  important fixed; my independent rerun 6,761-6,763 tests green).
- D-DS9 IMPLEMENTED: ALWAYS_INJECTED_NAMESPACES=["dexscreener"] in
  registry/injected-protocol-tools.ts (~66k tokens/request, measured; recorded
  in plan 14.6 item 18; 47/47 injection tests green).
- WAVE 2 (second 1-agent-1-endpoint): 13/14 reports COMPLETE
  (EP1,2,3,4,5,6,8,9,10,12,13,14,15): EVERY S8 fix re-verified red-to-green
  live. Full findings ledger: scratchpad/endpoint-wave2/S9-LEDGER.md
  (S9-1..S9-20 important + advisories; includes coordinator rulings:
  429-transient class, dd.dexscreener.com into default transport allowlist,
  C0 sanitizer gap S9-16, afterBlock window doors S9-19).
- IN FLIGHT: only EP11 feed/ws (a95bea2a3a731124e), actively working
  (keepalive-skip verified, now D2 routing). Resume via SendMessage on stall.
- NEXT after wave 2 completes: (1) dispatch builder S9 with S9-LEDGER.md
  (same shape as S8 brief; rule 10 binding; worktree; regenerate
  snapshots/D9/lexical with scope proofs); (2) my inspection; (3) Codex FINAL
  turn 2 on thread harness-dexscreener-tools (--mode build, network config,
  live re-test mandate, prompt pattern = scratchpad/codex-final-review.md);
  (4) INTEGRATION (mine): mount bridge in vex-app/src/main/agent/index.ts
  (createDexScreenerBridgeTransport + dispose in teardown; file is touched by
  the OTHER window's Studio-P work in the MAIN tree - merge carefully), merge
  worktree -> feat/studio-p, full gates, pnpm tool-reembed + FIRST dense
  baseline (floors recall@5>=0.95 blind>=0.94 mrr>=0.88), in-app smoke
  (app://vex/dexscreener-bridge, screener channel, non-latestBlock frame,
  2-3 real tool calls); (5) COMMIT+PUSH to the PR (standing authorization +
  goal; commit ONLY this lane's paths - main tree carries other agents'
  uncommitted work); lane docs already updated (DexScreener.md rewritten in
  S8; plan v1.3 + 14.6; descriptions doc is the D-DS7 source with a 74-test
  drift gate).
- Codex thread: harness-dexscreener-tools (id 01a032f1-0f41-7981-af2b-29eb8a87f35b).
  Driver: ~/.claude/skills/codex/codex-run.sh continue --name
  harness-dexscreener-tools --mode build --config
  'sandbox_workspace_write.network_access=true' --prompt-file <f>.
- Key facts: api.dexscreener.com unreachable from this machine (all clients);
  io.dexscreener.com fine; dd.dexscreener.com has NO fingerprint gate.
  Rule file /home/kubas/Vex/.claude/rules/10-live-provider-verification.md is
  binding on all briefs (live endpoint = the specification).
- D-DS8: CoinGecko lane CANCELLED by owner (not deferred).


## STATE UPDATE 2026-08-24 afternoon (supersedes the table below where they conflict)

- Codex turns 2 AND 3 are DONE on thread `harness-dexscreener-tools`. Turn 2:
  live probe matrix with three subagent lenses, archive of 430 hashed files at
  `<scratchpad>/live-turn2/`, verdict BLOCKED with findings (run
  20260824T093333Z-2179201). Turn 3 (convergence turn, cap reached): BLOCKED
  with a deterministic clearance list, all 18 tool identities approved,
  consolidation recommendation withdrawn (run 20260824T100204Z-2248533). The
  coordinator applied every clearance item and closed gate 7 by decision at
  the cap.
- Plan is now v1.3 (revision log at top of tool-plan-v1.md). Inventory is 18
  tools: the 16 plus `pairs_batch_get` (v8) and `tokens_screen` (v2).
- New owner decisions recorded: D-DS4 full intent-shaped set + MCP exposes
  DexScreener only through the Vex search tool; D-DS5 no artificial caps;
  D-DS6 handoffs to TwitterAccount/WebResearch; D-DS7 coordinator-authored
  retrieval text. Sanitization ruled by coordinator at the cap (strip+report),
  owner veto open.
- `tool-descriptions-v1.md` carries retrieval text for all 18 tools; all pass
  the word/anchor gates by script.
- Second live measurement pass archived at `evidence/report-retest-2026-08-24.md`
  plus `<scratchpad>/claude-retest/`.
- Implementation STARTED: builder S1 (transport + codecs + Electron bridge
  files, purely additive, no mount) dispatched in an isolated worktree,
  2026-08-24 ~12:15. Inspect its diff before accepting; S1 explicitly does
  not touch vex-app/src/main/agent/index.ts (Studio-P collision avoidance).


Written 2026-08-24 before a context compaction, by Claude Code (coordinator).
Read this first, then `tool-plan-v1.md`. Everything below is state, not narrative.

Branch: `feat/studio-p`. Working tree carries unrelated Studio-P work by other
agents (projects table, migration 085, config paths). This lane has touched
NOTHING outside `src/vex-agent/tools/tool-surface-spec/dexscreener-site/`, which
is entirely new and untracked. No commits, no pushes.

---

## 1. Where the work stands

| Item | State |
|---|---|
| Live reconnaissance of the DexScreener website API | DONE, ~150 HTTP + ~165 WS probes, 2026-08-23/24 |
| Electron transport feasibility spike | DONE, 4 scripts, `net.fetch` and hidden-window WS both proven |
| Protobuf schema extraction (25 files) | DONE, checked in as descriptors + human-readable dump |
| Tool plan v1 (16 tools) | DONE |
| Enrichment doctrine + per-tool derived metrics (owner ask: "every tool as deep as candles") | DONE, plan sections 4.0 and 4.8 |
| Codex plan review turn 1 | DONE, verdict BLOCKED, findings verified by me and accepted |
| Plan revised to v1.1 with 14 corrections | DONE |
| Codex plan review turn 2 (live probing, contested items) | **NOT DONE. Dispatched, then killed on start. No results.** |
| Implementation | NOT STARTED, and must not start before turn 2 closes |

Harness gates passed so far: latest-instruction, memory, repo-truth, user-brief,
full-plan, implementation-mode (owner chose builder subagent). Gate 7 (Codex plan
review) is OPEN: turn 1 returned BLOCKED, turn 2 never ran. Convergence cap is 3
turns per review arc (owner decree 2026-07-29), so at most two more turns before
the coordinator must decide and name the disagreement to the owner.

---

## 2. Owner decisions in force (do not re-litigate)

- **D-DS1** Implementation mode: builder subagent. Coordinator delegates stages and
  inspects every diff.
- **D-DS2** Retirement of the 12 current DexScreener tools is total and alias-free.
  Owner's words: they are not needed and only clutter. Delete manifests, handlers,
  embeddings, mapping rows, snapshots and their tests. No deprecation alias rows.
- **D-DS3** No public-API leftovers. `orders`, `communityTakeovers` and the
  60-address batch pair lookup are dropped, not kept alive on the public API. The
  public API survives only as a degraded transport inside a new tool.
- Browser-user approach to the website API: decided by the owner, not open.
- Production quality immediately, nothing deferred as beta.
- Every tool must be as rich as `candles_list` (the enrichment doctrine).
- CoinGecko lane: CANCELLED by the owner 2026-08-24 (D-DS8), superseded by the
  delivered site-API depth. Not deferred; a revival would be a new decision.

---

## 3. The 16 planned tools (names only; full spec in the plan)

Screening: `dexscreener__pairs_trending_list`, `dexscreener__pairs_top_list`,
`dexscreener__gainers_list`, `dexscreener__losers_list`,
`dexscreener__pairs_new_list`, `dexscreener__launchpad_pairs_list`.
Resolve: `dexscreener__pairs_search`, `dexscreener__token_pairs_list`,
`dexscreener__pair_get`.
Deep dive: `dexscreener__pair_details_get`, `dexscreener__candles_list`,
`dexscreener__trades_list`, `dexscreener__top_traders_list`.
Context: `dexscreener__narratives_list`, `dexscreener__spotlight_get`.
Reference: `dexscreener__chains_list`.

The first six are CONTESTED (see section 6).

---

## 4. Facts that must survive the compaction

Measured, and load-bearing for the design:

- Cloudflare blocks by TLS/HTTP2 fingerprint. Node `fetch`, `undici`, Python
  `requests`/`websockets`, plain `curl`: 403. Chrome-impersonating clients and
  Chromium's own stack: 200, no challenge, no cookies.
- Electron main `net.fetch` reaches `io.dexscreener.com` with Chrome UA + `Origin`
  + `Referer`; the SSR HTML host needs the full Chrome navigation header set.
- Electron WS needs a hidden `BrowserWindow`. It must load `app://vex/...`, NOT the
  `data:` URL used in the spike (`.agents/skills/vex-electron-security/SKILL.md:28`).
- Screener: `wss://io.dexscreener.com/dex/screener/v7/pairs/{m5|h1|h6|h24}/{page}`,
  100 rows/page, qs bracket filter form, filters and sort run server-side.
- Candles: 999 bars max per call on BOTH transports; backward paging by
  `beforeBlockNumber` = previous page's `minBlockNumber` is continuous (verified 3
  pages); daily and above exist only on the feed WebSocket; market-cap series needs
  no supply argument; 999 H1 bars decode to 271 KB.
- **`balancePercentage` = `balanceAmount / volumeBuy * 100`**, verified on 99 of 100
  rows. It is the retained share of what a wallet BOUGHT, NOT percent of supply.
  Any tool field claiming supply ownership from it is financially false (rule 90).
- GoPlus DOES return holders on EVM (`gp.holders`, `gp.lpHolders`, `gp.holderCount`);
  the top-level `holders` key is null there. Catalog audit coverage: 74 chains, 56
  EVM, GoPlus 21, QuickIntel 24, both 13, neither 24.
- `rankBy=fdv` returns the `txns` ordering (measured 100/100 identical addresses).
  Screener audit filters (`isHoneyPot`, taxes, holder counts) are accepted and
  ignored. Live trade push is gated off by `isDEXFeedStreamEnabled` (false on every
  top-100 volume pair of solana, ethereum, base).
- `pairsCount` drifts about 6.6 percent inside 30 seconds; treat as approximate.
- Search v12 honours a singular `chainId` server-side (undocumented, found by
  probing); `page`, `offset`, `limit`, `dexId`, plural `chainIds` are ignored; the
  cap is 30 rows with no continuation.
- SSR HTML host 429s after about 30 loads in 9 seconds with `Retry-After: 40`.
  `io.dexscreener.com` showed no rate limiting across 155 sequential WS sessions.
- `ProtocolParamDef.type` is `string | number | boolean | object`: NO array member.
  Lists are `type: "string"` with `acceptsStringArray: true`. `fields` is
  comma-separated field GROUPS (`conventions.ts:126`).
- There is no engine-level output byte cap; 16,384 bytes is this lane's self-imposed
  test budget (`output-envelope.md` section 4).

Two operating lessons, both mine, both recorded so they do not repeat:

1. **Verify a Codex fan-out against the rollout JSONL, not the driver's
   `events.jsonl`.** codex-cli 0.149.0 carries both event vocabularies; the thin
   stream emits `sub_agent_activity` while the harness skill documents a grep for
   `collab_agent_spawn_begin`. I used the documented grep, got zero, and wrongly
   accused Codex of fabricating a fan-out he had really performed
   (`momentum_launch`, `risk_audit`, `chart_flow`). `.claude/skills/harness/SKILL.md`
   still carries the stale instruction and should be corrected.
2. **Consult mode has no network.** The driver sets sandbox `read-only`, where
   network is `restricted`, so Codex genuinely could not probe in turn 1. Verified
   fix: run with `--mode build --config 'sandbox_workspace_write.network_access=true'`,
   which produced `curl` 200 from the public API and `curl_cffi` 200 with 67,402
   bytes from `io.dexscreener.com`, with `files_changed: []`.

---

## 5. Codex state and how to resume

Thread name: `harness-dexscreener-tools`, thread id
`01a032f1-0f41-7981-af2b-29eb8a87f35b`. The index still points at turn 1, so a
`continue` resumes cleanly.

Turn 1 verdict BLOCKED, full reply at
`/home/kubas/.claude/codex-artifacts/runs/20260824T084413Z-2032701/last.md`.
Turn 2 prompt is already written and unsent-in-effect:
`<scratchpad>/codex-turn2.md`.

Resume command (network enabled, repo not writable because cwd is the scratchpad):

```bash
~/.claude/skills/codex/codex-run.sh continue \
  --name harness-dexscreener-tools --mode build \
  --config 'sandbox_workspace_write.network_access=true' \
  --prompt-file /tmp/claude-1000/-home-kubas-Vex/8a03fa30-1e20-42c6-be58-ae8b1cebd991/scratchpad/codex-turn2.md
```

Run it with `run_in_background: true`; it needs several minutes. Afterwards: parse
the driver's JSON line, read `last_message_file`, and CHECK `files_changed` is
empty. Watch live with
`~/.claude/skills/codex/codex-watch.sh harness-dexscreener-tools`.

What turn 2 must deliver: the live probe matrix as a trading specialist (five
lenses, subagents), verdicts on the two unresolved channels, a position on the
granularity synthesis, and any remaining blockers.

---

## 6. Open questions blocking implementation

1. **Screening granularity.** Codex wants two contracts (`pairs_screen` +
   `launchpad`), citing Studio decision O20: every tool is statically exported in
   `tools/list`, so six near-identical schemas are paid by every MCP client every
   session regardless of retrieval. My counter: sorting by price change without a
   quality floor returns measured garbage (+7.2e12 percent top row), so one
   `sortBy` tool needs either a hidden floor or four thresholds from the agent.
   **My proposed synthesis (plan 13.1): one `dexscreener__pairs_screen` with both
   `sortBy` and an optional `preset` enum expanding to the site's own sort plus
   floor, echoed in `filtersApplied`, plus `launchpad_pairs_list` separate.** The
   owner was asked and has not answered yet. This is a product decision.
2. **`/dex/screener/v8/pairs-search`** (subscribe by explicit `{chainId,id}` list;
   candidate bounded batch-snapshot channel) and
   **`/dex/screener/v2/tokens/{tf}/{page}`** (token-grouped leaderboard, closer to
   the owner's "lists of tokens per chain" than a pool screen). Both unprobed. No
   completeness claim is honest until they are.
3. **SSR fallback**: keep or delete. Delete unless it answers something the WS and
   HTTP paths cannot.
4. **Protobuf runtime**: `protobufjs` is only transitive in the lockfile. Needs a
   direct reviewed dependency or checked-in generated codecs (rule 07).
5. **Sanitizing invisible and BiDi characters** out of issuer-authored text: strip
   and report, or leave whole. Needs an owner ruling against the no-silent-cutting
   decree.
6. **Is `pair_details_get` a pre-swap hard gate** or descriptive research only?
   Money-path policy, rule 00 hard stop, owner decision.
7. **Commercial exposure through Studio MCP** of an undocumented website API.
   Codex raised DexScreener's API terms. Owner already chose the approach; the
   commercial-export dimension should be answered explicitly, not inherited.

---

## 7. Paths to read after the compaction

Read in this order. The first two carry almost everything.

**The lane (all new, untracked):**

```
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/dexscreener-site/HANDOFF.md      <- this file
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/dexscreener-site/tool-plan-v1.md <- the plan, v1.1, ~1050 lines, revision log at top
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/dexscreener-site/recon.md        <- measured endpoint inventory
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/dexscreener-site/evidence/report-screener-level.md
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/dexscreener-site/evidence/report-pair-level.md
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/dexscreener-site/evidence/report-electron-spike.md
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/dexscreener-site/evidence/dexscreener-schemas.proto.txt
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/dexscreener-site/evidence/dexscreener-descriptors.pb
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/dexscreener-site/evidence/table-chains.json
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/dexscreener-site/evidence/table-metas.json
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/dexscreener-site/evidence/extract-descriptors-from-bundle.py
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/dexscreener-site/evidence/parse-server-data.py
```

**Codex artifacts:**

```
/home/kubas/.claude/codex-artifacts/runs/20260824T084413Z-2032701/last.md   <- turn 1 review, BLOCKED
/home/kubas/.codex/sessions/2026/08/24/rollout-2026-08-24T10-44-14-01a032f1-0f41-7981-af2b-29eb8a87f35b.jsonl
/home/kubas/.claude/codex-artifacts/threads.json
```

**Scratchpad (same session, so it persists):** base is
`/tmp/claude-1000/-home-kubas-Vex/8a03fa30-1e20-42c6-be58-ae8b1cebd991/scratchpad/`

```
codex-plan-review.md   codex-turn2.md          net-test.md
proto_pool.py          proto-extract.py        proto-dump.py
ws-pairs.py            ws-verbose.py           ws-raw.py         ws-variants.py
bars-page.py           bars-depth.py           bars-depth.out
search-chain-probe.py  search-chain-probe2.py  search-probe.py
ssr-probe.py           extract-state.py        dsavro.py         pl_avro.py
connect-gettx.json     pair-details-{solana,ethereum,robinhood}.json
spotlight.json         tokens-first.json       pairs-first.json
table-chains.json      table-dexes.json        table-metas.json
electron-spike/main.cjs  main2.cjs  main3.cjs  main4.cjs
venv/bin/python        <- curl_cffi 0.16.1 + protobuf, the only working probe runtime
```

**Repo authoring contract (needed before writing any manifest):**

```
/home/kubas/Vex/src/vex-agent/tools/protocols/types.ts                <- manifest + param types
/home/kubas/Vex/src/vex-agent/tools/protocols/catalog.ts              <- namespace registration, availability
/home/kubas/Vex/src/vex-agent/tools/protocols/conventions.ts          <- canonical param keys, banned spellings
/home/kubas/Vex/src/vex-agent/tools/protocols/_manifest-lint.ts       <- 12 lint rules, shrink-only allowlist
/home/kubas/Vex/src/vex-agent/tools/protocols/public-name-gate.ts
/home/kubas/Vex/src/vex-agent/tools/protocols/lifecycle.ts
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/parameter-vocabulary.md
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/output-envelope.md
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/style-guide.md
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/identity-and-migration.md
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/mappings/dexscreener.json
/home/kubas/Vex/src/vex-agent/tools/tool-surface-spec/studio-mcp/vex-studio-plan-v2.md   <- sections 2.1-2.3, O20
```

**What is being replaced:**

```
/home/kubas/Vex/src/vex-agent/tools/protocols/dexscreener/    <- 12 tools, manifests, handlers, pair-list, list-core
/home/kubas/Vex/src/tools/dexscreener/                        <- client.ts, throttle.ts, errors.ts, validation/
/home/kubas/Vex/src/__tests__/dexscreener/                    <- 31 test files
```

**Electron side (transport implementation target):**

```
/home/kubas/Vex/vex-app/src/main/agent/index.ts               <- lifecycle mount point
/home/kubas/Vex/vex-app/src/main/market/market-http.ts        <- existing minimal main-side HTTP client
/home/kubas/Vex/.agents/skills/vex-electron-security/SKILL.md <- app://vex/ rule, line 28
```

**Reference checkout studied:**

```
/home/kubas/Vex/agents-colab/github-mcp-server/pkg/inventory/
/home/kubas/Vex/agents-colab/github-mcp-server/pkg/github/tools.go
/home/kubas/Vex/agents-colab/github-mcp-server/pkg/github/minimal_types.go
/home/kubas/Vex/agents-colab/github-mcp-server/pkg/errors/error.go
/home/kubas/Vex/agents-colab/github-mcp-server/pkg/sanitize/sanitize.go
```

---

## 8. Immediate next action

Re-dispatch Codex turn 2 with the command in section 5, then report its live
measurements and its position on the granularity synthesis. Do not begin
implementation: harness gate 7 is still open and the owner has not answered the
granularity question.

## OWNER ORDER 2026-08-25 (post-S9, before Codex)

Two NEW stages inserted after S9 inspection, before the Codex final turn:
(A) coordinator PERSONAL live test: production trading-agent angle, "what
market intelligence can this surface actually deliver" (fresh Solana hunt,
Robinhood/HOOD, VEX trend read, market pulse, batch watchlist) and
(B) wave 3 v2: 10 Opus 5 agents, EACH with all 18 tools, each a trading
persona (sniper, momentum, safety, whale flow, narrative, listings scout,
market structure, cross-chain, portfolio monitor, skeptical auditor) using
the tools as in production; READY/NOT READY verdicts; quality bar compared
against github-mcp-server reference patterns.
Full protocol: scratchpad/wave3/PLAN.md (absolute:
/tmp/claude-1000/-home-kubas-Vex/8a03fa30-1e20-42c6-be58-ae8b1cebd991/scratchpad/wave3/PLAN.md).
Sequence now: S9 builder -> coordinator inspection -> personal test (A) ->
wave 3 (B) -> fix pass if any NOT READY -> Codex final turn -> integration
(bridge mount, merge to feat/studio-p, gates, reembed + dense baseline,
in-app smoke) -> commit+push to PR (this lane's paths only).

## OWNER 2026-08-25: prompt source-hierarchy card (IN SCOPE) + board idea (NEXT LANE)

IN SCOPE for this lane (after S9 lands): add a system-prompt source-hierarchy
card that (a) names all 18 dexscreener tools explicitly, (b) declares THREE
primary research sources: the DexScreener reverse-proxy surface (market
data), web research tools (src/vex-agent/tools/internal/web-research/,
web.ts), and Twitter tools (twitter-account.ts, twitter-projection.ts),
(c) marks the other market-data protocols (trench, pools, virtuals, etc.)
as fallback sources used when the primaries cannot answer (owner
correction 2026-08-25: all three are MAIN sources, not confirmation-only).
Prompt module lives with the other cards in src/vex-agent/engine/prompts/
(snapshot-tested like siblings). ALSO verify the Tool Map section
(tool-catalog.ts -> getVisibleToolsByCategory) shows the 18 tools under
D-DS9 always-injection - same visibility union as the tools array, this is
the drift point to check.

BOARD LANE ESCALATED (owner 2026-08-25): no longer just an option - design
starts NOW. Explore agent dispatched for reconnaissance (report:
/tmp/claude-1000/-home-kubas-Vex/8a03fa30-1e20-42c6-be58-ae8b1cebd991/scratchpad/board-lane/REPORT.md).
Owner adds: the CURRENT vex-app market element is likely obsolete and every
reference to the old 12 dexscreener tools in vex-app is dead code to remove
(verify first: main/market/* has its OWN HTTP clients, may be the
independent VEX-token card, not tool-dependent). Owner addendum: gecko-client
(CoinGecko) is ALSO removed repo-wide (consistent with D-DS8); the redesign
is a DATA-SOURCE SWAP to the new dexscreener surface, never a bare deletion
- own-token banner and the VEX token card must keep their data. Quality bar: senior
patterns from deepseek-harness (owner's pick for UI/UX), vscode,
github-mcp-server. Implementation still lands AFTER the current lane's
commit+push. Approved shape:
"dexscreener board" - internal-only tool (hidden from Studio MCP) where the
agent composes a DECLARATIVE JSON board spec (schema-validated; never HTML):
token cards (logo, chain badge, price, metrics), chart specs with agent
annotations (levels/zones/markers from candle analysis), notes. Renderer
renders the spec with owned components in chat; live refresh by subscribing
declared pools to the EXISTING dexscreener-bridge WS channels via a
main-process subscription manager over typed IPC (latest-only, bounded,
cleanup on unmount). Board spec persisted in the transcript (model-visible
iff logged). Token/chain logos fetched+cached in main, not renderer
hotlinks. Board is presentation, never authority - no signing shortcuts.
Rationale: per-user IP + fingerprint session means no central rate limit;
politeness budgets stay per app instance. Reuse candidate:
vex-app/src/main/market/dexscreener-pair.ts.

## STATE 2026-08-25 late: wave 3 done, builder S10 running

Committed+pushed: branch feat/dexscreener-site, commit 64e2ee67 (360 files)
including the prompt source-hierarchy card (budget ceilings raised with a
reviewed diff; source-policy test contract changed for D-DS9 names).
Coordinator personal test: 5 missions, 20+ live calls through
executeProtocolTool, report scratchpad/personal-test/REPORT.md. Verdict:
surface is powerful; found the batch "valid identity" wording defect.
WAVE 3 (10 Opus trading personas, all 18 tools each, live): 10/10 reports,
9 NOT READY + 1 READY (P4 whale-flow). All findings consolidated with
locations and fix directions in scratchpad/wave3/S10-LEDGER.md (S10-0..60).
Convergent diagnosis: envelope layer exemplary; defects cluster in
(A) batch row/identity invariant, (B) summaries not derived from envelope
facts (trades/candles/inverted/screeners), (C) derived aggregates not
reconciled with raw columns (pool-as-holder, LP shares, mcap<=fdv),
(D) unvalidated vocabularies (metaIds, batch chain slugs), (E) false
manifest claims (pairs.new launchpad sentence, core-carries-identity,
fields-narrowing coverage lies). Builder S10 dispatched with the ledger,
priorities A-E, rule-10 live re-verification mandate, D-DS7 order, full
ladder. After S10: coordinator inspection -> targeted re-verify of HIGH
fixes -> Codex final turn (harness-dexscreener-tools, live mandate) ->
integration -> commit+push. P3 residual evidence gaps rider: live non-zero
tax + populated hpi block (builder attempts opportunistically).

## OWNER ORDER 2026-08-25: S11 data-source swap (after S10, in integration)

Owner named two swaps; measured blast radius is SIX consumers of the OLD
public-API client (src/tools/dexscreener/client.ts survived the tool
deletion): (1) vex-app/src/main/market/dexscreener-pair.ts fetchVexPair
(the $VEX widget), (2) engine/wake/price-watch-poller.ts +
engine/wake/watch/token-price.ts (loop_defer price watches - owner wants
the wake price from the new WS surface), (3) engine/prompts/
own-token-banner.ts, (4) protocols/uniswap/handlers/swap/quote-safety.ts,
(5) tools/evm-chains/balances.ts, (6) vex-app gecko-client (already
decreed removed, D-DS8-adjacent). Plan: migrate ALL consumers to a shared
new-surface price read (pairs-batch: every watched token in ONE WS frame
per poll tick; pair endpoint for single reads; degraded public-API
transport keeps headless working), THEN delete the old client whole (no
second source of truth for prices). loop_defer phase 2 (true WS push
instead of polling) shares the bridge subscription extension with the
board lane - do not build it twice. Sequence: after S10 lands, as part of
integration (bridge mount is the prerequisite for the in-app site
transport).

## Board lane pattern catalog DONE (Explore phase 2, 2026-08-25)

/tmp/claude-1000/-home-kubas-Vex/8a03fa30-1e20-42c6-be58-ae8b1cebd991/scratchpad/board-lane/PATTERNS.md
(895 lines): exemplar per seam with file:line; KEY FINDING: transcript-bridge
is a refresh signal only (DB row canonical), so an atomically-composed board
needs NO stream-bridge change - seam 3 collapses into the mapper seam; board
MUST be composed atomically (no mid-stream builds). 850-line audit: no
facade refactor needed in the touch zone (largest touched file 492 lines);
TranscriptMessage stays safe only if case "board" is one delegating line.
Wiring order A (static) -> B (live, gated on bridge mount) -> C (market
swap) -> D (optional); ~28 new files ~3800 lines with tests. Top pitfalls:
mid-stream composition, permissive schema re-opening raw JSONB, two-schema
drift (silent null), subscription lifetime vs 4-exchange bridge cap,
broadcastToAllWindows leaking keyed payloads.

## OWNER FREEZE + closing protocol (2026-08-25)

Owner decree: S10 is the FINAL fix round for the dexscreener tools - after
it, findings become documented known issues (a blocking money-path defect
goes to the owner, never a silent new round). Closing protocol written:
lane-protocol-2026-08-25.md (both copies). Codex board-plan review
dispatched on NEW thread harness-vex-board (prompt:
scratchpad/codex-board-plan.md) - review-to-GREEN-LIGHT of the board design
per REPORT.md + PATTERNS.md; board implementation stays AFTER lane close.

## BOARD PLAN: GREEN LIGHT (Codex, harness-vex-board, turn 3, 2026-08-25)

Amended plan approved as implementation-ready: stages A0 (contract +
pendingPresentation with BoardCompose as a TERMINAL tool - sole call in
batch, staged->prose-consume, parking unreachable while pending) -> A1
(static board; chart adapter owns validation because the lib's checks are
dev-only asserts stripped in production; update()-for-ticks no-flicker
contract proven from installed bytes; PriceFormatCustom for 1e-13 prices;
attributionLogo off + static licensed attribution; conditional mount of
BoardChart from ExpandRegion open state so collapse detaches primitives and
calls chart.remove()) -> B1 (opt-in polling) -> B2 (persistent channels,
gated on bridge fixes S10-61..63 + lifecycle machine + capacity
measurement). Stage C = S11 (separate migration lane). A1 spike gates (not
assumptions): reverify 5.2.1 bytes post-install, prove prepend offset
arithmetic, compile against fancy-canvas signature, keep animation +
conflation disabled. Reject-only hostile-text predicate in the pure-root
contract (shares the code-point table with the sanitizer, never
transforms). Key docs: board-lane/{REPORT,PATTERNS,CHART-PLAYBOOK}.md +
codex-board-plan{,-t2,-t3}.md in scratchpad. Implementation starts AFTER
this lane's commit+push.

## EXECUTION IN FLIGHT (2026-08-25 evening): board A0+A1 + S11, 6 parallel builders

Branch feat/vex-board (off feat/dexscreener-site @ 7a44d733, the CLOSED
dexscreener lane). ROOT plan with the FROZEN BoardSpec v1 contract table,
task ownership and assembly steps:
/tmp/claude-1000/-home-kubas-Vex/8a03fa30-1e20-42c6-be58-ae8b1cebd991/scratchpad/execution/BOARD-S11-ROOT.md
Tasks: T1 pure-root schema+reject predicate; T2 engine BoardCompose
terminal tool + pendingPresentation; T3 app persistence (assistant-row
projection, mapper triad, row model); T4 renderer Board feature + chart
adapter per CHART-PLAYBOOK; T5 S11a engine price-consumer swaps
(characterize->swap->shadow); T6 S11b market widget swap + gecko removal.
Coordinator assembles (old-client deletion at measured zero consumers),
commits in 4 reviewable slices, pushes, then CODEX VERIFICATION on thread
harness-vex-board (4 fan-out lenses) per the ROOT's final section.
