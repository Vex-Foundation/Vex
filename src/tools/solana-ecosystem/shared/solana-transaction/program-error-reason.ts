/**
 * Recover the on-chain program's OWN failure text from a rejected Solana
 * submit, so the agent is told why the program refused instead of a hex code
 * it cannot decode.
 *
 * WHY THIS EXISTS. `@solana/web3.js` formats a `SendTransactionError` for
 * humans, not for machines:
 *
 *     Simulation failed.
 *     Message: Transaction simulation failed: Error processing Instruction 0:
 *     custom program error: 0x1773.
 *     Logs: [ …JSON array of the last 10 program logs… ].
 *     Catch the `SendTransactionError` and call `getLogs()` on it for full details.
 *
 * That message is then run through `summarizeProtocolError` (the repo's scrub
 * boundary), which replaces the balanced `[…]` span with `[body]` — deleting
 * the ONLY place the program's own error NAME appeared — and spends the 200-
 * char cap on a JavaScript instruction the agent cannot act on. The agent ends
 * up holding a bare `0x1773`, and nothing in this repository decodes Anchor
 * error numbers. Meanwhile the structured logs survive untouched on the error
 * object and were never read.
 *
 * WHAT THIS MODULE DOES. It reads those already-attached logs and lifts the
 * PROGRAM'S OWN sentence out of them. It never invents text, never maps a code
 * to a message we authored, and never hardcodes a provider limit — a constant
 * we invent goes stale silently, the program's emitted message does not. When
 * no program-authored line exists the caller degrades to exactly the behaviour
 * it had before.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never calls `SendTransactionError#getLogs()`
 * — that method performs a `getTransaction` RPC round-trip, and this runs on an
 * error path where the caller has already decided what to tell the agent. Only
 * logs the node ALREADY returned with the rejection are read.
 *
 * The recovered text is still provider/chain-controlled input: callers must
 * pass it through `summarizeProtocolError` before it reaches tool output, logs,
 * or the renderer, exactly as they do for the raw throw.
 */

import { SendTransactionError } from "@solana/web3.js";

/**
 * Anchor logs a failed constraint/`require!` through `msg!`, so the line always
 * carries the runtime's `Program log:` prefix, and puts its human sentence last:
 *
 *   `Program log: AnchorError occurred. Error Code: FTokenDepositInsignificant.`
 *   `Error Number: 6003. Error Message: Deposit amount is too small.`
 *   `Program log: AnchorError caused by account: vault. Error Code: … Error Message: …`
 *   `Program log: Error Message: <text>`   (the plainer form)
 *
 * Requiring the `Program log:` prefix keeps this from matching runtime-authored
 * lines (`Program … failed: custom program error: 0x…`), which carry no
 * sentence. `Error Message:` is the last field in every documented form, so the
 * capture runs to end-of-line.
 */
const PROGRAM_LOG_ERROR_MESSAGE = /^Program log:.*\bError Message:\s*(.+?)\s*$/;

/**
 * The first program-authored `Error Message:` sentence in `logs`, or undefined.
 *
 * FIRST, not last: with a CPI the inner program logs its error before the outer
 * program reacts to it, so the earliest line is the root cause.
 */
export function extractProgramErrorMessage(
  logs: readonly string[] | undefined,
): string | undefined {
  if (!logs) return undefined;
  for (const line of logs) {
    const captured = PROGRAM_LOG_ERROR_MESSAGE.exec(line)?.[1]?.trim();
    if (captured) return captured;
  }
  return undefined;
}

/**
 * The program's own reason for a rejected submit, or undefined when the throw
 * is not a program rejection or carried no program-authored sentence (a
 * signature-verification refusal, a JSON-RPC transport error, a non-Anchor
 * program). Undefined means "keep telling the agent what you told it before".
 *
 * `transactionError` is the public, synchronous accessor for the logs the node
 * already returned; it yields `undefined` rather than a promise, so no network
 * call can be triggered from this error path.
 */
export function solanaProgramErrorReason(err: unknown): string | undefined {
  if (!(err instanceof SendTransactionError)) return undefined;
  return extractProgramErrorMessage(err.transactionError.logs);
}
