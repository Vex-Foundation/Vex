/**
 * Protocol tool types — manifest-driven discover+execute system.
 *
 * Each protocol (khalani, kyberswap, solana, ...) provides:
 * 1. Manifests — declarative tool metadata (params, mutating, description)
 * 2. Handlers — async functions that call TS clients directly
 *
 * The LLM interacts via two meta-tools:
 * - discover_tools → search manifests by query/namespace
 * - execute_tool → call handler by toolId with params
 */

import type { ToolResult } from "../types.js";
import type { ActionKind } from "../taxonomy.js";
import type { Permission, WalletPolicy } from "@vex-agent/engine/types.js";
import type { WalletResolution } from "@tools/wallet/multi-auth.js";

// ── Protocol namespaces ──────────────────────────────────────────

export type ProtocolNamespace =
  | "khalani"
  | "kyberswap"
  | "uniswap"
  | "relay"
  | "solana"
  | "dexscreener"
  | "lighter"
  | "virtuals"
  | "pendle"
  | "trench";

/**
 * Lifecycle state of a protocol manifest.
 *
 * Post-PR1 only `"active"` is inhabited. The previous `"declared"` variant
 * was zero-ref in the repo (no manifest used it) and has been removed from
 * the union — follow-up manifests that need a "declared but not yet
 * executable" state should add a new variant here *and* provide at least
 * one real manifest plus matching discovery / runtime behaviour.
 */
export type ToolLifecycle = "active";

// ── Discovery metadata (optional per-tool enrichment) ───────────

export interface ToolDiscoveryMetadata {
  canonicalSummary?: string;
  /** Retrieval-only semantic text embedded for dense tool discovery. */
  embeddingText?: string;
  aliases?: string[];
  exampleIntents?: string[];
  paramKeywords?: string[];
  operation?: ("research" | "verify" | "quote" | "execute" | "monitor")[];
  resourceTypes?: string[];
  ecosystems?: string[];
  sourceClass?: "specialized_market" | "general_web" | "social" | "protocol_native" | "onchain_verification";
  sideEffectLevel?: "none" | "low" | "high";
  /**
   * Chains where this tool operates — used as a low-weight lexical search
   * field so queries like "swap on plasma" or "bridge to monad" recall the
   * right tool even when the chain is not enumerated in the description or
   * embedding text.
   */
  chains?: readonly string[];
}

// ── Manifest (declarative tool definition) ───────────────────────

