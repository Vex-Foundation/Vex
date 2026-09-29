/**
 * The tool-call REPETITION detector - a cycle detector over completed tool
 * calls, deliberately kept separate from both the iteration budget and the
 * unproductive-round stall counter.
 *
 * ## Why this is a third bound and not one of the two we already had
 *
 * `iteration-budget.ts` bounds how much WORK a turn may do. A round that
 * batches six tool calls costs one unit, so it is a backstop against a model
 * that works forever, not against a model that works in a circle.
 *
 * `unproductive-rounds.ts` bounds how many times in a row the model may answer
 * with NOTHING. Its whole premise is that the round persisted nothing.
 *
 * This one catches the opposite failure and the one the production incident
 * actually showed: the model emits a real tool call, the call really executes,
 * it really returns a result, and that result is byte-identical to the last
 * five - the same refusal, the same "not found", the same balance. Every round
 * is productive by both other measures. The budget drains, the wall clock
 * drains, real money is spent on input tokens, and nothing changes. Neither
 * existing bound can see it, because both of them are counting the wrong
 * thing.
 *
 * ## The signature, and why the RESULT is in it
 *
 * A signature is the hash of the tool NAME, its CANONICAL arguments, and its
 * canonical RESULT (the success flag plus the model-visible output). Duration
 * and tool-call id are excluded: they differ on every call by construction,
 * so including them would make every signature unique and the detector inert.
 *
 * Including the result is the decision that makes this safe to ship. A model
 * polling an endpoint until it changes - a pending transaction, a filling
 * order, a block confirmation - is CORRECT behaviour, and it emits the
 * identical name and arguments every time. What distinguishes correct polling
 * from a loop is that the answer moves. So a poll whose result changes never
 * accumulates a repeat, and a poll whose result is frozen is, after five
 * identical answers, indistinguishable from the incident.
 *
 * ## Volatile fields, and why the rule is PER TOOL
 *
 * Including the result has a blind spot: many reads stamp every answer with
 * something that moves on every call and is not progress - `fetchedAt`,
 * `observedAt`, `retrievedAt`, `asOf`, a request id, a Solana `blockId`, a
 * wall-clock age derived from `Date.now()`. Such a result is never
 * byte-identical twice, so a model polling a frozen price was never caught.
 *
 * The fix is NOT a global "ignore timestamps and prices". A changed price, a
 * changed balance, a changed order status can be exactly the progress a
 * market mission is waiting for, and hiding it would turn correct polling into
 * a false loop. So normalisation is an ALLOW-LIST keyed by tool name
 * (`TOOL_RESULT_VOLATILE_KEYS`): for a listed tool, the output is parsed as
 * JSON and the named keys are dropped at every depth before hashing; every
 * other field, prices and balances included, stays in the signature. A tool
 * that is not listed, or an output that is not JSON, is hashed verbatim,
 * exactly as before.
 *
 * ## The read-polling cap
 *
 * Normalisation cannot catch a model that polls a price that really IS moving:
 * each answer differs, so no cycle forms, and the turn can spend its whole
 * budget re-reading one quote. For the same listed reads, the detector also
 * counts calls with identical name and canonical arguments across the turn,
 * whatever they returned. The call that takes one tool past
 * `TOOL_READ_POLL_CAP` identical-argument calls earns a strike on the same
 * graduated ladder, with a cue that says "proceed with what you have, or wait
 * with LoopDefer". Only listed reads are capped: an unknown tool, or a status
 * tool whose answer is the thing being waited on, keeps the old behaviour.
 *
 * ## The bound, and why the first strike only corrects
 *
 * Five identical repeats of a cycle of length k, k in [1,5]. The history is
 * bounded to `THRESHOLD * MAX_CYCLE_LENGTH` entries, which is exactly what the
 * longest detectable cycle needs and nothing more.
 *
 * Detection is GRADUATED (owner decision 2026-08-28). The first strike does
 * not end the turn: it drains the rest of the emitted batch and hands the model
 * a corrective cue, so it SEES that it is repeating itself before another real
 * call executes. Models recover from this far more often than they recover from
 * being killed, and the cost of a false positive drops to one wasted round plus
 * a sentence of context. Only the SECOND strike - the model repeating the same
 * signature again AFTER being told - ends the turn, because at that point the
 * repetition survived the cheapest possible intervention and the next thing to
 * try is a human.
 *
 * Cost of a false positive at strike two: a turn ends with an honest message
 * and a transcript the user can read. Cost of not having it: the incident.
 *
 * ## No project imports, on purpose
 *
 * This module imports NO PROJECT CODE - the `unproductive-rounds.ts`
 * precedent. Its only consumer is `turn-loop-tool-batch.ts`, which it must
 * never import back (the batch orchestrator would then depend on a module that
 * depends on it), and a detector with no project dependencies is a pure
 * function of what it was told, which is what makes the table tests over it
 * worth anything.
 *
 * The one exception is `node:crypto`, a runtime builtin used for the signature
 * digest. It is not an engine edge, cannot join an import cycle, and cannot
 * change underneath this module - so the property this rule protects is
 * untouched. `toolCallSignature` states why a real digest rather than a
 * hand-rolled hash.
 *
 * Derived in pattern, not in code, from gemini-cli's `loopDetectionService`.
 */

