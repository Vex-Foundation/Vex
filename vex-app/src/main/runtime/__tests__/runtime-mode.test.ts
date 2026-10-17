import { describe, expect, it } from "vitest";

import { resolveRuntimeMode } from "../runtime-mode.js";

describe("runtime mode", () => {
  it("defaults to the compose provider", () => {
    expect(resolveRuntimeMode({ env: {}, connectionAlreadyPublished: false })).toBe("docker");
    expect(resolveRuntimeMode({ env: { VEX_RUNTIME: "Native" }, connectionAlreadyPublished: false })).toBe("docker");
  });

  it("is native only on the exact opt-in", () => {
    expect(resolveRuntimeMode({ env: { VEX_RUNTIME: "native" }, connectionAlreadyPublished: false })).toBe("native");
  });

  it("never displaces a database the e2e door already published", () => {
    expect(resolveRuntimeMode({ env: { VEX_RUNTIME: "native" }, connectionAlreadyPublished: true })).toBe("docker");
  });
});
