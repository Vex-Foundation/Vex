/**
 * Deprecation-alias resolution: retired model-visible tool name to canonical
 * identity.
 *
 * THE ONE RESOLVER. A model-visible tool name is a PROJECTION of a durable
 * identity (an internal `ToolDef.name`, or a protocol manifest's immutable
 * dotted `toolId`). Renaming a projection is safe only if every boundary that
 * reads a name first maps it back to the identity it denotes. This module owns
 * that map, and it is the only place a retired name is understood.
 *
 * WHY A SINGLE DISPATCH-ENTRY CALL IS NOT ENOUGH. The turn loop hands
 * `dispatchTool` a temporary request object built from the model's tool call,
 * but it later passes the ORIGINAL `ParsedToolCall` to approval enqueue and to
 * preview construction (`engine/core/turn-loop-tool-batch.ts` :204 vs :272;
 * `turn-loop-tool-batch/approval-stop.ts` :127 preview, :189
 * `approval_queue.tool_call`). A name resolved only at dispatch would therefore
 * be stored, fingerprinted and shown to a human under its RETIRED spelling, and
 * `approval_queue.tool_call` is durable, so a cold resume in a later process
 * would replay a name the runtime no longer knows. Per the approved plan
 * section 5.5 the resolver is consequently invoked at every name-bearing
 * boundary:
 *
 *   1. dispatch entry, before every gate (`tools/dispatcher.ts`);
 *   2. approval envelope construction
 *      (`engine/core/approval-runtime/tool-call-envelope.ts`);
 *   3. approval preview construction (`engine/core/approval-intent-preview.ts`);
 *   4. cold approval resume, satisfied BY (1): the resumed dispatch re-enters
 *      through `dispatchTool` with the stored name
 *      (`approval-runtime/post-tx/dispatch-approved.ts` :302), so a row written
 *      before a rename resolves on replay. This is asserted, not assumed, by
 *      the equivalence suite;
 *   5. protocol catalog selection (`registry/injected-protocol-tools.ts`'s
 *      `resolveInjectedProtocolTool`), which is the shared name to manifest
 *      resolver that the plan-mode gate, the mutating-target classifier, the
 *      approval preview and a future ToolSearch `select:` mode all consume.
 *
 * TWO IDENTITY SPACES, TWO LOOKUPS. An INTERNAL tool has no durable id: its
 * NAME is the identity, so a retired internal name resolves to another NAME and
 * the dispatcher can route on the result. A PROTOCOL tool's identity is its
 * immutable dotted `toolId`, so a retired protocol name resolves to a TOOL ID
 * and the caller reads the manifest. The split is not cosmetic:
 *
 *   - deriving a protocol tool's canonical NAME would mean re-deriving a
 *     publicName, which is a Batch 2 projection this module must not own; and
 *   - the toolId must never be recovered by INVERTING the model-visible name.
 *     Under the target grammar (exactly one double underscore, at the namespace
 *     boundary) inversion is simply wrong: `kyberswap__swap_quote` inverts to
 *     `kyberswap.swap_quote`, while the immutable id is `kyberswap.swap.quote`.
 *     {@link resolveDeprecatedProtocolToolId} therefore returns the id the
 *     table STATES, so string inversion is never on an alias path.
 *
 * CONTRACT (both lookups).
 * - Pure and deterministic. No I/O, no logging, no clock, no import at all,
 *   which is what keeps this module free of any cycle with its callers.
 * - An UNKNOWN name passes through UNCHANGED. This module never decides that a
 *   tool does not exist; the existing unknown-tool handling in
 *   `dispatcher/protocol-route.ts` stays the sole authority on that, and keeps
 *   answering with the name the model actually wrote.
 * - Resolution is a SINGLE HOP and therefore idempotent: an alias must point
 *   directly at a canonical identity, never at another alias. Resolving an
 *   already-canonical name is the identity. Both properties are asserted by
 *   `name-resolution.test.ts`, which is what lets a boundary resolve
 *   defensively without caring whether an upstream boundary already did.
 * - An alias can never shadow a live tool: a `deprecatedName` colliding with a
 *   live internal name or a live manifest id is a test failure.
 *
 * WHAT THE TABLE HOLDS TODAY. Batch 2 renamed the 31 core internal tools to
 * PascalCase and merged the two discovery tools into `ToolSearch`, so
 * {@link DEPRECATED_TOOL_ALIASES} carries 33 `kind: "internal"` entries and
 * nothing else. Only RETIRED names are
 * enumerated: a live name resolves to itself by pass-through, and listing
 * self-referential entries for every live tool would add a second, drifting copy
 * of the catalog without changing a single result. The regression test instead
 * iterates the REAL registry and protocol catalog and asserts the identity
 * property against them.
 */