import { createHash } from "node:crypto";

/** Identical repeats of a cycle before the detector reacts. */
export const TOOL_CALL_LOOP_THRESHOLD = 5;

/**
 * Longest repeating cycle the detector looks for. `k = 1` is the plain
 * "same call five times"; `k = 2` catches the A-B-A-B ping-pong between two
 * calls that keep undoing each other. Beyond five the pattern is long enough
 * that the model is plausibly working through a list.
 */
export const MAX_TOOL_CALL_CYCLE_LENGTH = 5;

/** Bounded history: exactly what the longest detectable cycle needs. */
export const TOOL_CALL_SIGNATURE_HISTORY_LIMIT =
  TOOL_CALL_LOOP_THRESHOLD * MAX_TOOL_CALL_CYCLE_LENGTH;

/**
 * Identical-argument calls to one listed read allowed per turn. The call that
 * exceeds it (the sixth) is the strike. Five reads of one quote in one turn is
 * already generous: a value worth waiting for is waited for with LoopDefer.
 */
export const TOOL_READ_POLL_CAP = 5;

/**
 * Provenance stamps that change on every call and carry no market state:
 * wall-clock fetch times, provider request ids, edge-cache bookkeeping.
 */
const READ_PROVENANCE_KEYS = [
  "fetchedAt",
  "fetchedAtMs",
  "observedAt",
  "retrievedAt",
  "asOf",
  "requestId",
  "cacheState",
  "cacheAgeMs",
] as const;

/**
 * Per-tool volatile result keys. A listed tool's JSON output has these keys
 * removed at every depth before it is hashed, and the tool is subject to the
 * read-polling cap. Everything NOT named here (prices, balances, sizes,
 * statuses, candles) stays in the signature, because a change in it can be the
 * very progress the model is waiting for.
 *
 * Only reads belong here. A tool is added when its real handler is known to
 * stamp the listed keys; guessing would only widen what counts as "the same".
 */
