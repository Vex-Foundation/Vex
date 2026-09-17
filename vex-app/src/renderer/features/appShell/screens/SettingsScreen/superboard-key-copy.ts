import type { ShareTokenFailure } from "@shared/schemas/superboard-key.js";

/**
 * Where a failed attempt happened: the first link of this install's key, or a
 * rotation to a new key. The rotation context always has a working key to
 * fall back on, which is what its reassurance says; the link context reassures
 * only when the key itself was never judged (transport, 5xx, rate limit,
 * malformed answer).
 */
export type SuperboardFailureContext = "link" | "rotation";

export interface SuperboardFailureCopy {
  /** The sentence the status row announces. Never parsed, only displayed. */
  readonly primary: string;
  /**
   * What the user can rely on next, or null when the primary sentence already
   * says everything (a refused key has nothing to reassure about). Names no
   * control that does not exist.
   */
  readonly reassurance: string | null;
}

const LINK_KEY_VALID = "Your key is valid; only the link to AgentScan is missing.";
const ROTATION_KEY_WORKS = "Your current key still works.";
/**
 * A rotation whose answer was lost (timeout, unknown transport failure) may
 * already have been applied server-side, which kills the old key for
 * Superboard; "still works" would be a promise nobody can keep.
 */
const ROTATION_OUTCOME_UNKNOWN =
  "Your current key may already be replaced. Retry sends the same new key again.";
const AUTH_LOST_REASSURANCE =
  "Vex links to AgentScan on its own once the vault is unlocked. Wait a minute, then retry.";
const CONSENT_REVOKED_REASSURANCE =
  "This install's access was revoked on the AgentScan side; share the ref below when asking for help.";
const QUARANTINED_REASSURANCE =
  "Reporting from this install was paused on the AgentScan side; share the ref below when asking for help.";

/** The rows whose reassurance depends only on the context, not on the kind. */
function contextualReassurance(context: SuperboardFailureContext): string {
  return context === "rotation" ? ROTATION_KEY_WORKS : LINK_KEY_VALID;
}

export function superboardFailureCopy(
  failure: ShareTokenFailure,
  context: SuperboardFailureContext,
): SuperboardFailureCopy {
  switch (failure.kind) {
    case "http":
      if (failure.status < 500) {
        return context === "rotation"
          ? { primary: "AgentScan refused the new key.", reassurance: ROTATION_KEY_WORKS }
          : { primary: "AgentScan refused this key.", reassurance: null };
      }
      return { primary: "AgentScan had a problem.", reassurance: contextualReassurance(context) };
    case "transport":
      switch (failure.reason) {
        case "timeout":
          return {
            primary: "AgentScan didn't answer in time.",
            reassurance: context === "rotation" ? ROTATION_OUTCOME_UNKNOWN : LINK_KEY_VALID,
          };
        case "network":
          return { primary: "Couldn't reach AgentScan.", reassurance: contextualReassurance(context) };
        case "unknown":
          return {
            primary: "Couldn't reach AgentScan.",
            reassurance: context === "rotation" ? ROTATION_OUTCOME_UNKNOWN : LINK_KEY_VALID,
          };
        case "redirect":
          return {
            primary: "The connection was redirected.",
            reassurance: contextualReassurance(context),
          };
      }
      break;
    case "malformed_response":
      return {
        primary: "AgentScan answered unexpectedly.",
        reassurance: contextualReassurance(context),
      };
    case "rate_limited":
      return {
        primary: "Too many attempts. Wait a moment and try again.",
        reassurance: contextualReassurance(context),
      };
    case "conflict":
      return context === "rotation"
        ? {
          primary: "The new key couldn't be linked.",
          reassurance:
              "Your current key still works. AgentScan holds a key this app doesn't know; share the ref below when asking for help.",
        }
        : {
          primary: "This key couldn't be linked.",
          reassurance:
            "AgentScan already holds a different key for this install. Retrying resends this same key; share the ref below when asking for help.",
        };
    case "auth_lost":
      return context === "rotation"
        ? {
          primary: "AgentScan isn't connected. The new key waits until it's linked.",
          reassurance: AUTH_LOST_REASSURANCE,
        }
        : {
          primary: "AgentScan isn't connected. Try again after it's linked.",
          reassurance: AUTH_LOST_REASSURANCE,
        };
    case "stopped":
      return failure.reason === "consent_revoked"
        ? { primary: "AgentScan access was revoked.", reassurance: CONSENT_REVOKED_REASSURANCE }
        : { primary: "AgentScan paused this install.", reassurance: QUARANTINED_REASSURANCE };
  }
}
