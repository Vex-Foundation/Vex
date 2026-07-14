/**
 * Autonomy tools — primitives for mission active runs. Post-M12 only the
 * mission runtime loops; `loop_defer` lives here because it's the only
 * tool that encodes "sleep until" semantics for the mission turn-loop.
 *
 * Visibility contract (enforced by `getOpenAITools` via `ToolVisibility`):
 *   - `requiresMissionActiveRun: true` requires `missionRunActive === true`.
 *     Agent mode (one-shot conversation) never loops and never sees
 *     `loop_defer`. Mission setup (no active run yet) also doesn't.
 *   - `excludeRoles: ["subagent"]` is defense in depth — a child subagent
 *     that somehow ended up with the tool name should still be rejected at
 *     dispatch.
 * Contract reminders for the model (PR-5 plan §7):
 *   - `reason` is an INTERNAL resume hint, not a user-facing message. It
 *     surfaces later as the wake banner + `effectiveRecallSeed` input
 *     (PR-10). Do NOT put the user-visible explanation here.
 *   - The user-facing explanation of why the agent is deferring MUST go in
 *     the normal `assistant.content`. A plain text reply WITHOUT a
 *     `loop_defer` call does NOT park the mission — engine continues the
 *     next iteration.
 *   - Exactly one of `after_ms` or `wake_at` — handler rejects both / neither.
 */

import type { ToolDef } from "../types.js";

export const AUTONOMY_TOOLS: readonly ToolDef[] = [
  {
    name: "tool_output_read",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    visibility: { hiddenInMissionSetup: true },
    description:
      "Read, SEARCH, or QUERY a previously-overflowed tool output. " +
      "When a tool returns more than ~16 KiB, the engine stores the full output off-prompt and leaves a short stub with `blob_key=<key>` in the transcript. " +
      "Prefer targeted modes over blind byte-slicing — a needle deep in the payload (e.g. a coin far down a markets list) is easy to miss with byte offsets alone. Three query modes, plus the byte-slice fallback:\n" +
      "• SEARCH: set `search` to find a literal substring (case-insensitive) anywhere in the RAW payload; each hit returns its byte `offset` and a short context window. Works for any payload shape. Not a regex.\n" +
      "• PATH: set `path` (dot/[index] only, e.g. `meta.universe`, `contexts[1]`, `meta.universe[230]`) to resolve a sub-value inside a JSON payload.\n" +
      "• ARRAY QUERY: when `path` points at an array, add `where` (filter on a scalar field), `sort_by`+`order` (sort on a scalar field), and `item_offset`+`limit` (paginate). The response reports `returned` and `matched` counts so you can see how much was truncated.\n" +
      "• BYTE SLICE (fallback): omit the above and use `offset`/`max_bytes`. " +
      "Every mode reads the original stored snapshot, is scoped to the current session, and is bounded well under the overflow threshold so results never re-overflow. Read the blob before its TTL expires.",
    parameters: {
      type: "object",
      properties: {
        blob_key: {
          type: "string",
          description:
            "The exact blob key shown in the overflow stub (format: `tob-<yyyymmdd>-<16hex>`).",
        },
        offset: {
          type: "integer",
          description:
            "BYTE-SLICE mode: byte offset to start reading from. Defaults to 0. Use `next_offset` from the previous response to continue.",
        },
        max_bytes: {
          type: "integer",
          description:
            "BYTE-SLICE mode: maximum bytes to return. The runtime caps this below the overflow threshold so reads stay inline.",
        },
        search: {
          type: "string",
          description:
            "SEARCH mode: find this literal substring in the RAW payload text (case-insensitive). Returns each hit's byte offset and a surrounding context window. Not a regular expression.",
        },
        path: {
          type: "string",
          description:
            "PATH mode (JSON payloads): dot/[index] path to a sub-value, e.g. `meta.universe`, `contexts[1]`, `meta.universe[230]`. Max 10 segments; no wildcards.",
        },
        where: {
          type: "object",
          description:
            "ARRAY QUERY (when `path` is an array): filter items on a scalar field. Provide `field` and exactly one of `contains` (case-insensitive substring) or `equals` (strict).",
          properties: {
            field: { type: "string", description: "Scalar item field to match on." },
            contains: { type: "string", description: "Case-insensitive substring match on `field`." },
            equals: { type: "string", description: "Strict equality match on `field` (string, number, or boolean)." },
          },
          required: ["field"],
        },
        sort_by: {
          type: "string",
          description: "ARRAY QUERY: sort items by this scalar field before paginating.",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "ARRAY QUERY: sort direction for `sort_by`. Defaults to `desc`.",
        },
        item_offset: {
          type: "integer",
          description: "ARRAY QUERY: number of items to skip after filtering/sorting. Defaults to 0.",
        },
        limit: {
          type: "integer",
          description:
            "SEARCH: max matches to return (default 10, max 50). ARRAY QUERY: max items per page (default 20, max 50).",
        },
      },
      required: ["blob_key"],
    },
  },
  {
    name: "loop_defer",
    kind: "internal",
    mutating: false,
    pressureSafety: "mutating",
    actionKind: "schedule",
    excludeRoles: ["subagent"],
    visibility: { requiresMissionActiveRun: true },
    description:
      "Pause the current mission run until a wake time. " +
      "Use this when you have nothing productive to do right now but should resume later (waiting for a blockchain finality window, a price feed update, a scheduled check). " +
      "The user-facing explanation goes in the normal assistant message content; `reason` here is an internal resume hint for the wake banner. " +
      "Specify exactly one of `after_ms` (relative) or `wake_at` (absolute ISO8601). You may attach up to four registered watch conditions; a match promotes this same pending wake without creating another row. Only one pending wake per session — calling again before the first fires is a no-op.",
    parameters: {
      type: "object",
      properties: {
        after_ms: {
          type: "number",
          description:
            "Relative wake delay in milliseconds. Must be between 1000 (1s) and 86_400_000 (24h). Exactly one of after_ms / wake_at is required.",
        },
        wake_at: {
          type: "string",
          description:
            "Absolute wake time as an ISO8601 timestamp (e.g. 2026-04-20T10:00:00Z). Must be in the future. Exactly one of after_ms / wake_at is required.",
        },
        reason: {
          type: "string",
          description:
            "Internal resume hint (≤ 500 chars). NOT shown to the user. Surfaces later as the wake banner and feeds the recall seed.",
        },
        watch: {
          type: "array",
          description: "Optional registered watch conditions, each with a type discriminator. Maximum 4.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["reason"],
    },
  },
];