export const TOOL_RESULT_VOLATILE_KEYS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const rules: [readonly string[], readonly string[]][] = [
    // Jupiter price/v3 entries carry the slot they were read at; a new slot
    // with the same `usdPrice` is not a new price.
    [["solana__token_prices_get"], ["blockId"]],
    // DexScreener answers carry `sourceObservation` (fetch time, edge cache
    // state and age) and ages computed from the wall clock at shaping time.
    [
      [
        "dexscreener__pair_get",
        "dexscreener__pairs_batch_get",
        "dexscreener__pairs_search",
        "dexscreener__token_pairs_list",
        "dexscreener__spotlight_get",
        "dexscreener__pair_details_get",
      ],
      ["pairAgeSeconds", "blurbAgeMs", "blurbAgeNote"],
    ],
    // pools.fun rows carry an age in hours computed from the wall clock.
    [["pools__token_get"], ["ageHours"]],
    // Pendle, Morpho, Lighter and wallet balance reads stamp `asOf`,
    // `retrievedAt` or `observedAt` with the time of the read.
    [
      [
        "pendle__asset_prices_get",
        "pendle__market_get",
        "pendle__market_orderbook_get",
        "morpho__market_get",
        "morpho__wallet_balance_get",
        "morpho__positions_get",
        "lighter__market_get",
        "lighter__markets_list",
        "lighter__orderbook_get",
        "lighter__positions_list",
        "khalani__token_balances_get",
        "WalletBalances",
      ],
      [],
    ],
  ];
  const map = new Map<string, ReadonlySet<string>>();
  for (const [tools, extra] of rules) {
    const keys = new Set<string>([...READ_PROVENANCE_KEYS, ...extra]);
    for (const tool of tools) map.set(tool, keys);
  }
  return map;
})();

/**
 * One completed, ORDINARY tool call. The caller filters: approval breaks,
 * user-form parks, prepared-action follow-ups and engine signals carry
 * stronger semantics of their own and are never observed here.
 */
export interface CompletedToolCallObservation {
  readonly toolCallId: string;
  readonly toolName: string;
  /** The arguments the model emitted, as dispatched. */
  readonly args: unknown;
  /** The result's model-visible output, verbatim. */
  readonly output: string;
  /** The result's success flag, as the model saw it. */
  readonly success: boolean;
}

/**
 * What the detector observed, with NO raw arguments in it.
 *
 * Arguments are the sensitive part of a repeated call by inference: a repeated
 * transfer carries a destination, a repeated quote carries an amount, a
 * repeated failure carries whatever the provider echoed back. These facts go
 * into a durable stop payload, a log line and an operator-visible surface, so
 * they carry the shape of the repetition and never its contents.
 */
export interface ToolCallLoopFacts {
  /** The tool at the head of the repeating cycle. */
  readonly toolName: string;
  /** Cycle length k: 1 for a single call repeating, 2 for A-B-A-B. */
  readonly cycleLength: number;
  /** Identical repeats observed, always at least `TOOL_CALL_LOOP_THRESHOLD`. */
  readonly repeatCount: number;
  /** Call ids of the repeated calls, oldest first - the transcript pointer. */
  readonly toolCallIds: readonly string[];
  /** 1 = corrected, 2 = stopped. */
  readonly strike: number;
  /**
   * What fired. `cycle` (also assumed when absent): identical results in a
   * repeating cycle. `read_poll`: one listed read called with identical
   * arguments more than `TOOL_READ_POLL_CAP` times this turn, whatever it
   * returned; `repeatCount` is then the number of those calls.
   */
  readonly trigger?: "cycle" | "read_poll";
}

export type ToolCallLoopVerdict =
  /** Nothing to do; the batch continues normally. */
  | { readonly kind: "clear" }
  /** Strike 1: drain the batch remainder and show the model the cue. */
  | { readonly kind: "correct"; readonly facts: ToolCallLoopFacts }
  /** Strike 2: drain the remainder and end the turn with `tool_call_loop`. */
  | { readonly kind: "stop"; readonly facts: ToolCallLoopFacts };

/**
 * A detector instance. Owned by ONE `runTurnLoop` invocation and threaded into
 * every tool batch that turn runs.
 *
 * The lifetime matters and is the whole reason this is an object rather than a
 * pure function over a batch: strike one lands mid-batch, and strike two
 * normally lands on the NEXT model turn, after the model read the cue and
 * chose to repeat itself anyway. A detector scoped to a single batch could
 * never observe the second strike, and one scoped to the process would carry a
 * dead turn's history into a live one.
 */
export interface ToolCallLoopDetector {
  observe(observation: CompletedToolCallObservation): ToolCallLoopVerdict;
}

