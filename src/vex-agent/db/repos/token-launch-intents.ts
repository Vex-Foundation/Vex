/**
 * Token-launch intents repo — the durable Trench Express launch state machine
 * (contract C1; migration `062_trench_launch.sql`).
 *
 * This file is the PUBLIC ENTRY POINT and owns the contract documentation; the
 * implementation lives in the same-named sibling folder, split by reason to
 * change: `./token-launch-intents/types.js` (row shape + mapper),
 * `./token-launch-intents/writers.js` (state transitions),
 * `./token-launch-intents/reads.js` (queries). Import from HERE.
 *
 * ── The invariants, copied VERBATIM from `./wallet-intents.ts` ──────────────
 *
 * A launch is the same category of thing as a transfer: a persisted,
 * session-owned, spend-bearing intent that must survive a process restart and
 * can never be executed twice. So it gets the same three guarantees, and they
 * are load-bearing rather than stylistic.
 *
 * **Session ownership.** EVERY mutation and lookup carries `session_id` in its
 * predicate. A consume / get / cancel from a DIFFERENT session must MISS even
 * when the intent id is known.
 *
 * **`rowCount` discipline.** Every CAS helper returns the mapped row or `null`.
 * `rowCount = 0` is NEVER a silent success — `null` is a hard "race lost" signal
 * the caller MUST gate on. For `consumeIfAuthorizedWith` in particular, ignoring
 * it means signing the same launch twice with real funds.
 *
 * **Client-bound writers.** Every transition into or out of a LIVE status takes
 * an explicit `PoolClient` and has NO pool-level variant. A launch intent is
 * money state that the compaction safe-moment gate reads
 * (`./approval-intents/money-state.ts`), and that gate is only sound if these
 * writers serialize with it on the session control lock. Requiring the client
 * makes "this write happened inside a session-control-locked transaction" a
 * COMPILE-TIME obligation instead of a convention. Callers use
 * `withSessionControlLock(sessionId, …)`, and that transaction must stay DB-only
 * and COMMIT before any signing or provider call. Reads stay pool-level: a read
 * does not change the gate's answer.
 *
 * ── The state machine (C1) ──────────────────────────────────────────────────
 *
 * The ENTRY state depends on the path, because two of the three paths have no
 * form to fill. There is deliberately no single starting state:
 *
 *   Path 1 (`agent_requested_form`) and a `user`-origin launch:
 *     awaiting_user_form → authorized → consuming → broadcast_pending
 *                        → confirmed | terminal_failure
 *
 *   Path 2 (`agent`, full autonomy) and the RESTRICTED approval path:
 *     authorized → consuming → broadcast_pending → confirmed | terminal_failure
 *     (no form step — the C0 authorization record IS the entry state)
 *
 * `cancelled` / `expired` are reachable ONLY from `awaiting_user_form`. Both
 * mean nothing was ever authorized and nothing was ever signed, which is why the
 * DB CHECK forbids them a tx hash.
 *
 * **`broadcast_pending` is NONTERMINAL and never resubmittable.** A launch whose
 * signed submission ended AMBIGUOUSLY (no receipt, an RPC error, a receipt-wait
 * throw) keeps its tx hash and sits here until a DEFINITIVE receipt arrives.
 * There is deliberately no timeout escalation: the alternative is re-broadcasting
 * a `create` that may already have minted the user's token, and a launch is
 * irreversible and costs real funds. The launch identity repair
 * (`sync/launch-identity-repair.ts`) is what eventually resolves these rows.
 *
 * `failureReason` is a STRUCTURAL-ONLY label (`ErrorKind:errorHash`). Raw RPC
 * and provider errors carry URLs, request bodies, addresses and auth headers;
 * they must never reach that column.
 *
 * ── The §C3b continuation (Lane F consumes this) ───────────────────────────
 *
 * `agent_requested_form` is the ONE path where an agent's turn is parked, so it
 * is the one path that carries `toolCallId` (the ORIGINAL parked
 * `trench.launch_request_form` call), `missionRunId`, and eventually
 * `resultMessageId`. A `user`-origin launch resumes NOTHING and an `agent`
 * (Path 2) launch never parked; requiring those of either would make an honest
 * row unwritable, so the DB CHECK scopes the requirement to that origin alone.
 *
 * `stampResultMessageWith` is the `stamp` callback for Lane F's
 * `commitUserFormToolResult`: it runs on the SAME transaction that appends the
 * tool-result row, so "the turn resumed but no tool result exists" is
 * unrepresentable and a throwing stamp rolls the transcript row back with it.
 *
 * NOTE ON NAMES — two different vocabularies, deliberately: `awaiting_user_form`
 * is this INTENT's status, while `paused_user_form` is the RUN's status in the
 * engine (Lane F). They describe different rows on different tables and are not
 * drift; do not "reconcile" them into one word.
 */

export type {
  AuthorizeTokenLaunchInput,
} from "./token-launch-intents/writers.js";
export type {
  CreateTokenLaunchIntentInput,
  LaunchAuthorizationKind,
  TokenLaunchIntent,
  TokenLaunchIntentOrigin,
  TokenLaunchIntentStatus,
} from "./token-launch-intents/types.js";

export { LIVE_TOKEN_LAUNCH_INTENT_STATUSES } from "./token-launch-intents/types.js";

export {
  authorizeWith,
  cancelIfAwaitingWith,
  confirmWith,
  consumeIfAuthorizedWith,
  createWith,
  expireIfAwaitingWith,
  failWith,
  markBroadcastPendingWith,
  stampResultMessageWith,
} from "./token-launch-intents/writers.js";

export {
  getAwaitingForSession,
  getById,
  listOutstandingUserFormResumes,
  listOverdueAwaitingForms,
} from "./token-launch-intents/reads.js";

// The identity sweep's fair, self-rotating candidate claim (a read AND a
// scheduling stamp — see the module for the starvation it fixes).
export { claimBroadcastPendingForSweep } from "./token-launch-intents/sweep-claim.js";
