/**
 * Command directory (B12): registry contract, the prefix filter, and each
 * command's run behavior against an injected context.
 */

import { describe, expect, it, vi } from "vitest";
import {
  COMPOSER_COMMANDS,
  filterComposerCommands,
  type ComposerCommandContext,
} from "../../commands/directory.js";

function contextOf(
  over: Partial<ComposerCommandContext> = {},
): ComposerCommandContext {
  return {
    sessionId: "s1",
    hasLegacyPlan: false,
    clearDraft: vi.fn(),
    openPlan: vi.fn(),
    openExport: vi.fn(),
    toggleTheme: vi.fn(() => "Celeris (light)"),
    ...over,
  };
}

function commandOf(id: string) {
  const command = COMPOSER_COMMANDS.find((entry) => entry.id === id);
  if (command === undefined) throw new Error(`unknown command ${id}`);
  return command;
}

describe("composer command directory", () => {
  it("registers exactly the launch roster, each with a slash label and a description", () => {
    expect(COMPOSER_COMMANDS.map((command) => command.id)).toEqual([
      "plan",
      "export",
      "clear-draft",
      "theme",
      "help",
    ]);
    for (const command of COMPOSER_COMMANDS) {
      expect(command.label).toBe(`/${command.id}`);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  it("filters by case-insensitive id prefix; the empty query returns the full roster", () => {
    expect(filterComposerCommands("").length).toBe(COMPOSER_COMMANDS.length);
    expect(filterComposerCommands("cl").map((command) => command.id)).toEqual([
      "clear-draft",
    ]);
    expect(filterComposerCommands("PL").map((command) => command.id)).toEqual([
      "plan",
    ]);
    expect(filterComposerCommands("zz")).toEqual([]);
  });

  it("/plan opens the review only when a legacy plan exists, else answers with a toast", () => {
    const withPlan = contextOf({ hasLegacyPlan: true });
    expect(commandOf("plan").run(withPlan)).toBeNull();
    expect(withPlan.openPlan).toHaveBeenCalledTimes(1);

    const withoutPlan = contextOf();
    expect(commandOf("plan").run(withoutPlan)).toBe(
      "This session has no legacy plan to review.",
    );
    expect(withoutPlan.openPlan).not.toHaveBeenCalled();
  });

  it("/export opens the export dialog for a session and refuses on the welcome stage", () => {
    const inSession = contextOf();
    expect(commandOf("export").run(inSession)).toBeNull();
    expect(inSession.openExport).toHaveBeenCalledTimes(1);

    const welcome = contextOf({ sessionId: null });
    expect(commandOf("export").run(welcome)).toBe(
      "Open a session to export its transcript.",
    );
    expect(welcome.openExport).not.toHaveBeenCalled();
  });

  it("/clear-draft clears and confirms", () => {
    const context = contextOf();
    expect(commandOf("clear-draft").run(context)).toBe("Draft cleared.");
    expect(context.clearDraft).toHaveBeenCalledTimes(1);
  });

  it("/theme flips the preference and names the resolved theme in the toast", () => {
    const context = contextOf();
    expect(commandOf("theme").run(context)).toBe("Theme: Celeris (light).");
    expect(context.toggleTheme).toHaveBeenCalledTimes(1);
  });

  it("/help lists every registered command", () => {
    const text = commandOf("help").run(contextOf());
    for (const command of COMPOSER_COMMANDS) {
      expect(text).toContain(command.label);
    }
  });
});