/**
 * Canonical JSON: object keys sorted at every depth, so two argument objects
 * that differ only in key order produce one signature. Arrays keep their order
 * (order is meaning in an argument list). Anything not JSON-representable
 * degrades to its `String()` form rather than throwing - a signature that is
 * merely coarse is far better than a detector that can crash a tool batch.
 */
export function canonicalize(value: unknown): string {
  const seen = new Set<object>();

  const walk = (node: unknown): string => {
    if (node === null) return "null";
    if (node === undefined) return "undefined";
    const nodeType = typeof node;
    if (nodeType === "string") return JSON.stringify(node);
    if (nodeType === "number" || nodeType === "boolean") return String(node);
    if (nodeType === "bigint") return `${String(node)}n`;
    if (nodeType !== "object") return JSON.stringify(String(node));

    const asObject = node as object;
    // A cycle in tool arguments is pathological, not expected. Naming it in
    // the signature keeps two different cyclic shapes from colliding while
    // still terminating.
    if (seen.has(asObject)) return '"[circular]"';
    seen.add(asObject);
    try {
      if (Array.isArray(node)) {
        return `[${node.map(walk).join(",")}]`;
      }
      const entries = Object.entries(node as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entryValue]) => `${JSON.stringify(key)}:${walk(entryValue)}`);
      return `{${entries.join(",")}}`;
    } finally {
      seen.delete(asObject);
    }
  };

  return walk(value);
}

/**
 * The model-visible output as it enters the signature.
 *
 * Unlisted tools: verbatim. Listed tools: parsed as JSON, the tool's volatile
 * keys dropped at every depth, and re-serialised canonically. An output that
 * does not parse (a failure message, a wrapped or truncated body) falls back
 * to verbatim, which is never looser than the old behaviour.
 */
export function normalizeToolResultOutput(toolName: string, output: string): string {
  const volatileKeys = TOOL_RESULT_VOLATILE_KEYS.get(toolName);
  if (volatileKeys === undefined) return output;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== "object") return node;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!volatileKeys.has(key)) kept[key] = strip(value);
    }
    return kept;
  };
  return canonicalize(strip(parsed));
}

/**
 * The signature of a completed call: a sha256 over the tool name, its canonical
 * arguments, the success flag and the model-visible output (normalised per
 * tool, see `normalizeToolResultOutput`).
 *
 * ## Why it is HASHED and not the joined string
 *
 * The joined string RETAINS what it joins. Tool arguments and model-visible
 * output are exactly where wallet addresses, amounts, provider responses and
 * user content live, and the history array holds `THRESHOLD * MAX_CYCLE_LENGTH`
 * of them for the life of the turn. A digest keeps the only property the
 * detector uses - equality - and keeps that content out of a structure whose
 * whole job is to sit in memory beside the runner. It is also the shape the
 * approved design specified and the shape this module's header already
 * describes; the joined string was the drift.
 *
 * ## sha256, not a local FNV-1a
 *
 * The alternative was a hand-rolled 32-bit hash to preserve this module's
 * zero-import property. Rejected on consequence: a collision here means two
 * DIFFERENT calls count as a repeat, and five of those STOP A RUN. A 32-bit
 * hash over a turn's worth of entries has a real collision probability;
 * sha256's is not a number anyone needs to reason about. `node:crypto` is a
 * runtime builtin, so it adds no engine edge and cannot join an import cycle -
 * the property the zero-import habit protected is intact.
 *
 * The separator is an escaped NUL, which cannot occur in the JSON-encoded
 * canonical form, so no shifting of a field boundary can forge a collision. It
 * is written `\u0000` rather than typed literally: a raw NUL byte makes this
 * file classify as binary data, which breaks diffs, greps and review tooling.
 */
