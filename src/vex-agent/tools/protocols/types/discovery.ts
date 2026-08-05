/**
 * Protocol discovery contracts — the request, the two row shapes, the retrieval
 * metadata, and the two result envelopes (`discover_tools` and
 * `describe_tools`).
 *
 * Split out of `../types.ts` when it crossed the 550-line hard limit
 * (rules/04, owner decree 2026-07-28). MOVE-ONLY: every declaration below is
 * byte-identical to its previous form, and `../types.ts` re-exports all of them,
 * so no caller's import changed.
 */

import type { ActionKind } from "../../taxonomy.js";
import type { ContextUsageBand } from "@vex-agent/engine/core/context-band.js";
import type { ProtocolNamespace, ProtocolParamDef } from "../types.js";


export interface ProtocolDiscoveryRequest {
  query?: string;
  namespace?: string;
  limit?: number;
  /**
   * Context-pressure band at dispatch time (threaded by the dispatcher).
   * When `barrier` or `critical`, the assembly flags `mutating` tools with
   * `unavailable_at_pressure: true` so the LLM sees the advisory before
   * even attempting `execute_tool` — soft companion to dispatcher hard-deny
   * + Tool Map omission already in force at the same bands.
   */
  contextUsageBand?: "normal" | "warning" | "barrier" | "critical";
  /**
   * Session id at dispatch time (FIX-SPINE round 1, finding 8/C3) — lets
   * `discoverProtocolCapabilities` filter the canonical hidden Uniswap swap
   * manifests out of the result set for a session that has not revealed
   * them, so discovery never advertises a tool `executeProtocolTool` would
   * then hard-reject. Omitted/undefined fails closed (hidden).
   */
  sessionId?: string;
  /**
   * True iff a live compaction preparation suppresses the `barrier` mutating
   * block for this turn (contract C8). While true, discovery must NOT tag
   * mutating rows `unavailable_at_pressure` at `barrier` — the dispatcher will
   * in fact allow them, and an advisory that contradicts the gate is worse than
   * no advisory. `critical` still tags. Absent ⇒ false ⇒ today's tagging.
   */
  preparationBypassesBarrier?: boolean;
  /**
   * Namespace list mode. When true, `namespace` is REQUIRED and the response is
   * the COMPLETE set of that protocol's advertised, available tools as lean
   * rows ({@link ProtocolDiscoveryListItem} — no param schemas, no scores) with
   * no ranking and no `limit` truncation. Without a namespace the request fails:
   * dumping every namespace as one payload is forbidden.
   */
  list?: boolean;
}

/**
 * The COMPLETE model-facing manifest projection — a ranked discovery row minus
 * its ranking-only evidence.
 *
 * One builder produces it for both consumers (`toManifestRow` in
 * `./discovery.ts`): ranked discovery spreads it and adds `score`/`whyMatched`,
 * and `describe_tools` returns it verbatim. That single origin is the property
 * owner directive D3 turns on — a tool reached by `list → describe_tools` must
 * be INDISTINGUISHABLE from the same tool reached by ranked discovery, because
 * since full-manifest injection the live agent has produced zero
 * invalid-parameter calls and a second, lighter row builder would silently
 * degrade it.
 *
 * It is a PROJECTION, not a verbatim {@link ProtocolToolManifest}: `lifecycle`,
 * `requiresEnv` and the discovery metadata are internal and never returned.
 */
export type ManifestRow = Omit<ProtocolDiscoveryItem, "score" | "whyMatched">;

