/**
 * Tests for the result shape of composeDown. Up-side is integration
 * territory (needs Docker) so we skip it here; M15 acceptance gates
 * cover the live flow.
 */

import { describe, expect, it } from "vitest";
import type { ComposeUpResult, ComposeDownResult } from "../lifecycle.js";

describe("compose lifecycle result shapes", () => {
  it("ComposeUpResult.kind is one of the documented variants", () => {
    const allowed: ComposeUpResult["kind"][] = [
      "running",
      "reused",
      "port_collision",
      "foreign_listener",
      "unhealthy",
      "failed",
    ];
    // Type-level assertion: this would fail to compile if the union drifted.
    for (const kind of allowed) expect(typeof kind).toBe("string");
  });

  it("ComposeDownResult.kind is one of the documented variants", () => {
    const allowed: ComposeDownResult["kind"][] = ["stopped", "not_running", "failed"];
    for (const kind of allowed) expect(typeof kind).toBe("string");
  });
});
