/**
 * The Preferences group on the Settings register: the Appearance theme
 * switcher (chronos | celeris | system cubes), the composer Enter-key row,
 * and - once the errors lane lands its uiStore slot - the notifications
 * toggle. Appearance selection follows the PERSISTED preference, never the
 * resolved active theme, so "System" stays selected while the OS decides
 * the paint.
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
import {
  notificationsSlotPresent,
  setNotificationsEnabled,
  useNotificationsEnabled,
} from "./notifications-slot.js";

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
    <h2 className="font-doto text-[11px] uppercase tracking-[0.14em] text-ink-tertiary">
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
  const enabled = useNotificationsEnabled();
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
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
          enabled ? "bg-accent-primary" : "bg-interactive-active",
        )}
      >
        <span
          aria-hidden
          className={cn(
            // ink-on-chrome is the theme-invariant white (the toast/tooltip
            // plate text token) - the knob stays white over the accent fill
            // and the gray wash in both themes.
            "absolute top-0.5 h-4 w-4 rounded-full bg-ink-on-chrome shadow-lv1 transition-transform",
            enabled ? "translate-x-[18px]" : "translate-x-0.5",
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
      {notificationsSlotPresent() ? <NotificationsRow /> : null}
    </section>
  );
}