/**
 * Which identity space an alias resolves into, and therefore which removal
 * condition governs it.
 *
 * `"protocol"` carries the lighter condition: a protocol approval is
 * canonicalized into the `execute_tool {toolId, params}` envelope before
 * storage, so no stored approval row can be holding the retired name.
 * `"internal"` carries the heavier one, because an internal call is stored as
 * `{command, args}` with the NAME as its identity, so an unresolved
 * `approval_queue` row can still name the old tool.
 *
 * NEITHER is purely time-based. An enabled `session_plans.plan_md` written
 * before the rename is never rewritten and can re-emit an old spelling
 * indefinitely, so every removal condition includes a live check rather than an
 * elapsed window. See {@link DeprecatedToolAlias.removeAfter}.
 */
export type DeprecatedToolAliasKind = "internal" | "protocol";

/**
 * One retired model-visible name, and everything needed to retire it safely.
 *
 * A metadata-free `name -> name` map would satisfy none of rule 03's
 * requirements for a compatibility shim (named consumer, owner, test, removal
 * condition), which is why every entry carries its own removal condition rather
 * than the table carrying one blanket policy.
 */
export interface DeprecatedToolAlias {
  /** The retired model-visible name, exactly as a model may still emit it. */
  readonly deprecatedName: string;
  /**
   * The identity the retired name denotes: the immutable dotted `toolId` when
   * `kind` is `"protocol"`, or the current model-visible name when `kind` is
   * `"internal"`. Never another `deprecatedName` (single-hop rule).
   */
  readonly canonicalId: string;
  readonly kind: DeprecatedToolAliasKind;
  /** The release the rename landed, for the generated deprecation docs row. */
  readonly since: string;
  /**
   * The concrete, CHECKABLE condition under which this entry may be deleted,
   * as free text describing the check to evaluate.
   *
   * Deliberately NOT a date or a release deadline, and not typed as one: no
   * alias of either kind has a purely time-based removal, because an enabled
   * `session_plans.plan_md` predating the rename is never rewritten and can
   * re-emit an old spelling indefinitely. A condition such as "no enabled plan
   * predating the rename and no unresolved approval_queue row" is evaluable;
   * "after 2027-01" only looks like it is.
   */
  readonly removeAfter: string;
  /** Why the name changed, for the generated deprecation docs row. */
  readonly reason: string;
}

/** The release the Batch 2 core rename and discovery merge landed in. */
const CORE_RENAME_SINCE = "1.0.0 (tool-surface Batch 2, core PascalCase rename + ToolSearch merge)";

/**
 * The removal condition every Batch 2 core-rename alias carries.
 *
 * Owner decision D5 (`tools/tool-surface-spec/owner-decisions.md`) selects the
 * OWNER-ACCEPTANCE branch of section 3.3's governing rule rather than the
 * quiescence branch: the product is a production preview, aliases exist to keep
 * IN-FLIGHT state safe (a stored approval, the rename transition itself), not to
 * promise indefinite compatibility, and the owner accepts that a durable
 * artifact - an old enabled `session_plans.plan_md`, a memory entry, a re-read
 * transcript - may outlive the alias and receive the unknown-tool answer with
 * the discovery hint.
 *
 * The `kind: "internal"` half of the condition is still a live CHECK, not a
 * date: an internal call is stored as `{command, args}` with the NAME as its
 * identity, so an unresolved `approval_queue` row can still name the old tool
 * and a cold resume would replay it.
 */
const CORE_RENAME_REMOVE_AFTER =
  "No unresolved approval_queue row references the deprecated name and the approval "
  + "expiry window has elapsed. Residual plan / memory / transcript re-emission is "
  + "accepted by the owner (D5) rather than waited out.";

/**
 * Old core name to new core name, in `tool-surface-spec/core-naming.md` order,
 * with the per-entry `reason` the generated deprecation docs row prints.
 */
