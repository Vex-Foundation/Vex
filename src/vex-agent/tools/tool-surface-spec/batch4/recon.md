# Batch 4 reconnaissance (measured 2026-08-22, read-only)

Three Explore agents measured the four Batch 4 items (D14 step 3: parameter
vocabulary O3, output envelope O4, response_format, Task 0b) against the tree
at 76f6306d (feat/prompt-wave2, after Wave 2). Evidence paths are relative to
the repository root. Nothing here was verified by running code; every count
is static. O5 (structuredContent / outputSchema) was not measured: its
default ("none until the Studio MCP design") puts it in D14 step 4.

## O3. Parameter vocabulary: 329 entries, 4 renames

- The 329 `param-key` allowlist entries (`protocols/_manifest-lint/allowlist.ts:188-530`)
  span 143 distinct keys. Only 4 entries have a canonical TARGET, all from
  `BANNED_PARAM_KEYS` (`conventions.ts:288-297`): `wallet` -> `walletFamily`
  on `BridgeStatus`, `khalani.orders.list`, `khalani.tokens.balances`; and
  `address` -> `tokenAddress` / `walletAddress` on `BridgeStatus`. All four
  subjects are READ tools.
- The other 325 entries (141 keys) fail the rule's second branch only: "a
  key not yet in CANONICAL_PARAM_KEYS" (`allowlist.ts:189`). They are
  resolved by RATIFYING the key into `CANONICAL_PARAM_KEYS` with a reason
  (`parameter-vocabulary.md:307-312`): two files, zero manifest, handler,
  snapshot or fingerprint change. Most frequent: `market` 13 tools, `sortBy`
  12, `explainDrops` 10, `sortDir` 9, `recipient` 8, `query` 7, `tradeType`
  6, `symbol` 6, `prebuy` 6, `omitFields` 6, `name` 6, `window` 5, `pt` 5,
  `minLiquidityUsd` 5, `cursor` 5. D1 already ratifies `query` and keeps
  `cursor` per API type; the one rename D1 creates is `search` -> `query`
  on two Morpho discover params (`morpho/manifests/vaults-discover.ts:135`,
  `markets-discover.ts:79`), both READ tools.
- Consumers of param KEYS outside the handler:
  - boundary: `runtime/params.ts:validateProtocolParams` (`:395-511`),
    unknown key rejected BY NAME with the replacement from
    `BANNED_PARAM_KEYS` (`:419`) and the allowed keys listed (`:432`).
  - prequote match hash: VALUES in fixed positional order, no key names
    (`prequote/identity/hash/swap.ts:95-118`); a rename does not move it.
  - approval fingerprint: param keys ARE hashed
    (`engine/core/approval-runtime/tool-call-envelope.ts:26-37,203-220`);
    a rename makes every queued approval for that tool refuse on cold
    resume (fail-closed). Irrelevant for the six read-tool renames above,
    because the approval queue holds mutating calls only.
  - durable raw args: `approval_queue.tool_call` (replayed, canonicalized)
    and `protocol_executions.params` (audit only, never replayed).
  - `exampleParams` (134 blocks, 70 manifests) feed the corrected-call
    example in `params.ts:describeMissingRequired` (`:131-136`): a stale
    example teaches the rejected spelling.
  - toolsnaps capture param keys (166 of 167 contracts); tests: 73 files
    assert param keys.
- No param alias mechanism exists; `name-resolution.ts:208-211` states that
  tool-name aliases cannot map arguments. The structural precedent is
  `rejectedParams` (`protocols/types.ts:150-170`). The seam for an alias
  rewrite is step 0 of `validateProtocolParams`, where
  `normalizeChainValueParams` (`params.ts:296-333`) already mutates the
  params in place so the handler, the capture row and the gates see one
  value. `paramsToJsonSchema` (`registry/khalani.ts:60-88`) must never emit
  an alias key.
- Allowlist contract gap: `SUBJECT REWRITE` (`allowlist.ts:16-22`) rewrites
  `subject` only; `detail` is the param key. A rename therefore DELETES the
  entry (the key becomes canonical) rather than rewriting it.

## O4. Output envelope: the 24 are description mentions, not silent handlers

- The audit counted descriptions that PROMISE no continuation field
  (`batch3/mcp-readiness-audit.md:182-198`), not handlers that emit none.
  Measured against handlers, 15 of the 24 already emit a continuation
  signal (Group A): morpho markets/vaults/positions (`hasMore`,
  `nextOffset`, `filtersApplied`), dexscreener narratives (provenance
  envelope `list-core/provenance.ts:163-195`), pools my-launches
  (`nextCursor`), ToolSearch (`hasMore`), TwitterAccount (`next`), five
  Jupiter predict tools (`pagination {start,end,total,hasNext}`), virtuals
  agents/graduations (`window` + `windowNote`), khalani orders (`cursor`).
  Their gap is the DESCRIPTION, which is METADATA.
- Group B1, truly silent but the facts are in hand (pure local arithmetic,
  no provider change): `trench__images_list` (`trench/handlers/images.ts:66-80`,
  has `totalAvailable`), `WalletBalances` (`internal/wallet/read.ts:377-405,487-494`,
  trims and reports only `unpricedOmitted`; class bounded_non_pageable,
  needs `truncated`), `virtuals__genesis_launches_list`
  (`virtuals/handlers.ts:181-193`, has `pagination.total`),
  `solana__predict_events_search` (`solana-jupiter/handlers/predict.ts:77-104`,
  slices locally at `:103` and says nothing). The last two are the only
  live sites in tension with the owner's no-silent-cut rule.
