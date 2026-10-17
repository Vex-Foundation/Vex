/**
 * The welcome's task rows under the composer (docs/design/R3-MINIMAL.md
 * section 7, reference d2): task-first, one line each, a blue line icon
 * leading. Pure data. A `prompt` row seeds the composer draft with its
 * full-sentence prompt (the label is what the row shows); the `mission` row
 * opens the new session form with Mission preselected, because a mission is
 * its own kind of session with a contract, not a chat message. Shown only on
 * the welcome stage, and hidden while the draft holds text.
 */

import type { LineIconName } from "../../components/icons/line/index.js";

export type QuickActionKind = "prompt" | "mission";

export interface QuickAction {
  readonly label: string;
  /** The line icon drawn before the label. */
  readonly icon: LineIconName;
  readonly kind: QuickActionKind;
  /** The draft a `prompt` row seeds; empty for the `mission` row. */
  readonly prompt: string;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    label: "Check wallet balances",
    icon: "wallet",
    kind: "prompt",
    prompt: "Check my wallet balances on every chain and show what each wallet holds.",
  },
  {
    label: "Review the market",
    icon: "strategies",
    kind: "prompt",
    prompt:
      "Review the market for me: what is moving right now, why, and what it means for my holdings.",
  },
  {
    label: "Create a mission",
    icon: "missions",
    kind: "mission",
    prompt: "",
  },
  {
    // The typed desk command (`isLighterWorkspaceCommand`): Send opens the
    // Lighter desk instead of a chat.
    label: "Trade perps on Lighter",
    icon: "candles",
    kind: "prompt",
    prompt: "Light it up.",
  },
];
