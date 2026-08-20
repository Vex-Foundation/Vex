/**
 * Decision-table pins for `resolveWizardEntry` — the ONE launch/wizard
 * routing table shared by WizardShell and the setup orchestrator
 * (Chronos Gate PR1). These cases are a characterization of the
 * pre-extraction WizardShell effect logic; changing any row is a
 * behavior change, not a refactor.
 */

import { describe, expect, it } from "vitest";
import type { WizardState, WizardStepId } from "@shared/schemas/wizard.js";
import { resolveWizardEntry } from "../wizard-entry.js";

function state(args: {
  readonly completed: boolean;
  readonly currentStepId?: WizardStepId;
  readonly completedSteps?: ReadonlyArray<WizardStepId>;
}): WizardState {
  return {
    schemaVersion: 2,
    currentStepId: args.currentStepId ?? "keystore",
    completedSteps: args.completedSteps ?? [],
    completed: args.completed,
  } as WizardState;
}

const COMPLETED = state({
  completed: true,
  currentStepId: "review",
  completedSteps: [
    "keystore",
    "wallets",
    "apiKeys",
    "embedding",
    "agentCore",
    "provider",
  ],
});

describe("resolveWizardEntry - completed setup", () => {
  it("locked vault routes to unlock, resuming to appShell", () => {
    expect(
      resolveWizardEntry({
        persisted: COMPLETED,
        vaultConfigured: true,
        unlocked: false,
        entryMode: "setup",
      }),
    ).toEqual({ kind: "unlock", returnView: "appShell" });
  });

  it("missing vault re-runs keystore (repair path)", () => {
    expect(
      resolveWizardEntry({
        persisted: COMPLETED,
        vaultConfigured: false,
        unlocked: false,
        entryMode: "setup",
      }),
    ).toEqual({ kind: "step", stepId: "keystore" });
  });

  it("unlocked vault goes straight to the shell", () => {
    expect(
      resolveWizardEntry({
        persisted: COMPLETED,
        vaultConfigured: true,
        unlocked: true,
        entryMode: "setup",
      }),
    ).toEqual({ kind: "appShell" });
  });
});

describe("resolveWizardEntry - mid-setup", () => {
  it("past keystore with a locked vault unlocks first, resuming to wizard", () => {
    expect(
      resolveWizardEntry({
        persisted: state({
          completed: false,
          currentStepId: "apiKeys",
          completedSteps: ["keystore", "wallets"],
        }),
        vaultConfigured: true,
        unlocked: false,
        entryMode: "setup",
      }),
    ).toEqual({ kind: "unlock", returnView: "wizard" });
  });

  it("on keystore (no vault yet) resumes the keystore step directly", () => {
    expect(
      resolveWizardEntry({
        persisted: state({ completed: false, currentStepId: "keystore" }),
        vaultConfigured: false,
        unlocked: false,
        entryMode: "setup",
      }),
    ).toEqual({ kind: "step", stepId: "keystore" });
  });

  it("past keystore with the vault already unlocked resumes the persisted step", () => {
    expect(
      resolveWizardEntry({
        persisted: state({
          completed: false,
          currentStepId: "provider",
          completedSteps: [
            "keystore",
            "wallets",
            "apiKeys",
            "embedding",
            "agentCore",
          ],
        }),
        vaultConfigured: true,
        unlocked: true,
        entryMode: "setup",
      }),
    ).toEqual({ kind: "step", stepId: "provider" });
  });
});
