/**
 * In-memory reasoning replay for ONE turn-loop run (Kairos R-7).
 *
 * The turn loop rebuilds the provider request from the durable tape every
 * round, and the tape never stores provider reasoning details (they can be
 * opaque encrypted blobs that must not reach the transcript or the UI). This
 * store keeps them in memory for the life of one `runTurnLoop` call and puts
 * them back on the matching assistant tool-call messages of the envelope just
 * before it is measured and sent.
 *
 * MATCHING. A round is keyed by the exact, ordered list of tool-call ids the
 * model returned. It is attached only to an envelope message whose tool-call
 * ids are that same list: a batch the loop trimmed, refused or repaired (ids
 * rewritten) does not match and simply goes without replay, because the
 * reasoning would describe calls that are not there.
 *
 * PROVIDER CONSISTENCY. A replay is only attached while the most recent round
 * was served by the same upstream provider that produced it (sticky routing
 * makes the last round the best available predictor of the next). After an
 * endpoint switch, or when the serving provider is unknown, nothing is
 * attached: a signature or encrypted blob minted by one upstream is not
 * guaranteed to verify on another.
 *
 * CACHING. Within the run, a replayed message is attached from the round
 * after it was produced and stays byte-identical on every later round, so the
 * cached prefix only grows: no bust. The prefix before the first replayed
 * message (static prefix, summary, earlier history) is untouched. The one
 * cost is at the NEXT run: its first request no longer carries this run's
 * details, so the provider's cached prefix diverges at the first replayed
 * message of this run and that tail is re-read once. That trade is exactly
 * what the switch must be measured on before it is turned on.
 *
 * OFF (`enabled` false, the shipped `REASONING_REPLAY_ENABLED`): records
 * nothing and `attach` returns the very envelope object it was given.
 */

import type { ParsedToolCall, ReasoningReplayPayload } from "@vex-agent/inference/types.js";
import { shouldReplayReasoning } from "@vex-agent/inference/openrouter/reasoning-replay.js";
import type { TurnEnvelope } from "../turn-envelope.js";

/** Rounds a run may hold. Later rounds go without replay; earlier ones stay. */
export const MAX_REPLAY_ROUNDS_PER_RUN = 64;
/** Total payload bytes a run may hold, under the same rule. */
export const MAX_REPLAY_BYTES_PER_RUN = 4 * 1024 * 1024;

export interface ReplayRoundObservation {
  readonly model: string;
  readonly toolCalls: readonly ParsedToolCall[] | null;
  readonly reasoningReplay?: ReasoningReplayPayload | null;
  readonly servingProvider?: string | null;
}

export interface ReplayAttachResult {
  readonly envelope: TurnEnvelope;
  /** Messages that carry a replay in this request (sanitised telemetry). */
  readonly attachedMessages: number;
  readonly attachedBytes: number;
}

export interface ReasoningReplayStore {
  /** Feed every completed inference round, tool round or not. */
  observeRound(round: ReplayRoundObservation): void;
  /** The envelope to send: replays attached, or the same object when none. */
  attach(envelope: TurnEnvelope, model: string): ReplayAttachResult;
}

interface StoredRound {
  readonly model: string;
  readonly servingProvider: string;
  readonly payload: ReasoningReplayPayload;
}

function keyOf(ids: readonly string[]): string | null {
  if (ids.length === 0 || ids.some((id) => id.length === 0)) return null;
  return JSON.stringify(ids);
}

export function createReasoningReplayStore(enabled: boolean): ReasoningReplayStore {
  const rounds = new Map<string, StoredRound>();
  let totalBytes = 0;
  let latestServingProvider: string | null = null;

  return {
    observeRound(round) {
      if (!enabled) return;
      latestServingProvider = round.servingProvider ?? null;
      const payload = round.reasoningReplay ?? null;
      if (payload === null || latestServingProvider === null) return;
      if (!shouldReplayReasoning(round.model, enabled)) return;
      const key = keyOf((round.toolCalls ?? []).map((call) => call.id));
      if (key === null || rounds.has(key)) return;
      if (rounds.size >= MAX_REPLAY_ROUNDS_PER_RUN) return;
      if (totalBytes + payload.byteLength > MAX_REPLAY_BYTES_PER_RUN) return;
      rounds.set(key, { model: round.model, servingProvider: latestServingProvider, payload });
      totalBytes += payload.byteLength;
    },

    attach(envelope, model) {
      const none = { envelope, attachedMessages: 0, attachedBytes: 0 };
      if (!enabled || rounds.size === 0 || latestServingProvider === null) return none;
      if (!shouldReplayReasoning(model, enabled)) return none;
      let attachedMessages = 0;
      let attachedBytes = 0;
      const providerMessages = envelope.providerMessages.map((message) => {
        if (message.role !== "assistant" || message.toolCalls === undefined) return message;
        const key = keyOf(message.toolCalls.map((call) => call.id));
        const stored = key === null ? undefined : rounds.get(key);
        if (
          stored === undefined
          || stored.model !== model
          || stored.servingProvider !== latestServingProvider
        ) {
          return message;
        }
        attachedMessages += 1;
        attachedBytes += stored.payload.byteLength;
        return { ...message, reasoningReplay: stored.payload };
      });
      if (attachedMessages === 0) return none;
      return {
        envelope: { ...envelope, providerMessages },
        attachedMessages,
        attachedBytes,
      };
    },
  };
}