export interface ProtocolParamDef {
  key: string;
  type: "string" | "number" | "boolean" | "object";
  required?: boolean;
  description: string;
  /**
   * Domain unit of a NUMERIC param, when the bare `type` is too weak to
   * express the contract. Only meaningful on `type: "number"`.
   *
   * `"bps"` — basis points: a WHOLE, non-negative number (1 bps = 0.01%).
   * Enforced at the manifest boundary by `runtime/bps-param.ts`, called from
   * `validateProtocolParams`. This exists because `z.number()` happily accepts
   * `0.5`, and a fractional bps is not a smaller tolerance — Jupiter answers a
   * non-integer `slippageBps` with `otherAmountThreshold = 0`, i.e. a swap that
   * accepts ANY output including near-zero. The failure is silent: the quote
   * looks normal. Declare this on EVERY basis-point param so a model-supplied
   * `0.5` is rejected before it can reach a provider or a signing path.
   *
   * Single-member union on purpose (same convention as {@link ToolLifecycle}):
   * a second unit must be added here deliberately, with its own enforcement.
   */
  unit?: "bps";
  /**
   * OPT-IN: this `type: "string"` param also accepts an ARRAY of strings.
   *
   * Declare it on params that are semantically a LIST spelled as a
   * comma-separated string (`chainIds`, `dexIds`, `labels`, `tokenAddresses`).
   * Measured in the persona gate (`call-records.json`, first record):
   * `dexscreener.profiles {chainIds: ["solana"]}` was rejected in 78 bytes while
   * `chainIds: "solana"` answered in 5,215 — a whole call spent on a spelling a
   * JSON tool call makes natural.
   *
   * Deliberately per-param rather than blanket: a param that means exactly ONE
   * value (`query`, `slug`, `chainId`, `tokenAddress`) must keep rejecting an
   * array, because there its list form is a mistake, not a convenience.
   *
   * The flag is read in two places and nowhere else: `runtime/params.ts` widens
   * the boundary check to a validated `string[]`, and the ProtocolParamDef →
   * JSON-schema compiler emits an `anyOf` union. `type` STAYS `"string"` — this
   * is a capability, not a second type.
   */
  acceptsStringArray?: true;
  /**
   * The CLOSED set of values this param accepts, when prose was the only place
   * the set existed. `virtuals.list.chain` is the live case: an UPPERCASE value
   * list written in a description, unenforced at the boundary, and absent from
   * the compiled JSON schema — so a model that followed every other chain param
   * in the tree sent `base` and burnt the call.
   *
   * Read in exactly three places: `runtime/params.ts` rejects an off-list value
   * NAMING the allowed values, `paramsToJsonSchema` compiles it into the JSON
   * Schema `enum` keyword, and `discovery.ts` ships it on the param row. Values
   * are matched EXACTLY (case-sensitive) — a provider that wants a different
   * casing converts inside its own adapter (see `conventions.ts`).
   *
   * ONE deliberate exception: a param whose key is in `CHAIN_VALUE_PARAM_KEYS`
   * matches CASE-INSENSITIVELY and is rewritten to the declared spelling,
   * for the same reason the chain number→string normalization exists — every
   * other chain param in the tree advertises a lowercase slug, so
   * `virtuals.list`'s UPPERCASE list burnt calls from models that had read
   * forty manifests spelling it the other way. Case is not a distinction a
   * chain value carries; on any other param it can be, so nothing else folds.
   *
   * Only meaningful on `type: "string"`. On a param that also declares
   * {@link ProtocolParamDef.acceptsStringArray}, EVERY member must be on the list.
   */
  enum?: readonly string[];
}

