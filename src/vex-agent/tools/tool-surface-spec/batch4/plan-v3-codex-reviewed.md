# Batch 4 plan v3, Codex reviewed (GREEN LIGHT 2026-08-22, thread harness-batch4)

Repository worktree: /home/kubas/Vex-batch4, branch feat/tool-surface-4, cut
from feat/prompt-wave2 at 76f6306d (Wave 2, PR #109 open against main).
Uncommitted in that worktree: src/vex-agent/tools/tool-surface-spec/batch4/recon.md
(the measured reconnaissance), owner-decisions.md D15-D17 (the rulings this
plan executes), OPEN-DECISIONS.md (O3 removed, O4 narrowed, O5 deferred).

## 1. Task and the owner's latest constraints

D14 step 3, Batch 4: parameter vocabulary (O3), output envelope (O4),
response_format, Task 0b. The owner ruled on 2026-08-22 (D15, D16, D17):

- O3: ratify the 141 allowlisted keys that have no canonical target (325
  allowlist entries deleted, metadata only); the six true renames, all on
  READ tools, land WITH input aliases (old spelling accepted and rewritten
  at the boundary, never in the schema, both spellings rejected by name,
  aliases in the manifest fingerprint, removeAfter naming D5).
- O4: descriptions of the fifteen tools that already emit a continuation
  signal name those fields (metadata); four silent handlers gain the
  continuation or truncation fields their pagination class requires from
  facts already in hand (additive, no new provider call). The summary
  sweep and the five extra-fetch handlers stay open (O4 narrowed). O5 is
  deferred to the Studio MCP design.
- response_format: one shared module modelling four states; wallet_balances
  keeps `detailed` as a ratified exception (R2); a test pins `{limit}`
  without a format returning every row.
- Task 0b: stays closed (server branch not merged to dev, no PR); nothing
  to implement.

Standing constraints: tool BEHAVIOR frozen beyond the rulings above (no
handler logic, approval, prequote or persisted-write change); no em dashes
in authored content; no content cutting; D9-frozen retrieval fields
(embeddingText, aliases, exampleIntents, navigation aliases, facets,
discoveryHints, exampleQueries) stay byte-identical; descriptions may
change (they are not D9-frozen; the lexical baseline moves and is
recaptured with disclosure); no commits or pushes without the owner's
word; implementation mode (b): builder subagents in parallel on disjoint
files, coordinator reads every diff and runs the gates.

## 2. Rules loaded and their consequences

CLAUDE.md: FORBIDDEN silent content cutting (the four B1 handlers are the
place this rule is currently in tension with the code: two of them drop
rows without saying so); provider integration depth (no new provider
surface here); no AI attribution; em-dash ban.
Rule 00: hard stops on public API, wire, durable format and tool
contracts: every change here is inside an explicit owner ruling (D15-D17);
nothing beyond them.
Rule 04: validate once at the boundary (the alias rewrite lives at the
existing boundary seam); published surfaces prefer additive changes with
deprecation (aliases with removeAfter).
Rule 05: bounded processing must be explicit and report truncation (the
B1 fields); no new unbounded buffers.
Rule 06: tests at the location of risk: alias acceptance, both-spellings
rejection, schema never emits the alias, fingerprint includes aliases,
B1 field arithmetic at the boundary values, wallet `{limit}` pin, retired
response_format still rejected by name.
Rule 09: tool descriptions and schemas are behavior changes: toolsnaps
regenerated and reviewed as contract diffs; lexical retrieval re-measured.
Rule 90: money-path invariants untouched (no mutating tool is in scope).

## 3. Repo context inspected

batch4/recon.md records the measured facts with evidence paths. The
precise sites:

- Renames (six, all READ):
  - registry/action-aliases.ts:250-274 `BridgeStatus` (internal tool, own
    JSON schema): `address` -> `walletAddress`, `wallet` -> `walletFamily`.
    Its args reach khalani.orders.list through the action-alias mapper;
    the builder locates that mapping and keeps the mapping correct.
  - protocols/khalani/manifest.ts:230 `khalani.orders.list` param `wallet`
    -> `walletFamily` (exampleParams and description mentions too).
  - protocols/khalani/manifest.ts:149 `khalani.tokens.balances` param
    `wallet` -> `walletFamily` (exampleParams `{ wallet: "eip155", ... }`
    and the description's "RETURNS `address`, `wallet` (the family
    scanned)" are input-key and output-key mentions to review separately:
    only the INPUT key is renamed; the output field names are frozen
    behavior and stay).
  - protocols/morpho/manifests/markets-discover.ts:79 and
    vaults-discover.ts:135 param `search` -> `query` (D1).
