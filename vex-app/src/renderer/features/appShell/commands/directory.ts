/**
 * Composer slash-command directory (B12): the registry of every command the
 * "/" menu offers, plus the pure filter the menu renders from. A command's
 * `run` receives the capability surface the composer injects and returns
 * the toast text to show, or null when the command opened its own surface.
 */

export interface ComposerCommandContext {
  readonly sessionId: string | null;
  /** Whether the active session carries an enabled legacy Plan Mode plan. */
  readonly hasLegacyPlan: boolean;
  readonly clearDraft: () => void;
  /** Opens `PlanDisplayModal`; only called when `hasLegacyPlan` is true. */
  readonly openPlan: () => void;
  /** Opens the session export dialog; only called with an active session. */
  readonly openExport: () => void;
  /** Flips the theme preference; returns the resolved theme's display name. */
  readonly toggleTheme: () => string;
}

export interface ComposerCommand {
  readonly id: string;
  /** The token as typed, slash included. */
  readonly label: string;
  readonly description: string;
  readonly run: (context: ComposerCommandContext) => string | null;
}

export const COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  {
    id: "plan",
    label: "/plan",
    description: "Review this session's legacy action plan",
    run: (context) => {
      if (!context.hasLegacyPlan) {
        return "This session has no legacy plan to review.";
      }
      context.openPlan();
      return null;
    },
  },
  {
    id: "export",
    label: "/export",
    description: "Export this session's transcript",
    run: (context) => {
      if (context.sessionId === null) {
        return "Open a session to export its transcript.";
      }
      context.openExport();
      return null;
    },
  },
  {
    id: "clear-draft",
    label: "/clear-draft",
    description: "Discard the current draft",
    run: (context) => {
      context.clearDraft();
      return "Draft cleared.";
    },
  },
  {
    id: "theme",
    label: "/theme",
    description: "Switch between the dark and light theme",
    run: (context) => `Theme: ${context.toggleTheme()}.`,
  },
  {
    id: "help",
    label: "/help",
    description: "List the available commands",
    run: () =>
      `Commands: ${COMPOSER_COMMANDS.map((command) => command.label).join(", ")}`,
  },
];

/**
 * Case-insensitive prefix filter over command names; an empty query returns
 * the full roster in registry order.
 */
export function filterComposerCommands(
  query: string,
): readonly ComposerCommand[] {
  const needle = query.toLowerCase();
  return COMPOSER_COMMANDS.filter((command) =>
    command.id.toLowerCase().startsWith(needle),
  );
}
