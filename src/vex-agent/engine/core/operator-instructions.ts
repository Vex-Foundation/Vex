/**
 * Operator instructions — user messages injected while a loop is already
 * active. They are real transcript rows, but marked so the live loop can
 * merge only those rows between iterations.
 */

import type { Message, MessageWithId } from "@vex-agent/db/repos/messages.js";
import * as messagesRepo from "@vex-agent/db/repos/messages.js";
import { withTransaction } from "@vex-agent/db/client.js";
import {
  TRANSCRIPT_APPEND_EVENT_TYPE,
  appendEngineMessage,
  appendMessage,
  emitTranscriptAppend,
} from "@vex-agent/engine/events/index.js";

export const OPERATOR_INTERRUPT_MESSAGE_TYPE = "operator_interrupt";

/**
 * The engine's own acknowledgement of an operator instruction, as a distinct
 * `message_type` from the instruction row and from the model-facing cue.
 * Distinctness is the point: all three describe the same event and only this
 * one is the engine telling the USER what it did with their message.
 */
export const OPERATOR_INSTRUCTION_ACK_MESSAGE_TYPE = "operator_interrupt_ack";

/**
 * What the engine actually DID with an operator instruction, decided by the
 * ingress route that persisted it and recorded on the instruction row itself.
 *
 * ## Why this is a typed field and not prose
 *
 * The acknowledgement used to be `QUEUED_INTERRUPT_TEXT` returned as
 * `TurnResult.text`: a sentence, produced by one branch, that vanished the
 * moment the response was consumed. It was not durable (a reload lost it), it
 * was not distinguishable (every route that queued anything returned the same
 * paragraph, including the one that had actually PREEMPTED a scheduled wake
 * and resumed the run), and anything downstream that wanted to know what
 * happened could only have compared strings. Every channel now derives from
 * this value.
 *
 * - `steered`: persisted into a LIVE turn (a running mission run, or an agent
 *   session whose runner lease is held). The loop merges it at its next tool
 *   batch boundary; nothing was interrupted and nothing was started.
 * - `queued_interrupt`: persisted for a run that is NOT currently executing a
 *   turn - parked on an approval, parked on an error, or claimed by someone
 *   else. It is read whenever the run next runs, which may be after a human
 *   acts. This is the honest, weaker claim, and it is the default for a route
 *   that cannot prove the stronger one.
 * - `preempted_wake`: the instruction cancelled a scheduled wake and the run
 *   was resumed immediately to read it. The only disposition whose write has
 *   an immediate consequence for the run's status.
 */
export type OperatorInterruptDisposition =
  | "steered"
  | "queued_interrupt"
  | "preempted_wake";

/**
 * THE classifier for the two dispositions that are DERIVED from state, in one
 * place, used by every route that persists an operator instruction.
 *
 * ## Why it had to be one function
 *
 * The routes disagreed, and each disagreement was visible to the operator.
 * `routeUserMessage` labelled every `running` run `queued_interrupt` even when
 * a runner was demonstrably executing it, so a genuinely steered message told
 * the user it would be read "the next time it runs". `submitSteeringMessage`
 * made the opposite error and labelled `paused_approval` as `steered`, telling
 * the user a parked run would pick their message up mid-turn when nothing was
 * running at all. Two routes, two answers, wrong in opposite directions, and no
 * single place to correct either.
 *
 * ## The rule
 *
 * `steered` requires PROOF that something is executing: a live lease belonging
 * to this session's current work. A row status alone is not proof - `running`
 * with a dead lease is exactly the crashed-runner state the restart-orphan
 * sweep exists to clean up, and telling the operator their message was steered
 * into it would be a lie about a run nobody is driving.
 *
 * Everything else is `queued_interrupt`: the honest, weaker claim, and the
 * default on purpose, because a route that cannot prove the stronger claim
 * should make the weaker one.
 *
 * ## `preempted_wake` is deliberately NOT produced here
 *
 * It is not derivable from status and lease. It is a fact about an ACTION that
 * succeeded - a wake cancelled and the run claimed - so only the code that
 * performed that claim and saw it WIN may assert it. Deriving it from a
 * `paused_wake` status would claim a preempt that may have lost its race.
 */
export function classifyOperatorInterruptDisposition(input: {
  /** The mission run's status, or `null` for an agent session with no run. */
  readonly runStatus: string | null;
  /**
   * A lease that is unexpired AND belongs to this work: the same run for a
   * mission run, the session itself for an agent session. A lease held for a
   * DIFFERENT run is someone else's turn and cannot merge this message.
   */
  readonly hasLiveMatchingLease: boolean;
}): OperatorInterruptDisposition {
  const executing = input.runStatus === "running" || input.runStatus === null;
  return executing && input.hasLiveMatchingLease
    ? "steered"
    : "queued_interrupt";
}

/**
 * The user-visible acknowledgement per disposition.
 *
 * One sentence each, saying what happened and when the agent will read it -
 * that second half is the part the old single paragraph could not tell the
 * truth about, because it was shared by routes with different answers. Written
 * for the operator, so no engine vocabulary and no run ids.
 */
const DISPOSITION_ACKNOWLEDGEMENT: Readonly<
  Record<OperatorInterruptDisposition, string>
> = {
  steered:
    "Sent to the agent. It is mid-turn, so it will pick this up at its next step and keep going.",
  queued_interrupt:
    "Saved. The agent is not running a turn right now, so it will read this the next time it runs.",
  preempted_wake:
    "Sent to the agent. Its scheduled wake was cancelled and it is resuming now to read this.",
};