- Boundary seam: protocols/runtime/params.ts validateProtocolParams
  (:395-511), step 0 normalizeChainValueParams (:296-333) is the
  in-place-mutation precedent; unknown-key rejection at :405-435 names
  the BANNED_PARAM_KEYS replacement (:419).
- Schema projection: registry/khalani.ts paramsToJsonSchema (:60-88), two
  call sites (injected-protocol-tools.ts:172, khalani.ts:45).
- Fingerprint: engine/core/approval-runtime/tool-call-envelope.ts:26-37,
  203-220 (hashes key, type, required, unit, enum, acceptsStringArray,
  group fields).
- Vocabulary: protocols/conventions.ts CANONICAL_PARAM_KEYS (:54-118),
  BANNED_PARAM_KEYS (:268-297), the `query`/`cursor` withholding note
  (:216-221) that D1 overrides; parameter-vocabulary.md sections 2 and 6.
- Allowlist: protocols/_manifest-lint/allowlist.ts:188-530 (`param-key`,
  329 rows); the staleness rule (:14-15) fails a listed-but-not-violated
  entry, so ratification and renames DELETE rows in the same change.
- B1 handlers and their classes (parameter-vocabulary.md section 4):
  - trench__images_list: trench/handlers/images.ts:66-80, params `limit`
    only, has `totalAvailable`: class bounded_non_pageable -> `truncated`
    boolean plus, when true, the reason and the narrowing action (raise
    `limit` up to its maximum).
  - virtuals__genesis_launches_list: virtuals/handlers.ts:181-193, params
    `limit`, `page`, `pageSize`, reads provider `pagination.total`: class
    page_window -> `hasMore`, `nextPage` (present iff hasMore),
    `filtersApplied` (the filters that ran; if none exist, an empty
    object is honest).
  - solana__predict_events_search: solana-jupiter/handlers/predict.ts:77-104,
    params `query`, `provider`, `includeMarkets`, `limit` 1-20; the
    provider ignores `limit` and the handler slices at :103: class
    bounded_non_pageable -> `truncated` boolean, `returned`,
    `totalMatched` (rows the provider returned before the Vex-side
    slice), and when truncated the narrowing action (a more specific
    query, or a larger `limit` up to 20).
  - WalletBalances: internal/wallet/read.ts:377-405, 454-496; class
    bounded_non_pageable under `concise`+`limit`: `truncated` boolean on
    each wallet snapshot (true when the priced-row trim or the 20-row
    unpriced cap dropped rows), alongside the existing `unpricedOmitted`;
    the reason and narrowing action (raise `limit`, or `detailed`).
- Group A descriptions (fifteen tools whose handlers already emit a
  continuation signal; the description must name the field exactly as
  emitted, no new field): morpho__markets_discover, morpho__vaults_discover,
  morpho__positions_get (per-section hasMore/nextOffset),
  dexscreener__narratives_list (provenance envelope), pools__my_launches_list
  (nextCursor), ToolSearch (hasMore), TwitterAccount (`next`, "" = end),
  solana__predict_events_discover / _orders_list / _positions_list /
  _trade_history_list / _trades_list (provider `pagination {start, end,
  total, hasNext}`), virtuals__agents_discover / __graduations_list
  (`window` + `windowNote`), khalani__orders_list (`cursor` echoed).
