import { describe, expect, it } from "vitest";

import { resolveRuntimeMode } from "../runtime-mode.js";

describe("runtime mode", () => {
  it("runs the bundled native runtime", () => {
    expect(resolveRuntimeMode({ connectionAlreadyPublished: false })).toBe("native");
  });

  it("never displaces a database the e2e door already published", () => {
    expect(resolveRuntimeMode({ connectionAlreadyPublished: true })).toBe("e2e_door");
  });
});