const OPERATOR_INTERRUPT_CUE = [
  "[Engine: operator_interrupt — The operator sent new guidance while this autonomous run was active.",
  "Acknowledge the latest operator instruction briefly, apply it if it is compatible with the active contract, then continue the run.",
  "Do not ask the operator to start or continue the mission again unless they explicitly ask to leave execution.]",
].join(" ");

export function maxOperatorInstructionId(messages: readonly Message[]): number {
  let max = 0;
  for (const message of messages) {
    if (
      message.id !== undefined
      && message.role === "user"
      && message.metadata?.messageType === OPERATOR_INTERRUPT_MESSAGE_TYPE
      && message.id > max
    ) {
      max = message.id;
    }
  }
  return max;
}

/**
 * Persist one operator instruction together with the engine's durable
 * acknowledgement of what it did with it.
 *
 * ## One transaction, on purpose
 *
 * The instruction row and its acknowledgement are two statements about one
 * event, and either one alone is a lie. An instruction with no acknowledgement
 * is the failure this replaced - the operator has no record that the system
 * received it and no idea when it will be read. An acknowledgement with no
 * instruction is worse: it tells the operator the agent has their message when
 * nothing does. So both rows commit together or neither does, and the
 * disposition rides the instruction row's own payload, which is an existing
 * JSONB column - no schema change is involved anywhere in this.
 *
 * Events are emitted only after the COMMIT returns (the rule
 * `append-transcript.ts` documents): an event implies a row a reader can
 * fetch, so a rollback must take both events with it. `withTransaction`
 * rethrows, so a failed write reaches the caller instead of silently
 * degrading to "queued" for a message nobody has.
 *
 * `payload` is the route's own free-form context (target, run id, run status).
 * It cannot override `disposition`: the spread is ordered so the typed value
 * wins, because a caller passing a fourth disposition as a loose string is
 * exactly the drift this field exists to end.
 */
export async function addOperatorInstruction(
  sessionId: string,
  content: string,
  disposition: OperatorInterruptDisposition,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const instructionMetadata = {
    source: "user",
    messageType: OPERATOR_INTERRUPT_MESSAGE_TYPE,
    visibility: "user",
    payload: { operatorInstruction: true, ...payload, disposition },
  } as const;

  const ackMetadata = {
    source: "engine",
    messageType: OPERATOR_INSTRUCTION_ACK_MESSAGE_TYPE,
    // USER-visible, unlike the model-facing cue below: this row IS the
    // acknowledgement the operator reads. It is an engine notice row, never
    // assistant prose - the agent did not say this, the runtime did.
    visibility: "user",
    // The disposition IS persisted here, deliberately: this row and the
    // instruction row are two records of one event, and an audit forced to
    // infer the ack's disposition from its prose would be reading rendered
    // text back as data.
    //
    // It is equally deliberately NOT PROJECTED onto the ack DTO. The mapper
    // reads `payload -> 'disposition'` only for the `operator_interrupt` row
    // (`extractInterruptDisposition` in the app's messages mapper). This row's
    // own TEXT already states what happened, so projecting the field as well
    // would give the renderer two sources for one fact and a chance to render
    // them differently - which is the exact class of contradiction the typed
    // disposition was introduced to end. The instruction row is where the
    // renderer's delivery words come from.
    payload: { operatorInstructionAck: true, disposition },
  } as const;

  const { instruction, ack } = await withTransaction(async (client) => {
    const instructionRow = await appendMessage(
      sessionId,
      { role: "user", content, timestamp: new Date().toISOString() },
      instructionMetadata,
      { client },
    );
    const ackRow = await appendEngineMessage(
      sessionId,
      DISPOSITION_ACKNOWLEDGEMENT[disposition],
      ackMetadata,
      { client },
    );
    return { instruction: instructionRow, ack: ackRow };
  });

  for (const [row, metadata] of [
    [instruction, instructionMetadata],
    [ack, ackMetadata],
  ] as const) {
    emitTranscriptAppend({
      type: TRANSCRIPT_APPEND_EVENT_TYPE,
      sessionId,
      messageId: row.id,
      role: row.role,
      createdAt: row.timestamp,
      messageType: metadata.messageType,
      correlationId: null,
    });
  }
}

export async function addOperatorCue(sessionId: string): Promise<void> {
  await appendEngineMessage(
    sessionId,
    OPERATOR_INTERRUPT_CUE,
    {
      source: "engine",
      messageType: OPERATOR_INTERRUPT_MESSAGE_TYPE,
      visibility: "internal",
      payload: { operatorInstructionCue: true },
    },
  );
}

export async function appendPendingOperatorInstructions(input: {
  sessionId: string;
  afterId: number;
  liveMessages: Message[];
}): Promise<number> {
  const pending = await messagesRepo.getOperatorInstructionsAfter(input.sessionId, input.afterId);
  if (pending.length === 0) return input.afterId;

  const existingIds = new Set(input.liveMessages.map((message) => message.id));
  input.liveMessages.push(
    ...pending
      .filter((message) => !existingIds.has(message.id))
      .map(toLiveMessage),
  );
  await addOperatorCue(input.sessionId);
  input.liveMessages.push({
    role: "system",
    content: OPERATOR_INTERRUPT_CUE,
    timestamp: new Date().toISOString(),
    metadata: {
      source: "engine",
      messageType: OPERATOR_INTERRUPT_MESSAGE_TYPE,
      visibility: "internal",
      payload: { operatorInstructionCue: true },
    },
  });

  return pending[pending.length - 1]?.id ?? input.afterId;
}

function toLiveMessage(message: MessageWithId): Message {
  return {
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
    toolCalls: message.toolCalls,
    timestamp: message.timestamp,
    id: message.id,
    metadata: message.metadata,
  };
}
