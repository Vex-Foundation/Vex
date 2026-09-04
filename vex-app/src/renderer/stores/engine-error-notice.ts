/**
 * ONE projection of an `EngineErrorEvent` onto what a person reads.
 *
 * Two surfaces render engine failures and they used to hold two copies of the
 * same three helpers: a scope label, a bounded technical trailer, and the
 * decision about which action hint wins. The global one drifted into a pill
 * with a popover that announced nothing at all, and the identical
 * `codeTrailer` sat in both files. This module is the single owner, and the
 * global popover is gone entirely - session-less failures are notifications
 * now, which is a surface that already knows how to announce, retain, bound
 * and report itself.
 *
 * Copy still comes from `shared/engine-error-copy.ts`: the classifier's
 * category table is the source, and nothing here invents a sentence for a
 * failure. What lives here is FRAMING - whose failure it is - which is a
 * renderer concern and has no meaning in main.
 */

import {
  engineErrorCopy,
  engineErrorRemedyHint,
  engineErrorRetryHint,
} from "@shared/engine-error-copy.js";
import type { EngineErrorEvent } from "@shared/schemas/engine-error.js";
import type { NotificationInput } from "../lib/notifications/types.js";

/**
 * What failed, in system terms, for a SESSION-LESS event. No scope reaching
 * here is ever session-scoped, so nothing here may say "your session".
 */
const GLOBAL_SCOPE_LABEL: Partial<Record<EngineErrorEvent["scope"], string>> = {
  memory: "Memory maintenance",
  compact: "Background compaction",
  wake: "Scheduled wake",
};

/**
 * What failed, in the user's terms, for a SESSION-scoped event.
 *
 * `memory` is EXCLUDED at the type level, not merely unlisted. Memory
 * maintenance always arrives session-less and the session path ignores
 * null-session events by contract, so a memory scope reaching there would mean
 * the routing broke. Stating that as `Exclude<...>` keeps the map exhaustive
 * over the scopes that CAN arrive - a new session-scoped scope still fails to
 * compile - without inventing session copy for a failure that owns no session.
 */
type SessionScope = Exclude<EngineErrorEvent["scope"], "memory">;

const SESSION_SCOPE_LABEL: Readonly<Record<SessionScope, string>> = {
  turn: "This turn failed",
  mission: "The mission run failed",
  wake: "A scheduled wake failed",
  compact: "A background job failed",
  approval: "Resuming after your decision failed",
};

/** Session framing. Total: the unreachable `memory` arm degrades to neutral. */
export function sessionScopeLabel(scope: EngineErrorEvent["scope"]): string {
  return scope === "memory" ? "Background work failed" : SESSION_SCOPE_LABEL[scope];
}

/** System framing, for a failure that belongs to no conversation. */
export function globalScopeLabel(scope: EngineErrorEvent["scope"]): string {
  return GLOBAL_SCOPE_LABEL[scope] ?? "Background work";
}

/**
 * Bounded technical codes for a bug report. Only fields the event actually
 * carried appear, so the trailer is empty rather than a row of "null" when the
 * provider told us nothing.
 */
export function engineErrorCodeTrailer(event: EngineErrorEvent): string | null {
  const parts = [
    event.errorType,
    event.errorClass,
    event.statusCode === null ? null : `HTTP ${event.statusCode}`,
    event.causeCode,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * The ACTION line: when the classifier names the one thing that clears the
 * failure it replaces the generic retry advice - but a provider-stamped
 * "Retry in Ns" is more precise than any remedy phrase, so an explicit
 * retry-after always wins.
 */
export function engineErrorActionHint(event: EngineErrorEvent): string | null {
  if (event.retryAfterSeconds !== null) {
    return engineErrorRetryHint(event.category, event.retryAfterSeconds);
  }
  return (
    engineErrorRemedyHint(event.remedy) ??
    engineErrorRetryHint(event.category, null)
  );
}

/**
 * The dedup identity for a session's failure.
 *
 * A failing turn produces a BURST (turn fails, mission finalizes, resume
 * fails) and a growing column of near-identical rows would bury the one thing
 * the user has to read. One row per session, newest wins - the same claim the
 * session partition of the store makes, expressed to the model so both agree.
 */
export function sessionNotificationId(sessionId: string): string {
  return `engine-error:session:${sessionId}`;
}

/**
 * Raise-ready input for a SESSION-LESS failure.
 *
 * Session-less failures are independent jobs, not one story retold, so they
 * carry no dedup identity: two memory jobs that die a second apart are two
 * failures and both must surface. The model's retention cap bounds them and
 * reports what it evicted, which is the bound the old five-entry list had
 * without the report.
 */
export function globalEngineErrorNotification(
  event: EngineErrorEvent,
): NotificationInput {
  const copy = engineErrorCopy(event.category);
  const codes = engineErrorCodeTrailer(event);
  return {
    severity: "error",
    scope: { kind: "global" },
    source: "engine",
    title: `${globalScopeLabel(event.scope)} - ${copy.title}`,
    // The sanitized detail and the bounded codes travel WITH the sentence:
    // the center is one compact row per notification, and dropping them here
    // would lose exactly what a user quotes in a bug report - which the
    // retired popover did show.
    message: [copy.body, event.detail, codes]
      .filter((part): part is string => part !== null && part !== "")
      .join(" "),
    ...(event.correlationId === null ? {} : { correlationId: event.correlationId }),
  };
}

/**
 * Raise-ready input for a SESSION-scoped failure.
 *
 * The detail, the action hint and the codes are deliberately NOT folded into
 * this message: the session card above the composer is the contextual surface
 * that renders all of them in their own registers, and this notification is
 * the app-wide "something failed in that session" signal. The card is the
 * place to read it; this is the place to notice it.
 */
export function sessionEngineErrorNotification(
  event: EngineErrorEvent,
  sessionId: string,
): NotificationInput {
  const copy = engineErrorCopy(event.category);
  return {
    id: sessionNotificationId(sessionId),
    severity: "error",
    scope: { kind: "session", sessionId },
    source: "engine",
    title: `${sessionScopeLabel(event.scope)} - ${copy.title}`,
    message: copy.body,
    ...(event.correlationId === null ? {} : { correlationId: event.correlationId }),
  };
}
