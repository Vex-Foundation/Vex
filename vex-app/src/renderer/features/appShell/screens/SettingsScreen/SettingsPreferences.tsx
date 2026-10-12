/**
 * The Preferences group on the Settings register (docs/design/V10-SPREAD.md
 * section 2, d7): the Appearance theme tiles (chronos | celeris | system), the
 * Background image row (`SettingsBackdropRow`), the composer Enter-key
 * segment and the two switches. Appearance selection follows the PERSISTED
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
import { SettingsBackdropRow } from "./SettingsBackdropRow.js";

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
  return <h2 className="vex-ov__group">{children}</h2>;
}

function AppearanceRow(): JSX.Element {
  const preference = useUiStore((state) => state.themePreference);
  const setThemePreference = useUiStore((state) => state.setThemePreference);
  return (
    <div className="vex-pref vex-pref--stack" data-vex-settings-appearance>
      <div className="vex-pref__title">Appearance</div>
      <div className="vex-tiles">
        {THEME_CUBES.map(({ id, label, caption, Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={preference === id}
            data-vex-theme-cube={id}
            onClick={() => setThemePreference(id)}
            className="vex-tile"
          >
            <Icon size={16} />
            <span className="vex-tile__title">{label}</span>
            <span className="vex-tile__caption">{caption}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SubmitKeyRow(): JSX.Element {
  const behavior = useSubmitKeyBehavior();
  return (
    <div className="vex-pref" data-vex-settings-enter>
      <div>
        <div className="vex-pref__title">Enter key</div>
        <p className="vex-pref__help">
          Shift+Enter always inserts a newline; Ctrl/Cmd+Enter always sends.
        </p>
      </div>
      <div className="vex-seg" role="group" aria-label="Enter key behavior">
        {SUBMIT_CHOICES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={behavior === id}
            data-vex-submit-choice={id}
            onClick={() => setSubmitKeyBehavior(id)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One switch row: title, help, and the square switch (the state is the fill). */
function SwitchRow({
  title,
  help,
  enabled,
  onToggle,
  seam,
}: {
  readonly title: string;
  readonly help: string;
  readonly enabled: boolean;
  readonly onToggle: () => void;
  readonly seam: string;
}): JSX.Element {
  return (
    <div className="vex-pref" {...{ [seam]: "" }}>
      <div>
        <div className="vex-pref__title">{title}</div>
        <p className="vex-pref__help">{help}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={title}
        onClick={onToggle}
        className="vex-switch"
      />
    </div>
  );
}

function NotificationsRow(): JSX.Element {
  const enabled = useUiStore((state) => state.notificationsEnabled);
  const setNotificationsEnabled = useUiStore(
    (state) => state.setNotificationsEnabled,
  );
  return (
    <SwitchRow
      title="Notifications"
      help="Notify when a turn finishes while the window is unfocused."
      enabled={enabled}
      onToggle={() => setNotificationsEnabled(!enabled)}
      seam="data-vex-settings-notifications"
    />
  );
}

function TerminalPasteWarningRow(): JSX.Element {
  const enabled = useUiStore((state) => state.terminalPasteWarning);
  const setEnabled = useUiStore((state) => state.setTerminalPasteWarning);
  return (
    <SwitchRow
      title="Multi-line paste warning"
      help="Ask before pasting multiple lines when the terminal program does not handle bracketed paste."
      enabled={enabled}
      onToggle={() => setEnabled(!enabled)}
      seam="data-vex-settings-terminal-paste"
    />
  );
}

export function SettingsPreferences(): JSX.Element {
  return (
    <section
      aria-label="Preferences"
      className="vex-prefs"
      data-vex-settings-preferences
    >
      <GroupTitle>Preferences</GroupTitle>
      <div className="vex-prefs__list">
        <AppearanceRow />
        <SettingsBackdropRow />
        <SubmitKeyRow />
        <NotificationsRow />
        <TerminalPasteWarningRow />
      </div>
    </section>
  );
}
