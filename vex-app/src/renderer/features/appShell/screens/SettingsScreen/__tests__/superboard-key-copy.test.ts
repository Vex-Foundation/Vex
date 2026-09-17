import { describe, expect, it } from "vitest";
import type { ShareTokenFailure } from "@shared/schemas/superboard-key.js";
import {
  superboardFailureCopy,
  type SuperboardFailureContext,
} from "../superboard-key-copy.js";

const LINK_KEY_VALID = "Your key is valid; only the link to AgentScan is missing.";
const ROTATION_KEY_WORKS = "Your current key still works.";
const ROTATION_OUTCOME_UNKNOWN =
  "Your current key may already be replaced. Retry sends the same new key again.";
const AUTH_LOST =
  "Vex links to AgentScan on its own once the vault is unlocked. Wait a minute, then retry.";
const CONSENT_REVOKED =
  "This install's access was revoked on the AgentScan side; share the ref below when asking for help.";
const QUARANTINED =
  "Reporting from this install was paused on the AgentScan side; share the ref below when asking for help.";

interface CopyRow {
  readonly failure: ShareTokenFailure;
  readonly link: { readonly primary: string; readonly reassurance: string | null };
  readonly rotation: { readonly primary: string; readonly reassurance: string | null };
}

/** The whole copy table, one row per failure shape, both contexts side by side. */
const ROWS: ReadonlyArray<CopyRow> = [
  {
    failure: { kind: "http", status: 400, code: "validation_failed" },
    link: { primary: "AgentScan refused this key.", reassurance: null },
    rotation: { primary: "AgentScan refused the new key.", reassurance: ROTATION_KEY_WORKS },
  },
  {
    failure: { kind: "http", status: 404, code: "not_found" },
    link: { primary: "AgentScan refused this key.", reassurance: null },
    rotation: { primary: "AgentScan refused the new key.", reassurance: ROTATION_KEY_WORKS },
  },
  {
    failure: { kind: "http", status: 499, code: null },
    link: { primary: "AgentScan refused this key.", reassurance: null },
    rotation: { primary: "AgentScan refused the new key.", reassurance: ROTATION_KEY_WORKS },
  },
  {
    failure: { kind: "http", status: 500, code: "internal" },
    link: { primary: "AgentScan had a problem.", reassurance: LINK_KEY_VALID },
    rotation: { primary: "AgentScan had a problem.", reassurance: ROTATION_KEY_WORKS },
  },
  {
    failure: { kind: "http", status: 503, code: null },
    link: { primary: "AgentScan had a problem.", reassurance: LINK_KEY_VALID },
    rotation: { primary: "AgentScan had a problem.", reassurance: ROTATION_KEY_WORKS },
  },
  {
    failure: { kind: "transport", reason: "timeout" },
    link: { primary: "AgentScan didn't answer in time.", reassurance: LINK_KEY_VALID },
    rotation: { primary: "AgentScan didn't answer in time.", reassurance: ROTATION_OUTCOME_UNKNOWN },
  },
  {
    failure: { kind: "transport", reason: "network" },
    link: { primary: "Couldn't reach AgentScan.", reassurance: LINK_KEY_VALID },
    rotation: { primary: "Couldn't reach AgentScan.", reassurance: ROTATION_KEY_WORKS },
  },
  {
    failure: { kind: "transport", reason: "redirect" },
    link: { primary: "The connection was redirected.", reassurance: LINK_KEY_VALID },
    rotation: { primary: "The connection was redirected.", reassurance: ROTATION_KEY_WORKS },
  },
  {
    failure: { kind: "transport", reason: "unknown" },
    link: { primary: "Couldn't reach AgentScan.", reassurance: LINK_KEY_VALID },
    rotation: { primary: "Couldn't reach AgentScan.", reassurance: ROTATION_OUTCOME_UNKNOWN },
  },
  {
    failure: { kind: "malformed_response" },
    link: { primary: "AgentScan answered unexpectedly.", reassurance: LINK_KEY_VALID },
    rotation: { primary: "AgentScan answered unexpectedly.", reassurance: ROTATION_KEY_WORKS },
  },
  {
    failure: { kind: "rate_limited", retryAfterSeconds: 12 },
    link: {
      primary: "Too many attempts. Wait a moment and try again.",
      reassurance: LINK_KEY_VALID,
    },
    rotation: {
      primary: "Too many attempts. Wait a moment and try again.",
      reassurance: ROTATION_KEY_WORKS,
    },
  },
  {
    failure: { kind: "rate_limited", retryAfterSeconds: null },
    link: {
      primary: "Too many attempts. Wait a moment and try again.",
      reassurance: LINK_KEY_VALID,
    },
    rotation: {
      primary: "Too many attempts. Wait a moment and try again.",
      reassurance: ROTATION_KEY_WORKS,
    },
  },
  {
    failure: { kind: "conflict" },
    link: {
      primary: "This key couldn't be linked.",
      reassurance:
        "AgentScan already holds a different key for this install. Retrying resends this same key; share the ref below when asking for help.",
    },
    rotation: {
      primary: "The new key couldn't be linked.",
      reassurance:
        "Your current key still works. AgentScan holds a key this app doesn't know; share the ref below when asking for help.",
    },
  },
  {
    failure: { kind: "auth_lost" },
    link: {
      primary: "AgentScan isn't connected. Try again after it's linked.",
      reassurance: AUTH_LOST,
    },
    rotation: {
      primary: "AgentScan isn't connected. The new key waits until it's linked.",
      reassurance: AUTH_LOST,
    },
  },
  {
    failure: { kind: "stopped", reason: "consent_revoked" },
    link: { primary: "AgentScan access was revoked.", reassurance: CONSENT_REVOKED },
    rotation: { primary: "AgentScan access was revoked.", reassurance: CONSENT_REVOKED },
  },
  {
    failure: { kind: "stopped", reason: "quarantined" },
    link: { primary: "AgentScan paused this install.", reassurance: QUARANTINED },
    rotation: { primary: "AgentScan paused this install.", reassurance: QUARANTINED },
  },
];

describe("superboardFailureCopy", () => {
  it.each(ROWS)("resolves $failure in the link context", ({ failure, link }) => {
    expect(superboardFailureCopy(failure, "link")).toEqual(link);
  });

  it.each(ROWS)("resolves $failure in the rotation context", ({ failure, rotation }) => {
    expect(superboardFailureCopy(failure, "rotation")).toEqual(rotation);
  });

  it("never mentions reconnecting, generating, or funds", () => {
    const contexts = ["link", "rotation"] as const satisfies ReadonlyArray<SuperboardFailureContext>;
    for (const { failure } of ROWS) {
      for (const context of contexts) {
        const copy = superboardFailureCopy(failure, context);
        expect(copy.primary).not.toMatch(/reconnect|generate a new one|funds/i);
        expect(copy.reassurance ?? "").not.toMatch(/reconnect|generate a new one|funds/i);
      }
    }
  });
});