const CORE_RENAMES: readonly (readonly [string, string, string])[] = [
  // 3.2 swap and bridge action aliases
  ["swap_quote", "SwapQuote", "PascalCase Resource+Verb grammar"],
  ["swap_execute", "SwapExecute", "PascalCase Resource+Verb grammar"],
  ["swap_quote_uniswap", "SwapQuoteUniswap", "PascalCase venue-suffixed grammar"],
  ["swap_execute_uniswap", "SwapExecuteUniswap", "PascalCase venue-suffixed grammar"],
  // The one rename that fixes a MEANING defect, not only a spelling: the bare
  // `bridge` was the mutating fund-moving router while its read-only sibling
  // carried the explicit `_quote` suffix, so the SHORTER name was the DANGEROUS
  // one. `BridgeExecute` puts it in the same grammar as `SwapExecute`.
  ["bridge", "BridgeExecute", "bare `bridge` was the mutating router; the verb is now explicit"],
  ["bridge_quote", "BridgeQuote", "PascalCase Resource+Verb grammar"],
  ["bridge_status", "BridgeStatus", "PascalCase Resource+Verb grammar"],
  ["bridge_quote_relay", "BridgeQuoteRelay", "PascalCase venue-suffixed grammar"],
  ["bridge_execute_relay", "BridgeExecuteRelay", "PascalCase venue-suffixed grammar"],
  ["token_check", "TokenCheck", "PascalCase Resource+Verb grammar"],
  // 3.3 token resolution
  ["token_find", "TokenFind", "PascalCase Resource+Verb grammar"],
  // 3.4 reads, research, and wallet
  ["web_research", "WebResearch", "PascalCase Resource+Verb grammar"],
  ["twitter_account", "TwitterAccount", "PascalCase Resource+Verb grammar"],
  ["agent_scan", "AgentScan", "PascalCase; preserves the AgentScan product term"],
  ["chain_read", "ChainRead", "PascalCase Resource+Verb grammar"],
  ["wallet_balances", "WalletBalances", "PascalCase Resource+Verb grammar"],
  ["wallet_track_token", "WalletTrackToken", "PascalCase Resource+Verb grammar"],
  ["wallet_send_prepare", "WalletSendPrepare", "PascalCase Resource+Verb grammar"],
  ["wallet_send_confirm", "WalletSendConfirm", "PascalCase Resource+Verb grammar"],
  ["units_convert", "UnitsConvert", "PascalCase Resource+Verb grammar"],
  // 3.5 session and durable memory. The `long_` qualifier is DROPPED and
  // `session_` KEPT, deliberately: the durable store is always visible, so the
  // unmarked name belongs to it and the qualified name to the narrower one.
  ["session_memory_search", "SessionMemorySearch", "PascalCase Resource+Verb grammar"],
  ["session_memory_resolve_item", "SessionMemoryResolve", "PascalCase; drops the redundant `_item`"],
  ["long_memory_search", "MemorySearch", "durable memory takes the unqualified name"],
  ["long_memory_get", "MemoryGet", "durable memory takes the unqualified name"],
  ["long_memory_history", "MemoryHistory", "durable memory takes the unqualified name"],
  ["long_memory_suggest", "MemorySuggest", "durable memory takes the unqualified name"],
  // 3.6 session control
  ["compact_apply", "CompactApply", "PascalCase Resource+Verb grammar"],
  ["loop_defer", "LoopDefer", "PascalCase; keeps the prompt stack's park-the-loop word order"],
  ["mission_draft_update", "MissionDraftUpdate", "PascalCase; the write verb is load-bearing"],
  ["mission_stop", "MissionStop", "PascalCase Resource+Verb grammar"],
  ["plan_write", "PlanWrite", "PascalCase Resource+Verb grammar"],
  // 3.1 the discovery MERGE. Both retired names resolve to the same live tool,
  // which is the many-to-one case the table explicitly permits and the reason
  // nothing may invert it.
  //
  // THE ARGUMENT SHAPES DIFFER, AND THAT IS HANDLED, NOT IGNORED. An alias maps
  // a NAME; it cannot map arguments. A stale call carrying the old `toolIds` or
  // `list` argument therefore ROUTES to `ToolSearch` and is then
  // answered by name - `dispatcher/tool-search-args.ts` rejects `toolIds` and
  // `list` explicitly, naming the mode that replaced each. The alternative,
  // leaving the names unmapped, would answer the same call with the generic
  // unknown-tool line and teach the model nothing. A silent misparse is not
  // reachable: the new schema declares `additionalProperties: false` and the
  // parser reads no key it does not know.
  ["discover_tools", "ToolSearch", "merged into ToolSearch: search is now one mode of one tool"],
  ["describe_tools", "ToolSearch", "merged into ToolSearch select mode; the `toolIds` argument is retired for `select:`"],
];

