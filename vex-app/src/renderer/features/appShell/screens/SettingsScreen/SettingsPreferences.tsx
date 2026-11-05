/**
 * The Preferences section of the Settings page (docs/design/R3-MINIMAL.md
 * section 9.6): the head, then one row per setting under a hairline rule:
 * Show Vex, the Session permission explainer, the Background image
 * (`SettingsBackdropRow`), the composer Enter key and the two switches.
 *
 * There is no Appearance row: H3 is dark only (the H3 revamp plan, decision
 * 6), so Celeris and the "System" choice left with the theme picker, and a
 * saved choice migrates to dark (`uiStore/persistence.ts`, v23).
 *
 * Show Vex is Kimm's open or closed choice in chats (`vexOpenChat`,
 * docs/design/H3-DESKTOP.md section 3.5; plan row S4-14), the same choice her
 * corner key, the Vex key and the chord write. It replaced R3's two rows,
 * Show avatar (with its "Looking at you" preview) and Open Vex's sidebar in
 * chats: v24 folded a stored "avatar off" into it. The chat slot is written
 * directly because the frame's own setter writes the CURRENT page's slot,
 * and this page is a table page (`vexOpenPages`).
 */

import { type JSX, type ReactNode } from "react";
import { Swatch } from "../../../../components/ui/swatch.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  setSubmitKeyBehavior,
  useSubmitKeyBehavior,
  type SubmitKeyBehavior,
} from "../../../../lib/composer-submission-policy.js";
import { usePriceAlertsOsSetting } from "../../../../lib/api/notification-preferences.js";
import { studioPlatform } from "../../studio/keybindings-labels.js";
import { vexToggleShortcutLabel } from "../../../vex/vex-toggle-shortcut.js";
import { SettingsBackdropRow } from "./SettingsBackdropRow.js";
import { SettingsHead } from "./SettingsHead.js";

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

function ShowVexRow(): JSX.Element {
  const enabled = useUiStore((state) => state.vexOpenChat);
  return (
    <SwitchRow
      title="Show Vex"
      help={`Kimm's section in Vex's column, in chats, on approvals and in Studio. Off, she folds to her strip; Show Vex in its corner, the Vex key at the top, or ${vexToggleShortcutLabel(studioPlatform)}, opens her again. Her state word still shows what she is doing. Pages keep a choice of their own, closed until you show her there, and in a window under 1024 wide she starts closed on every visit.`}
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

/**
 * Price alerts (F01): an OS notification when an alert fires and no Vex window
 * is focused. Main keeps the setting, because main raises the notification;
 * the in-app notice always shows. Until main answers, the switch shows on,
 * the default.
 */
function PriceAlertNotificationsRow(): JSX.Element {
  const { enabled, busy, setEnabled } = usePriceAlertsOsSetting();
  return (
    <SwitchRow
      title="Price alert notifications"
      help="Show a system notification when a price alert fires and Vex is in the background. While the vault is locked it says only that an alert fired."
      enabled={enabled}
      onToggle={() => {
        if (!busy) setEnabled(!enabled);
      }}
      seam="data-vex-settings-price-alert-notifications"
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
        <ShowVexRow />
        <SessionPermissionRow />
        <SettingsBackdropRow />
        <SubmitKeyRow />
        <NotificationsRow />
        <PriceAlertNotificationsRow />
        <TerminalPasteWarningRow />
      </div>
    </section>
  );
}