export interface ProtocolDiscoveryItem {
  toolId: string;
  namespace: ProtocolNamespace;
  description: string;
  mutating: boolean;
  /**
   * The manifest's own side-effect classification. `mutating` alone reads as
   * "will spend funds" — `trench.launch_request_form` is `mutating: true` and
   * spends nothing, which is a discovery-schema gap, not a trench bug.
   */
  actionKind: ActionKind;
  params: ProtocolParamDef[];
  /**
   * The required param keys, restated as a list. `params[i].required` is one
   * boolean on object #1 of 37 and optional params carry no marker at all; a
   * ~20-byte restatement is the one form of this fact no skim can miss.
   */
  required: string[];
  /**
   * The manifest's authored worked call. It exists on every manifest, is
   * correct, and was dropped from this row until W7 — `dexscreener.search`'s is
   * exactly the call whose absence produced the live
   * `missing required parameter query` failure.
   */
  exampleParams: Record<string, unknown>;
  /**
   * Rendered cross-param group rules — one sentence per declared group, across
   * {@link ProtocolToolManifest.exclusiveParamGroups},
   * {@link ProtocolToolManifest.atMostOne}, and
   * {@link ProtocolToolManifest.atLeastOneOf}, in that order. Only present when
   * the manifest declares at least one group, so a tool without them pays
   * nothing. Word-for-word the sentence the runtime rejects with.
   */
  constraints?: string[];
  /** Retrieval score for this match (0 when no query, >0 for ranked matches). */
  score: number;
  /**
   * Field tags that contributed to the score, e.g. ["description", "params", "navigation"].
   * Useful for the LLM to disambiguate between similarly-scored shortlists.
   */
  whyMatched: string[];
  /**
   * Only present and `true` when the current context-usage band is `barrier`
   * or `critical` AND this tool is `mutating: true` AND no live compaction
   * preparation is suppressing the barrier. Tells the LLM the dispatcher will
   * hard-deny `execute_tool` for this row right now — stick to read-only /
   * preview variants in the same namespace while the runtime compacts. Omitted
   * on read-only tools, at normal/warning bands, and while the barrier is
   * bypassed, to keep payloads minimal.
   */
  unavailable_at_pressure?: boolean;
  /** Exclusive-union marker: `requiredParams` is the LIST row's spelling. */
  requiredParams?: never;
}

/**
 * Lean row emitted by namespace list mode (`list: true` + `namespace`). It
 * deliberately carries NO `params`, `score`, or `whyMatched`: the point of a
 * list is a complete, cheap index of what a protocol can do. The model follows
 * up with a query or the exact toolId to get the param schema it builds the
 * call from. Distinguished on the wire by `retrieval.method === "list"`.
 */
export interface ProtocolDiscoveryListItem {
  toolId: string;
  mutating: boolean;
  /** Same reason as the ranked row: `mutating` alone over-reads as "spends". */
  actionKind: ActionKind;
  description: string;
  /**
   * Required param KEYS only — never the full schema. A listing exists to be
   * cheap over a whole namespace, and a half-schema in a listing is the worst
   * of both worlds (`reports/model-research.md` §4.1: a discovered tool must be
   * re-materialized as a full definition before the call). The measured harm
   * this fixes is the agent that listed, then executed, having never seen which
   * keys were mandatory.
   */
  requiredParams: string[];
  /**
   * Exclusive-union markers: a list row NEVER carries the ranked item's fields.
   * Declaring them `never` keeps `tools` readable without a narrowing dance —
   * `item.params` types as `… | undefined` — while making an accidental
   * assignment a compile error.
   */
  namespace?: never;
  params?: never;
  required?: never;
  exampleParams?: never;
  constraints?: never;
  score?: never;
  whyMatched?: never;
  unavailable_at_pressure?: never;
}

/**
 * Retrieval metadata attached to a discovery result. Surfaces whether the
 * response was an unranked catalog listing, dense-ranked, or lexical fallback,
 * plus audit columns of the embedding used. The `embeddingModel`/`embeddingDim`
 * columns are internal retrieval mechanics consumed ONLY by telemetry — they
 * are stripped from the model-facing copy (see {@link ProtocolDiscoveryModelRetrievalMeta}
 * and the dispatcher's `toModelDiscoveryResult`). The model uses `method` and
 * `denseFailed` to interpret weak matches (lexical fallback often signals
 * embedding-sidecar issues, not query problems).
 */