export interface ProtocolToolManifest {
  /** Canonical tool ID, e.g. "khalani.bridge" */
  toolId: string;
  /** Protocol namespace */
  namespace: ProtocolNamespace;
  /** Lifecycle state — see {@link ToolLifecycle}. */
  lifecycle: ToolLifecycle;
  /** Human-readable description for LLM */
  description: string;
  /** Whether this tool modifies state */
  mutating: boolean;
  /**
   * Action taxonomy — explicit side-effect classification (see `../taxonomy.ts`).
   * REQUIRED — every protocol tool MUST be deliberately classified. Mirrors
   * the `ToolDef.actionKind` invariant; the compiler enforces classification
   * at registration time so puzzle 5 phase 2+ (approval intents, audit) can
   * make policy decisions from a stable per-manifest classifier.
   *
   * Read by `executeProtocolTool` in `./runtime.ts` and stamped on every
   * known-manifest return path of `ToolResult.actionKind`. The wrapper
   * overrides to `"read"` when `isPreviewExecution(...)` is true (preview /
   * dryRun is read-only simulation regardless of mutating intent).
   */
  actionKind: ActionKind;
  /** Parameter definitions */
  params: ProtocolParamDef[];
  /** Example params for LLM guidance */
  exampleParams: Record<string, unknown>;
  /** ENV var required for this tool. If set and ENV is empty, tool is hidden from discovery and blocked in execute. */
  requiresEnv?: string;
  /**
   * Mutually exclusive param sets: EXACTLY ONE member of each group must be
   * present in a call. Retires the 15+ hand-written prose XOR sentences and
   * their hand-written handler checks (SPEC §1.7) — including
   * `borrowOperate`'s same-direction ban, which is documented nowhere today.
   *
   * Enforced once, at the boundary, by `runtime/params.ts`, and rendered as a
   * `constraints` row by `discovery.ts` so the rule is a schema fact before the
   * call rather than an error after it.
   *
   * EXACTLY one, not at-most one: a group whose members may legitimately ALL be
   * absent is not an exclusive group and must not be declared here — express
   * that with `required` on nothing and a sentence in the params' own
   * descriptions. Members must be declared params of this manifest
   * (`_manifest-lint.ts` territory).
   */
  exclusiveParamGroups?: readonly (readonly string[])[];
  /**
   * AT MOST ONE member of each group may be present — zero is legal.
   *
   * The weaker sibling of {@link ProtocolToolManifest.exclusiveParamGroups},
   * and the shape most real multi-leg tools actually have.
   * `solana.lend.borrowOperate` is the case that forced it: its collateral leg
   * (`depositAmountRaw|withdrawAmountRaw|withdrawAll`) and its debt leg
   * (`borrowAmountRaw|repayAmountRaw|repayAll`) each accept at most one member,
   * but a call that adjusts only collateral legitimately sets NONE of the debt
   * params. Declaring those as exactly-one groups would reject every legal
   * single-leg call, which is why six prose-only "mutually exclusive" sentences
   * sat unenforced in the allowlist until this field existed.
   *
   * Combine with {@link ProtocolToolManifest.atLeastOneOf} to express
   * "at most one per leg, and at least one leg overall" — the two fields
   * together are what `exclusiveParamGroups` cannot say.
   *
   * A group may also encode a CROSS-leg ban: borrowOperate's two direction
   * groups (`depositAmountRaw|repayAmountRaw|repayAll` = money in,
   * `withdrawAmountRaw|withdrawAll|borrowAmountRaw` = money out) are exactly
   * the handler's same-direction refusal, expressed as a schema fact the model
   * reads BEFORE the call instead of an error after it.
   *
   * Enforced by `runtime/params.ts`, rendered into the discovery `constraints`
   * row and the injected function description, and required as the backing for
   * any "at most one of …" prose by `_manifest-lint`. Members must be declared
   * params of this manifest.
   */
  atMostOne?: readonly (readonly string[])[];
  /**
   * AT LEAST ONE member of each group must be present — two or more is legal.
   *
   * The complement of {@link ProtocolToolManifest.atMostOne}: it forbids the
   * EMPTY call for a tool whose params are individually optional. Without it
   * "nothing to do" is a handler-side refusal discovered after the model has
   * already spent a call; with it, the rule is a schema fact and a boundary
   * rejection that names every acceptable key.
   *
   * `required: true` on any single param cannot express this — the point is
   * that any ONE of several alternatives suffices.
   *
   * Same six surfaces as {@link ProtocolToolManifest.atMostOne}.
   */
  atLeastOneOf?: readonly (readonly string[])[];
  /** Optional discovery metadata for improved retrieval — filled incrementally per tool. */
  discovery?: ToolDiscoveryMetadata;
}

// ── Protocol handler (what executes the tool) ────────────────────

export type ProtocolHandler = (
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
) => Promise<ToolResult>;