- Group B2, honesty needs an extra fetch or provider call: `trench__my_launches_list`
  (DB read takes `limit`, no total), `trench__tokens_search`,
  `pools__token_candles_list`, `khalani__tokens_autocomplete` (`nextSlots`
  is a parse hint, not paging), `solana__predict_leaderboard_list`.
- Descriptions that promise a field the handler does not emit: ZERO found.
  The tools without a field say so explicitly (`trench/manifests/tokens.ts:24`,
  `trades.ts:15`, `pools/manifests/tokens.ts:16`, `registry/portfolio.ts:20`).
  One unverified: `dexscreener/manifests/trending.ts:49,78` promise the
  provenance envelope for the feed tools; whether `feed-pipeline.ts` routes
  through `buildPairListEnvelope` was not traced.
- `summary`: 28 handler files emit it (morpho all 13, pendle reads, relay,
  kyberswap quote, pools claim and launch broadcast, solana swap quote,
  trench trade quote). Zero in dexscreener (one seam: `provenance.ts`),
  virtuals (`windowNote` instead), uniswap, khalani (hand-built
  pretty-printed JSON, bypasses `ok()`: `khalani/handlers/read.ts:194-208`),
  solana predict and lend, trench and pools reads, the pendle mutation
  half. Fourteen handlers carry `message` / `note` / `windowNote` /
  `truncationNote` / `guidance` instead, and `solana__predict_leaderboard_list`
  emits a PROVIDER object literally named `summary`
  (`predict-social.ts:160`). A blanket `summary: string` collides there.
- Consumers of the success JSON other than the model: transcript stores the
  `output` string verbatim; the renderer card renders `output` whole and
  reads a first line only on `success === false`
  (`vex-app/.../ToolLedger/ToolActRow.tsx:152-154,401-406`), so a `summary`
  field is NOT visible in the UI; the confirm stamp parses JSON for
  `status` and `txHash` under a 20,000-char guard (`:60-89`); toolsnaps do
  NOT capture output shapes (`toolsnaps/build-contracts.ts:281-356`);
  tests: 162 files parse handler output, 1,233 `toEqual({` sites, zero
  snapshots, so any additive field is a wide mechanical test edit.
- There is no envelope owner: `ok()` (`handler-helpers.ts:48-50`) has no
  access to counts or limits and cannot carry the contract.
- Continuation vocabularies measured: six in protocols (`hasMore`+`nextOffset`;
  provenance `totalMatched/returned/hasMore/droppedByFilter`; `nextCursor`;
  Jupiter `pagination{}`; virtuals `window`+`windowNote`; Twitter `next`)
  plus AgentScan `nextCursor`+`hasMore` and khalani bare `cursor`.

## response_format

- Six declaration sites, five handler reads, three read mechanisms
  (`enumField` off raw params for `.strict()` schemas in long-memory get and
  suggest and mission; a Zod field in wallet and memory-search; pre-schema
  name rejection in twitter-account `internal/twitter-account.ts:26,32-39`).
  The shared module `output-envelope.md:301-308` describes does NOT exist;
  the enum is re-declared inline in six places.
- `wallet_balances`: the only reader of the format is `trimTokens`
  (`internal/wallet/read.ts:483`, `if (responseFormat === "detailed" || limit === undefined) return`).
  A bare call is byte-identical under a hypothetical `concise` default
  (pinned at the symbol and marker level by `wallet.test.ts:212-226` and
  `read-concise-unpriced.test.ts:209-222`). The REAL behavior change under
  R1 is `{limit: N}` WITHOUT `response_format`: today it returns every row
  (`registry/wallet.ts:33`), under a concise default it would trim, re-sort
  by held USD, add `priceUnavailable`, cap unpriced rows at 20 and emit
  `unpricedOmitted`. No test covers that case.
- github-mcp-server convention: verbosity is a boolean `minimal_output`
  defaulting to TRUE (`pkg/github/search.go:40-44,79`), the minimal shape is
  a named type (`pkg/github/minimal_types.go`), pagination is declared by
  shared decorators (`params.go:347-403`) and reported back as `pageInfo`
  (`params.go:458-463`).

## Task 0b. AgentScan transfer egress

- The Vex-side gate is one SQL fragment, not a flag: `ELIGIBILITY_SQL` in
  `db/repos/agentscan-reporting.ts:77-87`; `transfer` and `wallet_transfer`
  are absent from its kind and role lists and the exclusion is not named in
  its comment (`:65-76`). Switching on = adding both names, plus a readiness
  arm for `wallet_transfer` in `ROLE_LEGS_COMPLETE_SQL` (`:130-145`, falls
  to `ELSE TRUE`) mirrored arm for arm in `agent-activity/role-legs.ts`.
  The server refuses an output leg on a transfer, so the Vex side must
  never send `executed_amount_out_raw` on those rows.
- Test seam: `src/__tests__/integration/agentscan/eligibility-readiness.int.test.ts:144-190`
  (`REPORTABLE` / `NEVER_REPORTABLE` tables); `transfer` appears in neither,
  so nothing pins the exclusion today.
- Server status (GitHub, 2026-08-22): `BerzanTas/vex-agentscan` default
  branch is `dev`; `feat/transfer-kind` (1a1397f, 11 files, +229/-8,
  migration 0016 expand-only) is pushed, has NO pull request, and is not
  merged into `dev` (ahead 1, behind 3). The local checkout is
  `agents-colab/vex-agentscan` on that branch. Egress stays closed until
  the server change is merged AND deployed.
