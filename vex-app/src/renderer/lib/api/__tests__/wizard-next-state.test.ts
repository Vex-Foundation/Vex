/**
 * The persisted wizard state a step's save writes (`nextWizardStateFor`) and
 * the wizard's Back (`previousStepId`). After Back the user may save an
 * earlier step again: the record never moves behind the ground already
 * covered, so the schema's forward-safe rule holds and nothing done is
 * undone.
 */

import { describe, expect, it } from "vitest";
import { setWizardStateInputSchema, WIZARD_STEP_IDS } from "@shared/schemas/wizard.js";
import { nextStepId, nextWizardStateFor, previousStepId } from "../wizard.js";

describe("previousStepId", () => {
  it("is the step before, and none before the first", () => {
    expect(previousStepId("keystore")).toBeNull();
    expect(previousStepId("wallets")).toBe("keystore");
    expect(previousStepId("review")).toBe("provider");
    for (const id of WIZARD_STEP_IDS.slice(1)) {
      const before = previousStepId(id);
      expect(before === null ? null : nextStepId(before)).toBe(id);
    }
  });
});

describe("nextWizardStateFor", () => {
  it("in the first pass records the next step and the one just done", () => {
    expect(
      nextWizardStateFor({ completedSteps: ["keystore"], current: "wallets", next: "apiKeys" }),
    ).toEqual({ currentStepId: "apiKeys", completedSteps: ["keystore", "wallets"] });
  });

  it("after Back, saving an earlier step keeps the record where the user had got to", () => {
    // reached Provider (keystore to agentCore done), went back to API keys, saved it
    const done = ["keystore", "wallets", "apiKeys", "embedding", "agentCore"] as const;
    const next = nextWizardStateFor({ completedSteps: done, current: "apiKeys", next: "embedding" });
    expect(next.currentStepId).toBe("provider");
    expect(next.completedSteps).toEqual(done);
    expect(setWizardStateInputSchema.safeParse(next).success).toBe(true);
  });

  it("after Back from Review, saving any step keeps Review", () => {
    const done = ["keystore", "wallets", "apiKeys", "embedding", "agentCore", "provider"] as const;
    for (const current of done) {
      const index = WIZARD_STEP_IDS.indexOf(current);
      const forward = WIZARD_STEP_IDS[index + 1] ?? "review";
      const next = nextWizardStateFor({ completedSteps: done, current, next: forward });
      expect(next.currentStepId).toBe("review");
      expect(setWizardStateInputSchema.safeParse(next).success).toBe(true);
    }
  });

  it("one step back and forward again moves on as the first pass did", () => {
    const next = nextWizardStateFor({
      completedSteps: ["keystore", "wallets"],
      current: "wallets",
      next: "apiKeys",
    });
    expect(next).toEqual({ currentStepId: "apiKeys", completedSteps: ["keystore", "wallets"] });
  });

  it("Review's finalize still marks setup complete on Review", () => {
    const done = ["keystore", "wallets", "apiKeys", "embedding", "agentCore", "provider"] as const;
    const next = nextWizardStateFor({
      completedSteps: done,
      current: "review",
      next: "review",
      markCompleted: true,
    });
    expect(next.currentStepId).toBe("review");
    expect(next.completed).toBe(true);
    expect(setWizardStateInputSchema.safeParse(next).success).toBe(true);
  });
});
