# Tool contract snapshots

Reviewed contract artifacts, one JSON file per registered tool plus one ordered
catalog file. They pin the FINAL model-visible tool contract: what the provider
actually receives, after every projection step, not what a manifest was authored
to say.

These files are generated output committed as reviewed contract artifacts
(rules/03). Never hand-edit one. A diff here is a change to what the model sees,
and it is reviewed as such.

## Generator and regeneration

- Generator: `src/__tests__/vex-agent/tools/toolsnaps.test.ts` with
  `src/__tests__/vex-agent/tools/toolsnaps/build-contracts.ts` (projection) and
  `.../toolsnaps/snapshot-file.ts` (serialization and comparison).
- Validate: `pnpm exec vitest run src/__tests__/vex-agent/tools/toolsnaps.test.ts`
- Regenerate:
  `UPDATE_TOOLSNAPS=true pnpm exec vitest run src/__tests__/vex-agent/tools/toolsnaps.test.ts`

Without the flag the suite fails when a snapshot is MISSING, when it MISMATCHES,
and when an ORPHANED file exists for a tool that is no longer in the catalog.
Regeneration never deletes an orphan: an orphan may be a rename in progress, so
removal stays a deliberate act by the author of the contract change.

## Pipeline captured

- internal tool: `registry/openai-tools.ts` -> `toOpenAITools` ->
  `inference/schema-normalizer.ts` -> `normalizeToolSchemaForProvider`.
- protocol tool: `registry/injected-protocol-tools.ts` ->
  `buildInjectedProtocolTools` (which APPENDS cross-parameter group constraint
  sentences to the manifest description) -> the same normalizer.

## File naming

The basename is the tool's stable identity:

- internal tools: the tool name verbatim, e.g. `wallet_send_confirm.json`;
- protocol tools: the dotted `toolId` with `.` replaced by `__`, e.g.
  `kyberswap.swap.quote` -> `kyberswap__swap__quote.json`.

`__` is chosen because production already uses exactly this mapping to build the
model-visible injected function name, and it is asserted bijective over the whole
catalog by `injected-protocol-tools.test.ts`. So a snapshot filename is the name
the model calls, which keeps a filesystem listing readable as the tool surface.

`_catalog.json` is underscore-prefixed and the harness asserts no tool key
collides with it.

## File contents

Every file has two top-level parts.

- `definition`: the final normalized provider tool definition. `null` for a
  manifest the injection pipeline never emits, which today is only the two
  `uniswap.*` manifests: their namespace is not advertised, so they have no
  model-visible definition at all. Recording `null` is the honest answer;
  fabricating a definition would snapshot a contract the model never sees.
- `metadata`: per-kind fields only, never invented.
  - internal: `kind`, `mutating`, `pressureSafety`, `actionKind`, `withheld`
    (absent from the baseline scenario), `withheldFromModelSurface` (absent from
    BOTH mission-axis scenarios with every other gate satisfied, which is what
    the hard-coded model-withheld name set produces), and `gates`:
    `proactive`, `requiresEnv`, `showOnlyWhenEnvMissing`, `declaredVisibility`
    (the `ToolDef.visibility` axes verbatim) and `measured`.
  - protocol: `kind`, `toolId`, `namespace`, `mutating`, `actionKind`,
    `advertised`, `lifecycle`, `requiresEnv`. The last two are the two halves of
    `isProtocolToolAvailable`, so an env-gated manifest such as
    `solana.swap.execute` records `JUPITER_API_KEY` explicitly. Protocol
    manifests carry NO `pressureSafety` field, so none is recorded for them.

### Measured gates

`gates.measured` exists because two gates have NO declaration to read: the Relay
alias pair is filtered by a hard-coded name set in `registry/relay-reveal.ts`,
and the model-withheld list is another hard-coded set inside
`registry/visibility.ts`. Each boolean is an observation, not a copy of a field:
the tool's presence in `getVisibleToolDefs` under the baseline is compared
against a scenario that drops exactly one axis.

- `hiddenWithoutUniswapReveal`, `hiddenWithoutDescribeToolsReveal`,
  `hiddenWithoutRelayRouteReveal`: the session-scoped reveals.
- `hiddenWithoutEnvGates`: every derived `requiresEnv` variable removed.
- `visibleInMissionSetup`: the same session with `missionRunActive: false`.

Deleting any of those gates flips a recorded boolean and fails the snapshot,
which is the only way an undeclared gate can be defended.

`_catalog.json` holds the scenario label, `internalVisibleOrder` (the order the
model sees the internal block in, which is contract), the registered internal
count, `requiresEnvGates` (derived from the live registry and manifests, so a
new env gate anywhere shows up as a catalog diff), `maxDiscoveredToolsPerSession`
and `maxSimultaneousModelVisibleTools`, and the sorted protocol `toolId` list.

## Worst-case tool count

`toolsnaps.test.ts` pins the maximum number of functions one request can carry:
32 internal tools visible under the baseline scenario plus
`MAX_DISCOVERED_TOOLS_PER_SESSION` injected protocol tools = 72. Both operands
are measured, the cap is bound to the production constant, so raising the cap
moves the assertion instead of leaving a stale number in a document.

## Comparison semantics

Object keys are sorted recursively on write, purely so the bytes are stable.
ARRAY ORDER IS PRESERVED and compared positionally. This is a deliberate
divergence from `github-mcp-server`'s `toolsnaps`, which compares with `jd.SET`
and therefore ignores array order: in Vex, enum and property order travel into
approval fingerprints (`engine/core/approval-runtime/tool-call-envelope.ts`), so
a reordered `enum` is a real contract change and must fail.

## The snapshot scenario

Definitions must be deterministic, so they are projected under ONE baseline
context, built in `build-contracts.ts`:

- mission session with an ACTIVE run, `permission: "full"`, plan mode on,
  session memory present, a prepared compaction summary ready;
- `contextUsageBand: "normal"`, so no pressure-safety drop applies;
- the three session-scoped reveals granted to the scenario session: the hidden
  Uniswap pair, `describe_tools`, and one Relay route;
- every `requiresEnv` variable the LIVE catalogs declare, collected from
  `ToolDef.requiresEnv` and `ProtocolToolManifest.requiresEnv` on every run and
  never hand-listed, set to a dummy value for the duration of the build and
  restored afterwards. No credential is read and none is ever written into a
  snapshot. An env var that is both a `requiresEnv` gate and a
  `showOnlyWhenEnvMissing` gate would make "open all gates" self-contradictory,
  so the builder throws rather than silently picking a side.

No context can be maximal on every axis: `requiresMissionSetup` and
`requiresMissionRun` are mutually exclusive. The baseline picks the active run,
so `mission_draft_update` is invisible under it, as is the model-withheld
`execute_tool`. Both still get a snapshot, with `metadata.withheld: true`:
withholding is a visibility decision, not a change to the contract. The two are
told apart by `withheldFromModelSurface`, which is true only for
`execute_tool`, because it stays invisible on both mission axes.

Five further scenarios exist only to MEASURE gates, never to project a
definition. Each drops exactly one axis from the baseline: no Uniswap reveal, no
`describe_tools` reveal, no Relay route reveal, no env gates, and mission setup
instead of an active run. Reveals are session-scoped, so each scenario uses its
own session id and the harness clears them on teardown.

Protocol tools are injected in batches of `MAX_DISCOVERED_TOOLS_PER_SESSION`
(40) under throwaway session ids, because a session's discovered set is capped
at 40 by design. Batching cannot change a definition: injection reads only the
manifest and the per-session gates.

Nothing environment-dependent or time-dependent reaches a snapshot.
