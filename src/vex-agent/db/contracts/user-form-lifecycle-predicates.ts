/**
 * The SQL vocabulary for "an agent turn is parked on a user form and has never
 * been answered".
 *
 * ## Why this is a contracts leaf, like its approval sibling
 *
 * Three readers need the same fact and must provably never drift:
 *
 *   - `db/repos/token-launch-intents/reads.ts` — the durable floor that finds
 *     forms whose result was never appended and resumes them;
 *   - the main-process control-state aggregate, which decides whether the
 *     operator's Stop key is available;
 *   - the transactional stop-retention read, which decides whether a committed
 *     `stop_terminal` stays OPEN for that resume to observe.
 *
 * If those disagree the failure is precise and expensive: a session whose only
 * outstanding work is a parked launch form has no run, no lease, no pending wake
 * and no approval, so every other `stoppable` fact is false. The Stop key
 * disappears, the stop request is retired as "nothing to observe it", and the
 * form's resume then runs a model turn on a session the operator stopped —
 * on the launch path, where the next thing the agent does can spend real money.
 *
 * Pure LEAF: string constants, no imports, no runtime, no repository graph, so
 * the main process can import it without pulling the engine's database layer
 * across the process seam. Copying these fragments is not allowed.
 *
 * ## Column contract
 *
 * Names `token_launch_intents` columns UNQUALIFIED, so a consumer must have that
 * table (or an alias exposing those columns) unambiguously in scope.
 */

/**
 * A turn is parked on a form and its continuation has NOT completed.
 *
 * ## `resume_consumed_at`, not `result_message_id` — the correction that matters
 *
 * This predicate used to key off `result_message_id IS NULL`, i.e. "the result
 * has not been appended yet". That is the wrong fact, and it left the exact
 * window the design exists to close. The resume appends the result, THEN claims
 * the session lease, THEN runs the turn. Keyed off the result stamp, a row
 * stopped being "outstanding" the instant the transcript was written — while
 * the turn it owes had not even been dispatched. In that gap:
 *
 *   - an operator Stop found no live lease, no approval lifecycle and no
 *     outstanding form, so it retired its own request as unobservable — and the
 *     dispatch then ran the model turn anyway;
 *   - a busy lease, a crash or a restart left a stamped row the durable scan
 *     could no longer see, so the continuation was lost permanently.
 *
 * Neither is fixable by an in-process retry: a crash has no process left to
 * retry in. The eligibility marker has to be the COMPLETION of a resumed turn,
 * exactly as `resume_consumed_at` is for the approval lifecycle.
 *
 * Two conditions, and neither is incidental:
 *
 *   - `tool_call_id IS NOT NULL` — this intent PARKED an agent turn. Only the
 *     `agent_requested_form` origin persists a tool-call id; a launch the human
 *     started themselves parks nothing and owes nothing.
 *   - `resume_consumed_at IS NULL` — no resumed turn has completed for it.
 *
 * Deliberately NOT filtered by intent status. The durable floor adds its own
 * status condition for the half that still needs a RESULT — it has nothing
 * honest to tell the model while the human can still fill the form in. This
 * predicate only REPORTS that work is owed, and a turn parked on a form the
 * user is still filling in is exactly a session the operator must be able to
 * stop.
 */
export const OUTSTANDING_USER_FORM_PREDICATE = `(
    tool_call_id        IS NOT NULL
    AND resume_consumed_at IS NULL
  )`;

/**
 * Of the outstanding rows, the ones whose RESULT is already in the transcript —
 * so all that remains is the dispatch.
 *
 * The recovery scan must tell the two halves apart. Re-appending a result for a
 * row that already has one would answer a single tool call twice; refusing to
 * act because a result exists would strand the turn that result was written
 * for. The stamp is the discriminator, and it is only ever read for that.
 */
export const USER_FORM_RESULT_ALREADY_APPENDED = "result_message_id IS NOT NULL";
