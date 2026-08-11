/**
 * `exposeAppVersionToEngine` — the only way `process.env.VEX_APP_VERSION`
 * gets set for the in-process engine (`buildProductionAgentscanReporterDeps`
 * reads it for the AgentScan register call's optional `appVersion` field).
 * Pins the two contract facts: it stamps the packaged app's version when
 * unset, and a developer's pre-existing non-empty override always wins.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "1.2.3",
  },
}));

const { exposeAppVersionToEngine } = await import("../engine-env.js");

const ORIGINAL_VEX_APP_VERSION = process.env.VEX_APP_VERSION;

beforeEach(() => {
  delete process.env.VEX_APP_VERSION;
});

afterEach(() => {
  if (ORIGINAL_VEX_APP_VERSION === undefined) {
    delete process.env.VEX_APP_VERSION;
  } else {
    process.env.VEX_APP_VERSION = ORIGINAL_VEX_APP_VERSION;
  }
});

describe("exposeAppVersionToEngine", () => {
  it("sets VEX_APP_VERSION from app.getVersion() when unset", () => {
    exposeAppVersionToEngine();

    expect(process.env.VEX_APP_VERSION).toBe("1.2.3");
  });

  it("preserves a pre-existing non-empty value — developer override wins", () => {
    process.env.VEX_APP_VERSION = "9.9.9-dev";

    exposeAppVersionToEngine();

    expect(process.env.VEX_APP_VERSION).toBe("9.9.9-dev");
  });

  it("overwrites an empty-string value", () => {
    process.env.VEX_APP_VERSION = "";

    exposeAppVersionToEngine();

    expect(process.env.VEX_APP_VERSION).toBe("1.2.3");
  });
});
