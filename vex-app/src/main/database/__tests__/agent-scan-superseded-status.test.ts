/**
 * A FOURTH STORED STATUS, AND THE TWO SURFACES THAT WOULD HAVE SWALLOWED IT.
 *
 * `superseded_unproven` (engine migration 068, owner decision A6) is a
 * NON-FAILURE terminal state: the hash is no longer tracked as in flight and its
 * inclusion outcome is unproven. `vex-app` does not speak the database's
 * vocabulary — it has its own collapsed union and translates in both directions
 * — so a new stored value fails in two different silent ways:
 *
 * 1. **The status FILTER expands the other way** from the SELECT. A filter value
 *    with no translation matches zero rows forever, and the page looks empty
 *    rather than broken.
 * 2. **Token History FAILS CLOSED to `null`** on an unrecognized status, so the
 *    row silently loses its status instead of erroring where someone would see
 *    it.
 *
 * And the money rule that must survive both: a row whose amounts were NEVER
 * PROVEN renders NO executed and NO requested amount. Showing the quote here
 * would be the quote-as-settlement error rule 90 exists to forbid — the row is
 * terminal, and nothing about its amounts is known.
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_ACTIVITY_STATUSES,
  isAgentActivityStatus,
} from "../../../shared/agent-activity-vocabulary.js";
import { agentScanStatusFilterSchema } from "../../../shared/schemas/agent-scan-feed.js";
import {
  resolveAgentActivityAmount,
  resolveAmountWithEstimateBasis,
} from "../agent-activity-amount.js";

const SUPERSEDED = "superseded_unproven";

describe("the renderer vocabulary carries it as its OWN member", () => {
  it("is a known status, and is NOT collapsed into failed", () => {
    expect(AGENT_ACTIVITY_STATUSES).toContain(SUPERSEDED);
    expect(isAgentActivityStatus(SUPERSEDED)).toBe(true);
  });

  it("is filterable — a filter value with no translation would match zero rows forever", () => {
    expect(agentScanStatusFilterSchema.safeParse(SUPERSEDED).success).toBe(true);
  });
});

describe("its amounts were never proven, so none are rendered", () => {
  it("shows no swap-leg amount, executed or requested", () => {
    expect(resolveAgentActivityAmount(SUPERSEDED, "10.0", "10000000", 6)).toBeNull();
  });

  it("shows no amount and no basis — never the quote as a settlement", () => {
    expect(resolveAmountWithEstimateBasis(SUPERSEDED, "10.0", "10000000", 6)).toEqual({
      value: null,
      basis: null,
    });
  });
});
