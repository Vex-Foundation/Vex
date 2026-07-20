/**
 * Shared mission-result test fixtures.
 *
 * `MissionResultDto` gained the accepted-contract block (goal, title,
 * constraints) when the summary card started reporting what was ASKED as well
 * as what happened. Four suites build their own ledger rows, and every one of
 * them needs the same "operator set no limits" default — so it lives here
 * rather than being copy-pasted into each, where the copies would drift the
 * next time the DTO grows.
 *
 * Not a `.test.ts` file, so vitest collects it as a module, not a suite.
 */

import type { MissionConstraintFacts } from "@shared/schemas/mission.js";

/**
 * A mission with NO operator-set limits — every chip absent. The card must
 * render zero constraint chips for this, never a default.
 */
export const NO_CONSTRAINTS: MissionConstraintFacts = {
  maxSpendUsd: null,
  maxLossUsd: null,
  maxIterations: null,
  deadlineAt: null,
  allowedChains: [],
  allowedProtocols: [],
};
