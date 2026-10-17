/**
 * The Preferences section of the Settings page (docs/design/R3-MINIMAL.md
 * section 9.6): the head, then one row per setting under a hairline rule:
 * Appearance (the theme choice, a segmented control), Show avatar, Open Vex's
 * sidebar in chats, the Session permission explainer, the Background image
 * (`SettingsBackdropRow`), the composer Enter key and the two switches.
 *
 * Appearance selection follows the PERSISTED preference, never the resolved
 * active theme, so "System" stays selected while the OS decides the paint.
 * Show avatar and Open Vex's sidebar in chats are the two persisted layout
 * preferences `showAvatar` and `vexOpenChat`; the chat slot is written
 * directly because the frame's own setter writes the CURRENT page's slot, and
 * this page is a table page (`vexOpenPages`).
 */

import { type JSX, type ReactNode } from "react";
import { Swatch } from "../../../../components/ui/swatch.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import type { VexThemePreference } from "../../../../stores/uiStore/theme.js";
import {
  setSubmitKeyBehavior,
  useSubmitKeyBehavior,
  type SubmitKeyBehavior,
} from "../../../../lib/composer-submission-policy.js";
import { SettingsBackdropRow } from "./SettingsBackdropRow.js";
import { SettingsHead } from "./SettingsHead.js";

interface ThemeChoice {
  readonly id: VexThemePreference;
  readonly label: string;
}

const THEME_CHOICES: ReadonlyArray<ThemeChoice> = [
  { id: "chronos", label: "Chronos · Dark" },
  { id: "celeris", label: "Celeris · Light" },
  { id: "system", label: "System · Match OS" },
];

interface SubmitChoice {
  readonly id: SubmitKeyBehavior;
  readonly label: string;
}

const SUBMIT_CHOICES: ReadonlyArray<SubmitChoice> = [
  { id: "enter", label: "Enter sends" },
  { id: "mod-enter", label: "Ctrl/Cmd+Enter sends" },
];

/** One setting row: the name and help at the left, its control at the right. */
function PrefRow({
  title,
  help,
  seam,
  children,
}: {
  readonly title: string;
  readonly help: ReactNode;
  readonly seam: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="vex-pref" {...{ [seam]: "" }}>
      <div>
        <div className="vex-pref__title">{title}</div>
        <p className="vex-pref__help">{help}</p>
      </div>
      <div className="vex-pref__control">{children}</div>
    </div>
  );
}

function AppearanceRow(): JSX.Element {
  const preference = useUiStore((state) => state.themePreference);
  const setThemePreference = useUiStore((state) => state.setThemePreference);
  return (
    <PrefRow
      title="Appearance"
      help="Chronos is the night ledger, Celeris the day paper."
      seam="data-vex-settings-appearance"
    >
      <div className="vex-seg" role="group" aria-label="Appearance">
        {THEME_CHOICES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={preference === id}
            data-vex-theme-cube={id}
            onClick={() => setThemePreference(id)}
          >
            {label}
          </button>
        ))}
      </div>
    </PrefRow>
  );
}

function SubmitKeyRow(): JSX.Element {
  const behavior = useSubmitKeyBehavior();
  return (
    <PrefRow
      title="Enter key"
      help="Shift+Enter always inserts a newline; Ctrl/Cmd+Enter always sends."
      seam="data-vex-settings-enter"
    >
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
    </PrefRow>
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
    <PrefRow title={title} help={help} seam={seam}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={title}
        onClick={onToggle}
        className="vex-switch"
      />
    </PrefRow>
  );
}

function ShowAvatarRow(): JSX.Element {
  const enabled = useUiStore((state) => state.showAvatar);
  const setShowAvatar = useUiStore((state) => state.setShowAvatar);
  return (
    <SwitchRow
      title="Show avatar"
      help="Vex's hologram in the right sidebar. The vx token at the right of the top bar shows or hides the sidebar. Off, the token and the state word still show what she is doing."
      enabled={enabled}
      onToggle={() => setShowAvatar(!enabled)}
      seam="data-vex-settings-avatar"
    />
  );
}

function OpenInChatsRow(): JSX.Element {
  const enabled = useUiStore((state) => state.vexOpenChat);
  return (
    <SwitchRow
      title="Open Vex's sidebar in chats"
      help="Vex's sidebar is open by default in chats, on approvals and in Studio. Off, it stays closed until you show it with the vx token in the top bar."
      enabled={enabled}
      onToggle={() => useUiStore.setState({ vexOpenChat: !enabled })}
      seam="data-vex-settings-vex-open-chat"
    />
  );
}

/**
 * How a session's permission works, in plain words. It is chosen per session
 * in the New session dialog and locked once the session exists, so this row
 * explains and offers no control: the right-hand word says where the choice is
 * made.
 */
function SessionPermissionRow(): JSX.Element {
  return (
    <PrefRow
      title="Session permission"
      seam="data-vex-settings-permission"
      help={
        <>
          <span className="vex-pref__em">Restricted</span>: funds require
          approval. Vex asks before every transaction and nothing signs until
          you approve.
          <br />
          <span className="vex-pref__em">Full access</span>: Vex runs approved
          tools without asking each time, including moves of funds. Mode and
          permission are locked once the session is created.
        </>
      }
    >
      <span className="vex-pref__word">
        <Swatch state="awaiting" size={10} />
        Chosen per session
      </span>
    </PrefRow>
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
      data-vex-settings-section="preferences"
      data-vex-settings-preferences
    >
      <SettingsHead
        title="Preferences"
        status={null}
        lead="How Vex looks and behaves on this machine."
      />
      <div className="vex-prefs__list">
        <AppearanceRow />
        <ShowAvatarRow />
        <OpenInChatsRow />
        <SessionPermissionRow />
        <SettingsBackdropRow />
        <SubmitKeyRow />
        <NotificationsRow />
        <TerminalPasteWarningRow />
      </div>
    </section>
  );
}
