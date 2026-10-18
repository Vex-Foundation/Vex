/**
 * The "Lock Vex" row in the Vault section (docs/design/R3-MINIMAL.md section
 * 9.6): the name and help at the left, the chord in mono and a quiet "Lock
 * Vex" key at the right, under a hairline rule like the Export row.
 *
 * It is the SAME request the profile menu, the native menu and the shortcut
 * make: `useLockVexControl().requestLock`, whose one owner deduplicates while
 * a lock is in flight. This row adds no lock path of its own, and no vault
 * reset door (that stays on the unlock screen behind its acknowledgement).
 * Like the menu it exists only while `LOCK_BUTTON` is on.
 */

import { type JSX } from "react";
import { LOCK_BUTTON } from "@shared/lock-button.js";
import { Button } from "../../../../components/ui/button.js";
import { LOCK_VEX_SHORTCUT, useLockVexControl } from "../../LockVexControl.js";

export function SettingsLockRow(): JSX.Element | null {
  const { pending, requestLock } = useLockVexControl();
  if (!LOCK_BUTTON) return null;
  return (
    <section
      aria-label="Lock Vex"
      className="vex-pref vex-pref--top"
      data-vex-settings-lock
    >
      <div>
        <h2 className="vex-pref__title">Lock Vex</h2>
        <p className="vex-pref__help">
          Require your password to return. Also in the profile menu.
        </p>
      </div>
      <div className="vex-pref__control">
        <span className="vex-pref__chord" data-vex-settings-lock-chord>
          {LOCK_VEX_SHORTCUT}
        </span>
        <Button
          variant="quiet"
          size="sm"
          disabled={pending}
          onClick={() => requestLock()}
          data-vex-settings-lock-key
        >
          {pending ? "Locking Vex..." : "Lock Vex"}
        </Button>
      </div>
    </section>
  );
}