- response_format sites: registry/long-memory.ts:121-124, 166-169,
  202-205, 228-231; registry/mission.ts:11; registry/wallet.ts:32;
  internal/long-memory/get.ts:23-36, suggest.ts:61-62, 189-190;
  memory/schema/long-memory-search.ts:36, 60; internal/long-memory/search/input.ts:38;
  internal/mission.ts:29-30, 75-80; internal/wallet/read.ts:72, 483;
  internal/twitter-account.ts:26, 32-39 (retired, rejected by name before
  the schema parse). Existing tests: wallet.test.ts:212-226,
  read-concise-unpriced.test.ts:209-222, twitter-account.test.ts:132-170.
- Lexical baseline: `pnpm test:eval:lexical` exits non-zero on ANY drift;
  `pnpm test:eval:lexical:update` recaptures. Toolsnaps:
  UPDATE_TOOLSNAPS=true regenerates; reviewed as contract diffs.

## 4. Implementation mode

(b) builder subagents (Opus 5, effort low) in parallel, three lanes on
disjoint files, after Codex GREEN LIGHT on this plan. The coordinator
reads every diff, regenerates toolsnaps and the lexical baseline once,
centrally, runs the full gate set, then dispatches the Codex final review.

## 5. Approach, by lane

### Lane 1: vocabulary (O3)

