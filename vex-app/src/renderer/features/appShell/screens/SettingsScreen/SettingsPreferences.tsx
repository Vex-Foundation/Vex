/**
 * The Preferences group on the Settings register: the Appearance theme
 * switcher (chronos | celeris | system cubes), the composer Enter-key row,
 * and the notifications toggle. Appearance selection follows the PERSISTED
 * preference, never the resolved active theme, so "System" stays selected
 * while the OS decides the paint.
 */

import { type JSX } from "react";
import {
  IconThemeDark,
  IconThemeLight,
  IconThemeSystem,
} from "../../../../components/icons/index.js";
import type { GlyphProps } from "../../../../components/icons/glyphs/props.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import type { VexThemePreference } from "../../../../stores/uiStore/theme.js";
import {
  setSubmitKeyBehavior,
  useSubmitKeyBehavior,
  type SubmitKeyBehavior,
} from "../../../../lib/composer-submission-policy.js";
import { cn } from "../../../../lib/utils.js";

interface ThemeCube {
  readonly id: VexThemePreference;
  readonly label: string;
  readonly caption: string;
  readonly Icon: (props: GlyphProps) => JSX.Element;
}

const THEME_CUBES: ReadonlyArray<ThemeCube> = [
  { id: "chronos", label: "Chronos", caption: "Dark", Icon: IconThemeDark },
  { id: "celeris", label: "Celeris", caption: "Light", Icon: IconThemeLight },
  { id: "system", label: "System", caption: "Match OS", Icon: IconThemeSystem },
];

interface SubmitChoice {
  readonly id: SubmitKeyBehavior;
  readonly label: string;
}

const SUBMIT_CHOICES: ReadonlyArray<SubmitChoice> = [
  { id: "enter", label: "Enter sends" },
  { id: "mod-enter", label: "Ctrl/Cmd+Enter sends" },
];

function GroupTitle({ children }: { readonly children: string }): JSX.Element {
  return (
    <h2 className="vex-micro-label uppercase text-ink-secondary">
      {children}
    </h2>
  );
}

function AppearanceRow(): JSX.Element {
  const preference = useUiStore((state) => state.themePreference);
  const setThemePreference = useUiStore((state) => state.setThemePreference);
  return (
    <div className="flex flex-col gap-2 py-4" data-vex-settings-appearance>
      <div className="text-[14px] leading-[22px] text-ink-primary">
        Appearance
      </div>
      <div className="flex flex-wrap items-stretch gap-2">
        {THEME_CUBES.map(({ id, label, caption, Icon }) => {
          const selected = preference === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              data-vex-theme-cube={id}
              onClick={() => setThemePreference(id)}
              className={cn(
                "flex flex-1 basis-[150px] flex-col items-center justify-center gap-1 rounded-xl border px-8 py-5 text-[14px] leading-[22px] text-ink-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
                selected
                  ? "border-line-4 bg-interactive-solid"
                  : "border-line-2 hover:bg-interactive-hover",
              )}
            >
              <Icon size={16} />
              {label}
              <span className="text-[12px] leading-[18px] text-ink-tertiary">
                {caption}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SubmitKeyRow(): JSX.Element {
  const behavior = useSubmitKeyBehavior();
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line-1 py-4"
      data-vex-settings-enter
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="text-[14px] leading-[22px] text-ink-primary">
          Enter key
        </div>
        <div className="text-[12px] leading-[18px] text-ink-tertiary">
          Shift+Enter always inserts a newline; Ctrl/Cmd+Enter always sends.
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Enter key behavior">
        {SUBMIT_CHOICES.map(({ id, label }) => {
          const selected = behavior === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              data-vex-submit-choice={id}
              onClick={() => setSubmitKeyBehavior(id)}
              className={cn(
                "h-7 rounded-full border px-3 text-[12px] leading-[18px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
                selected
                  ? "border-line-4 bg-interactive-solid text-ink-primary"
                  : "border-line-2 text-ink-secondary hover:bg-interactive-hover",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NotificationsRow(): JSX.Element {
  const enabled = useUiStore((state) => state.notificationsEnabled);
  const setNotificationsEnabled = useUiStore(
    (state) => state.setNotificationsEnabled,
  );
  return (
    <div
      className="flex items-center justify-between gap-3 border-t border-line-1 py-4"
      data-vex-settings-notifications
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="text-[14px] leading-[22px] text-ink-primary">
          Notifications
        </div>
        <div className="text-[12px] leading-[18px] text-ink-tertiary">
          Notify when a turn finishes while the window is unfocused.
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Notifications"
        onClick={() => setNotificationsEnabled(!enabled)}
        // THE SWITCH LOOK (owner item 4, ratified 2026-08-21). One treatment
        // for every switch in the app; the auto-retry toggle in
        // MissionContractCardSections wears the identical strings. ON = the
        // accent-CTA track (deep brand blue on chronos, light accent on
        // celeris) with the matching ink knob; OFF = the solid interactive
        // track with the page's own primary ink, never an opacity wash.
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
          enabled
            ? "border-button-accent bg-button-accent"
            : "border-line-4 bg-interactive-solid",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block h-3.5 w-3.5 rounded-full transition-transform",
            enabled
              ? "translate-x-[18px] bg-ink-on-button-accent"
              : "translate-x-[3px] bg-ink-primary",
          )}
        />
      </button>
    </div>
  );
}

export function SettingsPreferences(): JSX.Element {
  return (
    <section
      aria-label="Preferences"
      className="mt-8 flex flex-col"
      data-vex-settings-preferences
    >
      <GroupTitle>Preferences</GroupTitle>
      <AppearanceRow />
      <SubmitKeyRow />
      <NotificationsRow />
    </section>
  );
}