export interface ProtocolExecutionContext {
  /**
   * Session permission, hydrated once at engine entry from `sessions.permission`.
   * Approval gate in `tools/protocols/runtime.ts` reads this to decide whether
   * a mutating tool needs enqueue or auto-executes.
   */
  sessionPermission: Permission;
  approved: boolean;
  /**
   * Per-session wallet resolution + policy (puzzle 5 phase 5B). Threaded from
   * the dispatcher so the runtime can hard-deny un-migrated wallet-signing
   * protocol tools under a session scope, and migrated address-only reads
   * (khalani) resolve the session's selected wallet instead of the primary.
   */
  walletResolution: WalletResolution;
  walletPolicy: WalletPolicy;
  /** Session ID — passed to execution capture for audit trail */
  sessionId?: string;
  /**
   * TRUSTED PROVENANCE (C0). Threaded by the dispatcher from
   * `InternalToolContext`; a handler can never derive these from model input,
   * which is exactly why they are here — an authorization record that binds
   * "which mission / which approval authorized this spend" must be built from
   * host-side evidence.
   *
   * `missionId` / `missionRunId`: set for a dispatch inside a mission. The
   * `full_autonomy` authorization variant binds them as its provenance.
   *
   * `approvalId`: set ONLY on the cold approval-resume path, where the user
   * resolved an approval card. The `approval_card` variant binds it.
   *
   * All three are OPTIONAL because legacy dispatch paths (chat, maintenance,
   * previews) genuinely have no mission or approval to name; `undefined` and
   * `null` both mean absent. A path that REQUIRES provenance must not read
   * these directly — call `requireExecutionProvenance` from
   * `./execution-provenance.js`, which refuses by name instead of silently
   * authorizing an unbound spend.
   */
  missionId?: string | null;
  missionRunId?: string | null;
  approvalId?: string | null;
  /**
   * The provider's id for THIS tool call, threaded by the dispatcher from
   * `ToolCallRequest.toolCallId`. Host-side evidence like the provenance above:
   * a model-supplied id could park a form whose result answers a DIFFERENT call.
   *
   * Only a handler that must ANSWER ITS OWN CALL LATER needs it —
   * `trench.launch_request_form` parks the turn on §C3b and the eventual result
   * must address exactly this call, or the turn can never close. Optional
   * because dispatch paths that were never a model tool call (previews,
   * maintenance, internal resumes) genuinely have none; a handler that requires
   * it refuses by name rather than parking a turn nothing can answer.
   */
  toolCallId?: string | null;
  /**
   * Context-usage band at dispatch time, threaded through from the
   * dispatcher so the protocol-runtime pressure guard can reject mutating
   * protocol calls at barrier/critical even when discovery doesn't carry
   * the advisory flag. Optional for legacy callers; PR2 dispatcher always
   * passes it.
   */
  contextUsageBand?: "normal" | "warning" | "barrier" | "critical";
  /**
   * True iff a live compaction preparation suppresses the `barrier` mutating
   * block for this turn (contract C8). The protocol runtime is the THIRD gate
   * layer (after the catalog filter and the dispatcher hard-deny) and must
   * agree with both, or a mutating protocol call is offered and then refused.
   * Absent ⇒ false ⇒ today's barrier.
   */
  preparationBypassesBarrier?: boolean;
  /**
   * Operator Stop for the turn that owns this dispatch, threaded verbatim from
   * `InternalToolContext.abortSignal` — see that field's doc for the full
   * contract, the never-interrupt clause, and the list of producers that
   * deliberately leave it unset.
   *
   * In one line: a protocol handler passes it to every read, poll, sleep, and
   * quota wait, and MUST NOT observe it inside a sign→broadcast→persist window.
   */
  abortSignal?: AbortSignal;
}

// ── Execute request ──────────────────────────────────────────────

export interface ProtocolExecuteRequest {
  toolId: string;
  params: Record<string, unknown>;
}

// ── Coverage matrix types ───────────────────────────────────────
//
// `CaptureKind` (the coarse capture-semantics classification — trade/
// projection/audit/utility) lives in `mutation-matrix.ts`, the matrix's own
// module, now that the PnL role split (pnl_spot/pnl_perps/pnl_prediction) and
// the valuation tri-state are gone (Agent Scan plan §4.3/§11.4).

/** Whether handler produces _tradeCapture today. */
export type CaptureSupport = "full" | "none";

// ── Discovery request/result ─────────────────────────────────────
//
// Split into `./types/discovery.ts` when this file crossed the 550-line hard
// limit (rules/04, owner decree 2026-07-28). Re-exported here so this module
// stays the single public entry point for the protocol contracts and no
// caller's import changed.

export type {
  ManifestRow,
  ProtocolDiscoveryItem,
  ProtocolDiscoveryListItem,
  ProtocolDiscoveryModelResult,
  ProtocolDiscoveryModelRetrievalMeta,
  ProtocolDiscoveryRequest,
  ProtocolDiscoveryResult,
  ProtocolDiscoveryRetrievalMeta,
  ProtocolManifestResult,
} from "./types/discovery.js";
