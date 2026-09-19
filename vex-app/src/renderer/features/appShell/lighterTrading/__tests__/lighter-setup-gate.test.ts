import { describe, expect, it } from "vitest";
import { shouldPresentLighterSetup } from "../lighter-setup-gate.js";

describe("shouldPresentLighterSetup", () => {
  it("gates the desk behind setup ONLY when the wallet has no trading key", () => {
    expect(shouldPresentLighterSetup("not_onboarded")).toBe(true);
  });

  it("does not force setup for the desk's own non-key gates or a live account", () => {
    // A locked vault is the Unlock gate, ambiguous accounts the Settings gate,
    // and a null gap means a key already exists - none is a missing key.
    expect(shouldPresentLighterSetup("locked_vault")).toBe(false);
    expect(shouldPresentLighterSetup("ambiguous_account")).toBe(false);
    expect(shouldPresentLighterSetup(null)).toBe(false);
  });
});
