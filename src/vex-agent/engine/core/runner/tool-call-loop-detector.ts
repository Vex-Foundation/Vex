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
 * ## Zero imports, on purpose
 *
 * This module imports NOTHING - the `unproductive-rounds.ts` precedent. Its
 * only consumer is `turn-loop-tool-batch.ts`, which it must never import back
 * (the batch orchestrator would then depend on a module that depends on it),
 * and a detector with no dependencies is a pure function of what it was told,
 * which is what makes the table tests over it worth anything.
 *
 * Derived in pattern, not in code, from gemini-cli's `loopDetectionService`.
 */

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
 * The signature of a completed call: name, canonical arguments, success flag,
 * and model-visible output.
 *
 * Deliberately a readable joined string and not a cryptographic digest. It is
 * compared for equality and never persisted, logged, or shown to anyone - the
 * facts above are what leaves this module - so hashing would buy nothing and
 * cost the ability to see, in a debugger, exactly which two calls the detector
 * thought were the same.
 */
export function toolCallSignature(observation: CompletedToolCallObservation): string {
  return [
    observation.toolName,
    canonicalize(observation.args),
    observation.success ? "ok" : "err",
    observation.output,
  ].join(" ");
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
  let strikes = 0;

  return {
    observe(observation: CompletedToolCallObservation): ToolCallLoopVerdict {
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
        };
        return strikes >= 2
          ? { kind: "stop", facts }
          : { kind: "correct", facts };
      }

      return { kind: "clear" };
    },
  };
}
