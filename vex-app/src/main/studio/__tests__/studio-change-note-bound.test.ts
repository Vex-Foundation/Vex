/**
 * THE CHANGE-NOTE SUMMARY FITS ITS COLUMN, measured against the LIVE registry.
 *
 * `summarizeRun` names every file a run touched. It used to name four and then
 * say "and N more file(s)", which is a truncation with no retrieval path: the
 * note IS the durable record, so a path it drops is a path nobody can recover.
 * Listing all of them is only safe because the roster is CLOSED - one config
 * path per writable agent, plus the four instruction files - and the longest
 * possible line still fits `project_change_notes.summary`.
 *
 * "Still fits" is the part that rots. A single agent with a long config path,
 * added a year from now, could push the worst case over the column's CHECK and
 * the failure would be an INSERT throwing in front of a user, after their files
 * had already been rewritten. So the bound is re-measured here from the
 * registry itself rather than trusted from the day it was computed.
 */

import { describe, expect, it } from "vitest";

import {
  STUDIO_AGENT_LIST,
  isWritableStudioAgent,
} from "@vex-agent/studio/agents.js";
import {
  STUDIO_CLAUDE_MD_PATH,
  STUDIO_PROTOCOLS_DOC_PATH,
  STUDIO_VEX_GUIDE_PATH,
} from "@vex-agent/studio/installer/render/index.js";
import { STUDIO_AGENTS_MD_RELATIVE_PATH } from "../installer/plan.js";

/**
 * `project_change_notes.summary TEXT NOT NULL CHECK (char_length(summary)
 * BETWEEN 1 AND 400)` - migration 089. Restated here because this test's whole
 * job is to fail when the code outgrows that number.
 */
const SUMMARY_MAX_CHARS = 400;

/** The longest prefix `summarizeRun` can emit. */
const LONGEST_PREFIX = "repaired";

describe("the change-note summary bound", () => {
  const everyPath = [
    ...STUDIO_AGENT_LIST.filter(isWritableStudioAgent).map((agent) => agent.configPath),
    STUDIO_AGENTS_MD_RELATIVE_PATH,
    STUDIO_VEX_GUIDE_PATH,
    STUDIO_CLAUDE_MD_PATH,
    STUDIO_PROTOCOLS_DOC_PATH,
  ];

  it("fits the column even when every artifact in the roster is touched", () => {
    // The exact shape `summarizeRun` builds: prefix, space, comma-joined paths.
    const worstCase = `${LONGEST_PREFIX} ${everyPath.join(", ")}`;

    expect(
      worstCase.length,
      `the worst-case change note is ${String(worstCase.length)} characters, over the `
        + `${String(SUMMARY_MAX_CHARS)}-character column bound. Either shorten a config `
        + "path or give the summary a real retrieval path - do NOT reintroduce a "
        + "silent \"and N more\" cut.",
    ).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it("covers the whole roster, so the measurement cannot silently shrink", () => {
    // Guards the guard: if the roster stopped being enumerable here, the test
    // above would keep passing while measuring nothing.
    expect(everyPath.length).toBeGreaterThanOrEqual(
      STUDIO_AGENT_LIST.filter(isWritableStudioAgent).length,
    );
    expect(new Set(everyPath).size).toBe(everyPath.length);
  });
});