/**
 * The authored alias table.
 *
 * Many-to-one is permitted (several retired names may collapse onto one
 * identity), which is exactly why NO code may invert this table to ask "what was
 * this renamed from"; anything needing that reads it forward.
 *
 * Add an entry in the SAME change that renames a tool. Delete one only when its
 * own `removeAfter` condition is met, as a reviewed change: the table shrinks by
 * deliberate edit, never by cleanup sweep.
 *
 * Batch 2 populates it with the 31 core renames of
 * `tools/tool-surface-spec/core-naming.md` section 3, plus the two entries the
 * `ToolSearch` merge adds for the retired discovery tools.
 *
 * `execute_tool` is deliberately ABSENT even though its `ToolDef` is retired.
 * It is not a renamed tool: the `{toolId, params}` envelope is still the STORED
 * form of an approved protocol call and still dispatches under that exact name
 * (`dispatcher/protocol-route.ts`), so mapping it to anything would break the
 * cold resume the retirement was required to preserve. A MODEL that emits it is
 * answered by `dispatchTool`'s refusal, which is a different mechanism with a
 * different message.
 */
export const DEPRECATED_TOOL_ALIASES: readonly DeprecatedToolAlias[] = Object.freeze(
  CORE_RENAMES.map(([deprecatedName, canonicalId, reason]) =>
    Object.freeze({
      deprecatedName,
      canonicalId,
      kind: "internal" as const,
      since: CORE_RENAME_SINCE,
      removeAfter: CORE_RENAME_REMOVE_AFTER,
      reason,
    }),
  ),
);

/**
 * Hot-path lookups, derived from the authored table.
 *
 * The authored array is the reviewable artifact; these maps exist only so a
 * per-dispatch lookup is a hash probe rather than a scan. They are rebuilt
 * whenever the fixture overlay changes, so the two can never disagree.
 */
let internalNameByDeprecated = new Map<string, string>();
let protocolToolIdByDeprecated = new Map<string, string>();

/**
 * Test-only alias overlay. Empty in production and writable ONLY through
 * {@link registerToolNameAliasesForTest}, which no production module imports
 * (asserted by a static gate in `name-resolution.test.ts`). Fixtures therefore
 * cannot ship: the authored table above is the whole production behaviour.
 */
const testAliasOverlay: DeprecatedToolAlias[] = [];

function rebuildLookups(): void {
  const internal = new Map<string, string>();
  const protocol = new Map<string, string>();
  for (const alias of [...DEPRECATED_TOOL_ALIASES, ...testAliasOverlay]) {
    if (alias.kind === "internal") internal.set(alias.deprecatedName, alias.canonicalId);
    else protocol.set(alias.deprecatedName, alias.canonicalId);
  }
  internalNameByDeprecated = internal;
  protocolToolIdByDeprecated = protocol;
}

rebuildLookups();

/**
 * Resolve a model-visible tool name to its canonical model-visible NAME.
 *
 * This is the name-space lookup: it answers for retired INTERNAL tool names,
 * whose name IS their identity and on which the dispatcher routes. A retired
 * PROTOCOL name is deliberately returned UNCHANGED here and resolves through
 * {@link resolveDeprecatedProtocolToolId} instead, because a protocol tool's
 * identity is its toolId and its canonical name is a Batch 2 projection this
 * module does not own.
 *
 * Returns `name` itself for a canonical name and for an unknown one. The caller
 * cannot distinguish the two from this result and must not try to: existence is
 * decided downstream by the registry, the protocol catalog, or the dispatcher's
 * unknown-tool answer.
 */
export function resolveToolName(name: string): string {
  return internalNameByDeprecated.get(name) ?? name;
}

/**
 * Resolve a retired PROTOCOL name to the immutable dotted `toolId` it denotes,
 * or `undefined` when the name is not a retired protocol name.
 *
 * The id comes from the table, never from inverting the name. That is the whole
 * point of this function: under the target grammar the model-visible name is not
 * invertible into a toolId (see the module header), so an alias path that
 * inverted strings would resolve a fund-moving call onto a DIFFERENT tool, or
 * onto none at all.
 *
 * `undefined` means "no alias entry", not "no such tool". Callers fall back to
 * their existing canonical lookup.
 */
export function resolveDeprecatedProtocolToolId(name: string): string | undefined {
  return protocolToolIdByDeprecated.get(name);
}

/**
 * Register fixture aliases for one test and return the disposer that removes
 * exactly the entries it added. Registration is additive and scoped, so a test
 * that forgets the disposer cannot silently widen another test's table beyond
 * its own entries, and this function is never reachable from production code.
 */
export function registerToolNameAliasesForTest(
  entries: readonly DeprecatedToolAlias[],
): () => void {
  testAliasOverlay.push(...entries);
  rebuildLookups();
  return () => {
    for (const entry of entries) {
      const index = testAliasOverlay.indexOf(entry);
      if (index !== -1) testAliasOverlay.splice(index, 1);
    }
    rebuildLookups();
  };
}

/** Drop every fixture alias. For a suite-level `afterEach` safety net. */
export function resetToolNameAliasesForTest(): void {
  testAliasOverlay.length = 0;
  rebuildLookups();
}