1. conventions.ts: add the 141 keys to CANONICAL_PARAM_KEYS, each with a
   one-line reason in the table's existing style; add `query` (D1,
   free-text filter; canonical sentence from parameter-vocabulary.md
   section 3, under the new name) and move `search` to BANNED_PARAM_KEYS
   with replacement `query`; keep `cursor` per D1 (ratified as the
   cursor-class continuation key, with the sentence "opaque provider
   continuation; pass back exactly what the reply returned"); correct the
   stale header "NOTHING consumes it yet" (parameter-vocabulary.md
   section 1 names it stale).
2. protocols/types.ts ProtocolParamDef: `aliases?: readonly { readonly key:
   string; readonly removeAfter: string }[]` with the doc listing its read
   sites (boundary rewrite, fingerprint, lint, never the schema).
3. runtime/params.ts: step 0b after chain normalization: for each declared
   param with aliases, if `params[alias] !== undefined`: when
   `params[key] !== undefined` reject by name ("both `wallet` and
   `walletFamily` were sent; send only `walletFamily`"); otherwise move
   the value to `key` and delete the alias, mutating in place exactly as
   normalizeChainValueParams does, so the handler, the capture row and
   every gate see the canonical spelling. Document the ordering comment
   (:340-370) with the new step.
4. registry/khalani.ts paramsToJsonSchema: never emits an alias; a test
   asserts the compiled schema of the six tools lacks the retired keys.
5. tool-call-envelope.ts: the fingerprint projection includes `aliases`
   (the header's invariant: every field normalization reads).
6. _manifest-lint: a rule that an alias must be a retired spelling (in
   BANNED_PARAM_KEYS or formerly allowlisted), must not collide with any
   declared key of the same tool, and carries a removeAfter; the existing
   `param-key` rule treats the canonical key as legal.
7. Manifests: the six renames with aliases `{ key: "wallet", removeAfter:
   "D5 owner acceptance: a stale call carrying `wallet` is answered by
   name with `walletFamily`" }` etc.; exampleParams and description
   mentions of the INPUT key updated; output field names untouched.
   BridgeStatus (internal lane): its JSON schema renames the two keys and
   the args mapper accepts the retired spellings under the same contract
   (rewrite, both-present rejection, schema shows the new key only);
   where the internal lane has no alias seam, the builder adds the
   smallest one at the mapper and says so.
8. allowlist.ts: delete the 325 ratified rows and the six rename rows;
   the file's "only allowed to shrink" note stays true.
9. Group A descriptions for the three tools whose files this lane owns
   (khalani__orders_list `cursor`; morpho__markets_discover and
   morpho__vaults_discover `hasMore`/`nextOffset`/`filtersApplied`).
10. parameter-vocabulary.md: resolve the RATIFICATION PENDING markers per
    D1, add the alias section; identity-and-migration.md gains the param
    alias removal condition cross-reference if it lists tool aliases.
11. Tests: alias accepted and rewritten (handler sees canonical key),
    both spellings rejected by name, schema omits alias, fingerprint
    changes when an alias is added, lint rule positive and negative,
    BridgeStatus mapper; the existing unknown-key tests still pass.

### Lane 2: envelope (O4)

1. The three B1 handlers outside wallet (trench images, virtuals genesis,
   solana predict events search): add the class fields from facts already
   in hand, as section 3 specifies; no provider call changes; the
   existing fields stay exactly as they are (additive only).
2. Their manifests' descriptions state the new fields and the class
   contract (for bounded_non_pageable: "truncated says rows were dropped;
   there is no continuation; narrow with ...").
3. Group A descriptions for the twelve tools not owned by lane 1 or lane
   3 (morpho__positions_get, dexscreener__narratives_list,
   pools__my_launches_list, ToolSearch, TwitterAccount, the five solana
   predict tools, virtuals__agents_discover, virtuals__graduations_list):
   name the emitted continuation field(s) exactly, including the
   end-of-list convention ("" for TwitterAccount `next`, absence for
   `nextCursor`, `hasNext` inside `pagination`).
4. Tests: boundary arithmetic for each B1 handler (exactly `limit` rows:
   truncated false; `limit` + 1: truncated true with the narrowing text;
   page_window: hasMore true with nextPage = page + 1, false on the last
   page, nextPage absent when false); existing handler tests updated
   where they `toEqual` the whole payload.

### Lane 3: response_format and WalletBalances

1. New module src/vex-agent/tools/internal/response-format.ts: the enum
   `RESPONSE_FORMATS`, type `ResponseFormat`, `responseFormatParam(defaultValue,
   whatDetailedAdds)` returning the manifest param fragment with the
   canonical sentence, `responseFormatSchema(defaultValue)` (Zod
   fragment), `readResponseFormat(params, defaultValue)` for the
   `.strict()` handlers that read it off raw params, and
   `RETIRED_RESPONSE_FORMAT_PARAM` plus `rejectRetiredResponseFormat(params)`
   preserving the twitter-account pre-schema name rejection. Four states
   documented in the module header, with the wallet_balances exception
   (D17) recorded there.
2. Every site listed in section 3 consumes the module; no default changes
   (long-memory and mission `concise`, wallet `detailed`, twitter
   retired). The manifest descriptions keep their per-tool "what detailed
   adds" prose.
3. WalletBalances `truncated` per section 3 (in internal/wallet/read.ts,
   next to `unpricedOmitted`), and registry/wallet.ts description states
   it.
4. Tests: a new case in read-concise-unpriced.test.ts: `{limit: N}` with
   no response_format returns every row, unmarked (pins R2); field-level
   deep equality between the bare default and concise-no-limit; the
   `truncated` arithmetic; twitter retired rejection unchanged
   (existing test), the module's four states; output-envelope.md section
   7.3 records R2 as resolved with the reason.

### Coordinator, after the lanes

UPDATE_TOOLSNAPS=true regeneration once; `pnpm test:eval:lexical:update`
once with the per-dataset deltas disclosed in the handoff (descriptions
changed for about 25 tools); read every diff; full gate set; Codex final
review on harness-batch4; batch4/HANDOFF.md.

## 6. Alternatives considered

- O3 rename without aliases (owner option 3): rejected by the owner; the
  boundary would answer the retired spelling by name at the cost of one
  call per stale session.
- An alias rewrite inside each handler instead of the boundary seam:
  rejected; the boundary already mutates in place for chain values and is
  the one place the capture row, the gates and the handler share.
- A `summary` envelope sweep now: deferred by D16 (naming collision with a
  provider object, fourteen `message`/`note` fields, no UI effect).
- Flipping wallet_balances to `concise` (R1): rejected by D17 (a
  money-adjacent read would start trimming on `{limit}`).

## 7. Assumptions and uncertainties

- The action-alias mapper for BridgeStatus is a small args mapping the
  builder can extend; if it turns out to be a pass-through with no seam,
  the builder stops and reports instead of inventing one.
- `filtersApplied` on virtuals genesis: if the tool has no filters, the
  field is an empty object and the description says so; the builder does
  not invent filters.
- The 141 keys to ratify are taken from the allowlist as measured; a key
  that is actually a BANNED spelling (only `wallet` and `address` were
  found) is a rename, not a ratification.
- Lexical baseline drift is expected and disclosed, not hidden.

## 8. Risks and stop conditions

- Any edit that changes a mutating tool's param keys, a handler's
  decision logic, a provider call, an approval or prequote path: stop.
- Any edit to a D9-frozen retrieval field: stop.
- Alias rewrite interacting with `additionalProperties: false` strict
  consumers: the rewrite runs before unknown-key rejection and before any
  schema consumer; a test proves the order.
- `toEqual` test churn: builders update only the assertions their fields
  touch, never weaken them to `toMatchObject` wholesale.
- Builders never run git write commands, never format unrelated files.

## 9. Verification plan

Per lane: `pnpm exec tsc --noEmit`; vitest on the touched suites;
manifest-lint; UPDATE_TOOLSNAPS only by the coordinator. Coordinator:
`pnpm exec vitest run` (whole), `pnpm build`, `pnpm test:unsafe-escapes`,
`pnpm typecheck:test:ratchet`, `git diff --check`, `pnpm check:em-dash`,
toolsnaps regenerated and read, `pnpm test:eval:lexical` after recapture,
prompt snapshots unchanged (the prompt layer is not touched; if a
description change moved a prompt byte the promptsnaps test says so).

## 10. v2 revisions after Codex plan review turn 1 (BLOCKED, all six accepted)

Where this section conflicts with sections 3, 5, 7 or 8 above, this
section wins. The "aha" evidence: approval enqueue reads the ORIGINAL
ParsedToolCall.arguments (engine/turn-loop-tool-batch.ts:260,
tools/approval-stop.ts:125), not runtime's validated copy; the Morpho and
Khalani handlers still read the retired keys (morpho/read-params/markets.ts:61,
vaults.ts:194; khalani/handlers/read.ts:104 resolveWalletFamily); default
Genesis pagination (limit 20, pageSize 100) slices 80 locally fetched rows.

R1. Readers follow the rename (lane 1 owns these files too):
    morpho/read-params/markets.ts and vaults.ts read `query`, translate it
    to the provider's `search` inside the adapter, and echo
    `filtersApplied.query` (the output key name follows the agent-facing
    key; report if any test pins `filtersApplied.search`);
    khalani/handlers/read.ts resolveWalletFamily reads `walletFamily`
    (default eip155 unchanged). Provider-side `{search: ...}` translations
    stay internal.
R2. Alias seam moves to the EARLIEST runtime boundary: immediately after
    manifest lookup, before the string-array and numeric-string coercers,
    before any preview reader and before validateProtocolParams, and it
    normalizes the ORIGINAL arguments object in place, so the approval
    enqueue (which reads ParsedToolCall.arguments) and every later reader
    see canonical keys. validateProtocolParams keeps validating canonical
    keys only. The builder names the exact function and proves the order
    with a test (an aliased call reaches the coercers, the preview
    readers, the approval envelope and the handler already canonical).
R3. BridgeStatus (internal route, tools/internal/action-aliases.ts:299,
    own Zod parse that strips unknown keys): one small normalization
    helper runs BEFORE safeParse, rewriting `{address, wallet}` to
    `{walletAddress, walletFamily}` under the same contract (both
    spellings present: rejected by name); conflict detection then runs
    on canonical keys; khalani/bridge-status-mode.ts list-only parameter
    set gains `walletFamily`.
R4. Virtuals genesis (lane 2): the handler fetches ONE provider page and
    slices it to `limit`. Additive honesty without a provider change:
    `returned`, `fetched` (rows on the provider page), `truncated` (true
    when fetched > returned) with `truncationNote` naming the recovery
    (raise `limit` up to `pageSize`, or lower `pageSize` to `limit` so a
    page maps to one reply); `hasMore` and `nextPage` only when the
    provider's pagination metadata is present (hasMore = page * pageSize
    < total; nextPage = page + 1 iff hasMore); when the provider returns
    `pagination: null`, `hasMore` is OMITTED and `continuationNote` says
    the provider gave no total and that requesting page + 1 is the way to
    check. Never claim completion from absent metadata; never change
    pageSize defaults (that would be a provider-call behavior change
    needing an owner ruling).
R5. Fingerprint (lane 1): aliases enter the projection ONLY when present,
    as the sorted list of alias KEYS (removeAfter prose is not execution
    identity); alias-free manifests stay byte-identical. Tests: alias-free
    hash stability against a pinned value, adding an alias changes the
    hash, alias declaration order does not matter. BridgeStatus has no
    manifest fingerprint and needs none.
R6. Lexical baseline (coordinator): `pnpm test:eval:lexical` BEFORE any
    update; every material per-dataset drift explained in the handoff;
    stop on unexplained degradation; update only the affected targets;
    run the full check again. Internal-tool description changes do not
    move this eval (it scores protocol manifests only).
R7. WalletBalances `truncated` (lane 3): condition is
    `trimmed.tokens.length < projected.length` (covers zero-balance
    unpriced rows the concise trim drops, the priced overflow and the
    20-row cap); the field is PRESENT as `false` on the detailed path and
    on `{limit}` without a format, never absent; `truncationNote` only
    when true.
R8. Vocabulary wording: "ratify the 141 keys, which already include
    `query` and `cursor`; remove canonical `search`; ban `search` with
    replacement `query`". Aliases must be keys of BANNED_PARAM_KEYS (the
    only durable source once the allowlist rows are deleted); the lint
    checks alias uniqueness against EVERY param key and alias of the tool.
R9. Bounded outputs standardize on `truncated` plus conditional
    `truncationNote` (the existing Pendle vocabulary); page_window on
    `hasMore` plus conditional `nextPage`.
R10. response_format module location (lane 3): not under tools/internal
    if memory/schema/long-memory-search.ts must import it (reverse
    dependency from memory into tool internals). Place it in the lowest
    existing shared layer both memory and tools already import from, and
    prove the import direction with the repository's boundary check
    (check:boundaries or the architecture gate in the test suite); report
    the chosen path.
R11. Lane ownership additions: lane 1 also owns tools/internal/action-aliases.ts
    (the BridgeStatus normalization), khalani/bridge-status-mode.ts,
    khalani/handlers/read.ts, morpho/read-params/markets.ts and vaults.ts,
    and their tests. Generated toolsnaps and every lexical baseline stay
    coordinator-only.

## 11. v3 precision after plan review turn 2 (DISCUSS, both points accepted)

R4 precision (lane 2, Virtuals genesis): `VirtualsPagination` allows each
field to be null independently (src/tools/virtuals/types.ts:98), so
"metadata present" is not enough. Sufficient metadata = `total`, `page`
and `pageSize` all finite, non-null numbers (prefer the provider's values
over the request's). Only then emit `hasMore = page * pageSize < total`
and `nextPage = page + 1` iff hasMore. Otherwise (pagination null,
all-null, or partial) OMIT both and emit `continuationNote` naming which
field was missing and that requesting page + 1 is the way to check.
Tests, owned by lane 2: sufficient metadata (hasMore true and false);
`pagination: null`; all-null pagination; partial pagination (total
present, page null; page and pageSize present, total null); within-page
truncation with and without sufficient metadata. Recovery wording uses
the handler's real bounds (MAX_LIMIT = 100, MAX_PAGE_SIZE = 200): "raise
`limit` to `pageSize` when pageSize is at most 100; otherwise lower
`pageSize` to `limit`".

R9 exception: page_window emits `hasMore` plus conditional `nextPage`
only with sufficient metadata; without it the reply carries
`continuationNote` instead. The exception is stated in the genesis
description.

R10 path (lane 3): there is no `check:boundaries` script and the existing
advisory boundary test covers memory recall only. The shared module lives
at src/vex-agent/response-format.ts (repo-level neutral seam). Evidence of
direction: import inspection (no import from tools/internal or memory
inside the module; both import it), `pnpm exec tsc --noEmit`, `pnpm
build`, and the module's focused tests. No architecture gate is claimed.

R5 test note (lane 1): every production alias is on a read tool, so the
approval-envelope alias test uses a synthetic manifest or helper fixture
to pin (a) original-arguments object identity after normalization and (b)
canonical envelope construction, without adding a production mutating
alias.