export function toolCallSignature(observation: CompletedToolCallObservation): string {
  const canonical = [
    observation.toolName,
    canonicalize(observation.args),
    observation.success ? "ok" : "err",
    normalizeToolResultOutput(observation.toolName, observation.output),
  ].join("\u0000");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Whether the tail of `history` is `threshold` back-to-back repeats of its last
 * `cycleLength` entries.
 *
 * Read from the end: the last window is compared against each earlier window,
 * so a cycle that has just completed its fifth pass is detected on the call
 * that completed it, not one call later.
 */
function tailRepeatsCycle(
  history: readonly string[],
  cycleLength: number,
  threshold: number,
): boolean {
  const needed = cycleLength * threshold;
  if (history.length < needed) return false;
  const start = history.length - needed;
  for (let offset = cycleLength; offset < needed; offset++) {
    if (history[start + offset] !== history[start + (offset % cycleLength)]) {
      return false;
    }
  }
  return true;
}

export function createToolCallLoopDetector(): ToolCallLoopDetector {
  const signatures: string[] = [];
  const callIds: string[] = [];
  const names: string[] = [];
  // Per-turn identical-argument counts for listed reads, keyed by a digest of
  // name + canonical args (never the args themselves, for the same reason
  // signatures are digests). Ids are kept only for the last CAP + 1 calls.
  const polls = new Map<string, { count: number; ids: string[] }>();
  let strikes = 0;

  return {
    observe(observation: CompletedToolCallObservation): ToolCallLoopVerdict {
      let poll: { count: number; ids: string[] } | undefined;
      if (TOOL_RESULT_VOLATILE_KEYS.has(observation.toolName)) {
        const pollKey = createHash("sha256")
          .update(`${observation.toolName}\u0000${canonicalize(observation.args)}`, "utf8")
          .digest("hex");
        poll = polls.get(pollKey) ?? { count: 0, ids: [] };
        poll.count += 1;
        poll.ids.push(observation.toolCallId);
        if (poll.ids.length > TOOL_READ_POLL_CAP + 1) poll.ids.shift();
        polls.set(pollKey, poll);
      }

      signatures.push(toolCallSignature(observation));
      callIds.push(observation.toolCallId);
      names.push(observation.toolName);
      // Ring bound, applied to all three parallel arrays together so an index
      // always names the same call in each of them.
      if (signatures.length > TOOL_CALL_SIGNATURE_HISTORY_LIMIT) {
        signatures.shift();
        callIds.shift();
        names.shift();
      }

      // Shortest cycle first: five copies of one call is a k=1 loop, and
      // reporting it as a k=5 one (which it also technically is) would name a
      // pattern the operator cannot recognise in the transcript.
      for (
        let cycleLength = 1;
        cycleLength <= MAX_TOOL_CALL_CYCLE_LENGTH;
        cycleLength++
      ) {
        if (!tailRepeatsCycle(signatures, cycleLength, TOOL_CALL_LOOP_THRESHOLD)) {
          continue;
        }
        const needed = cycleLength * TOOL_CALL_LOOP_THRESHOLD;
        const start = signatures.length - needed;
        strikes += 1;
        const facts: ToolCallLoopFacts = {
          // The head of the cycle, which for k=1 is simply the repeated tool.
          toolName: names[start] ?? observation.toolName,
          cycleLength,
          repeatCount: TOOL_CALL_LOOP_THRESHOLD,
          toolCallIds: callIds.slice(start),
          strike: strikes,
          trigger: "cycle",
        };
        return strikes >= 2
          ? { kind: "stop", facts }
          : { kind: "correct", facts };
      }

      // Checked AFTER the cycle scan: when both fire on one call, the cycle is
      // the more specific fact (the result did not move either). Every call
      // past the cap strikes, so a read repeated after its correction stops.
      if (poll !== undefined && poll.count > TOOL_READ_POLL_CAP) {
        strikes += 1;
        const facts: ToolCallLoopFacts = {
          toolName: observation.toolName,
          cycleLength: 1,
          repeatCount: poll.count,
          toolCallIds: [...poll.ids],
          strike: strikes,
          trigger: "read_poll",
        };
        return strikes >= 2
          ? { kind: "stop", facts }
          : { kind: "correct", facts };
      }

      return { kind: "clear" };
    },
  };
}
