/**
 * Which host draws a step form (docs/design/R3-MINIMAL.md sections 9.6 and
 * 10.3). The seven step forms render in two places:
 *
 *   wizard    the setup wizard's frame (`WizardShell`): the serif title, the
 *             lead, and a footer at the window's foot with the privacy link
 *             and the step's actions. The shell provides this context, with
 *             what stands above the step's title (`before`: the small vx mark
 *             and Vex's word under 1180, the "Step N of 7 · {name}" line, and
 *             on Review's edit path the editing row).
 *   settings  a Settings section: the section head (the title 22 / 500 with
 *             the section's status word), the actions at the right.
 *
 * Without a provider the flow decides: `back-edit` is Settings (the only
 * host that mounts a step outside the wizard), `first-pass` is the wizard.
 */

import { createContext, useContext, type ReactNode } from "react";

import type { WizardFlowMode } from "../../lib/api/wizard.js";

export type WizardHost = "wizard" | "settings";

export interface WizardHostValue {
  readonly host: WizardHost;
  /** Wizard: what stands above the step's title. */
  readonly before?: ReactNode;
  /**
   * Wizard: back one step (steps 2 to 7, the mockups' footer key). Absent on
   * the first step, on Review's edit path (it has "Return to review") and in
   * Settings. Going back saves nothing and undoes nothing: the step shown
   * again keeps what was entered, and moving on still runs its own checks.
   */
  readonly onBack?: () => void;
}

export const WizardHostContext = createContext<WizardHostValue | null>(null);

/** The host a step form renders in, and what stands above its title. */
export function useWizardHost(flowMode: WizardFlowMode): WizardHostValue {
  const value = useContext(WizardHostContext);
  if (value !== null) return value;
  return { host: flowMode === "back-edit" ? "settings" : "wizard" };
}