export interface ProtocolDiscoveryRetrievalMeta {
  method: "catalog" | "dense" | "lexical" | "list";
  /** True when dense retrieval was attempted but lexical fallback produced the result. */
  denseFailed: boolean;
  /** Provider-reported embedding model (only set when dense retrieval ran). Telemetry-only. */
  embeddingModel?: string;
  /** Provider-reported embedding dim (only set when dense retrieval ran). Telemetry-only. */
  embeddingDim?: number;
  /** Number of candidates before scoring (post env/advertised/lifecycle filters). */
  candidateCount: number;
}

/**
 * Model-facing projection of {@link ProtocolDiscoveryRetrievalMeta}: the same
 * shape minus the telemetry-only `embeddingModel`/`embeddingDim` mechanics.
 * Built by the dispatcher's `toModelDiscoveryResult` for serialization into the
 * `discover_tools` output string; the full meta stays on the result object for
 * telemetry/logging.
 */
export type ProtocolDiscoveryModelRetrievalMeta = Omit<
  ProtocolDiscoveryRetrievalMeta,
  "embeddingModel" | "embeddingDim"
>;

/**
 * `describe_tools` result. Deliberately NOT the discovery union: nothing was
 * retrieved or ranked, so `score`/`whyMatched`/`retrieval` would be meaningless,
 * and there is no superset and no pagination, so `count` is the whole truth.
 */
export interface ProtocolManifestResult {
  /** False ONLY when nothing resolved — a partial batch is a success with named losses. */
  success: boolean;
  count: number;
  tools: ManifestRow[];
  /**
   * One sentence per rejected toolId, naming the REAL cause (env var NAMES
   * only), plus one naming every id this call displaced from an earlier round.
   * Empty when everything resolved and nothing was evicted.
   */
  warnings: string[];
  /**
   * Injection capacity, surfaced rather than discovered by a tool going missing
   * (owner directive D1). `used` counts this session's recorded toolIds AFTER
   * this call; `max` is `MAX_DISCOVERED_TOOLS_PER_SESSION`.
   */
  sessionCapacity: { used: number; max: number };
}

export interface ProtocolDiscoveryResult {
  /**
   * Model-facing next-step pointer, present ONLY on a NON-EMPTY list-mode
   * result and serialized as the FIRST key of the envelope (owner directive D2:
   * "na samej górze każdego listowania"). Names the manifest tool, its bound,
   * and an example built from the FIRST returned toolId so the example is always
   * concretely correct.
   *
   * Deliberately not a `warning`: `warnings` means something is wrong with the
   * answer and the model is taught to read it that way. Guidance is not a
   * problem.
   */
  nextStep?: string;
  success: boolean;
  /** Number of tools returned in this response (after limit is applied). */
  count: number;
  /** Total number of matching tools before pagination/limit is applied. */
  totalCount: number;
  /** True when additional matching tools exist beyond this response. */
  hasMore: boolean;
  /**
   * Ranked/catalog rows, or lean {@link ProtocolDiscoveryListItem} rows when
   * `retrieval.method === "list"`. Narrow before reading `params`/`score`.
   */
  tools: (ProtocolDiscoveryItem | ProtocolDiscoveryListItem)[];
  warnings: string[];
  /** Optional retrieval metadata for telemetry. */
  retrieval?: ProtocolDiscoveryRetrievalMeta;
}

/**
 * Model-facing projection of {@link ProtocolDiscoveryResult}: identical except
 * the `retrieval` block carries only the model-relevant fields (no
 * `embeddingModel`/`embeddingDim`). The dispatcher serializes THIS shape into
 * the `discover_tools` tool-output string while keeping the full result for
 * telemetry. See `toModelDiscoveryResult` in `dispatcher/protocol-route.ts`.
 */
export interface ProtocolDiscoveryModelResult
  extends Omit<ProtocolDiscoveryResult, "retrieval"> {
  retrieval?: ProtocolDiscoveryModelRetrievalMeta;
}

