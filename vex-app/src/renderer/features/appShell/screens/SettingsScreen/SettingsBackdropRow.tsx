/**
 * The Background row of the Settings Preferences section: the user's own
 * image in the print window of Vex's sidebar (docs/design/R3-MINIMAL.md
 * section 9.1; `VexPortraitPlate` paints it).
 *
 * WHAT THE ROW OWNS: intent only. It asks main to open the picker, shows the
 * record main answered with, and asks main to clear it. It never sees a
 * path and never sends bytes; the preview `<img>` loads the same
 * `app://vex/user-backdrop/<id>` URL the plate paints.
 *
 * GRAMMAR:
 *  - the row wears the Preferences grammar of its siblings (`.vex-pref`): the
 *    name, then a 13px hint that carries the LIMITS LINE (format, size and
 *    floor) at the left, the control at the right;
 *  - the preview is a small card in the shape of the image it previews (16:9,
 *    112x63, square), after the attachment thumbnail (`object-fit: cover`,
 *    remove control INSIDE the card at the top-right, revealed on hover or
 *    focus, always visible on a coarse pointer);
 *  - the actions are the kit's small quiet key: "Choose image"
 *    while the shipped artwork is in use, "Replace" beside the preview once a
 *    custom one is set. The card's x is the remove.
 *
 * STATES: idle (shipped artwork), custom (preview + Replace), busy (the
 * picker is open: the key is disabled and `aria-busy`, so a second click
 * cannot stack a dialog), refused (the typed refusal from main under the hint
 * as an alert, with its correlation id), cancelled (nothing; a dismissed
 * picker is not an event). Loading and a failed read paint as idle: the
 * shipped artwork is the fallback for every state in which a custom image is
 * not positively known.
 */

import { useState, type JSX } from "react";
import type { VexError } from "@shared/ipc/result.js";
import {
  SHELL_BACKDROP_MIN_HEIGHT,
  SHELL_BACKDROP_MIN_WIDTH,
} from "@shared/schemas/shell-backdrop.js";
import {
  currentShellBackdrop,
  useClearShellBackdrop,
  usePickShellBackdrop,
  useShellBackdrop,
} from "../../../../lib/api/shell-backdrop.js";
import { LineClose } from "../../../../components/icons/line/index.js";
import { Button } from "../../../../components/ui/button.js";

/** The copy's size figure. The gate is 8 MiB; "8 MB" is how a user says it. */
const LIMITS_LINE = `Your own PNG or JPEG in the print window of Vex's sidebar, up to 8 MB and at least ${SHELL_BACKDROP_MIN_WIDTH}x${SHELL_BACKDROP_MIN_HEIGHT}. Stays on this machine.`;

export function SettingsBackdropRow(): JSX.Element {
  const backdropQuery = useShellBackdrop();
  const custom = currentShellBackdrop(backdropQuery.data);
  const pick = usePickShellBackdrop();
  const clear = useClearShellBackdrop();
  const [refusal, setRefusal] = useState<VexError | null>(null);
  const busy = pick.isPending || clear.isPending;

  const choose = (): void => {
    setRefusal(null);
    pick.mutate(undefined, {
      onSuccess: (result) => {
        if (!result.ok) setRefusal(result.error);
      },
    });
  };
  const remove = (): void => {
    setRefusal(null);
    clear.mutate(undefined, {
      onSuccess: (result) => {
        if (!result.ok) setRefusal(result.error);
      },
    });
  };

  return (
    <div
      className="vex-pref"
      data-vex-settings-backdrop
      data-vex-backdrop-state={custom === null ? "shipped" : "custom"}
    >
      <div>
        <div className="vex-pref__title">Background</div>
        <p className="vex-pref__help">{LIMITS_LINE}</p>
        {refusal !== null ? (
          <p
            role="alert"
            data-vex-backdrop-refusal={refusal.code}
            className="vex-pref__alert"
          >
            {refusal.message}
            {refusal.correlationId !== undefined ? (
              <span className="vex-pref__ref"> (ref {refusal.correlationId})</span>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="vex-pref__control">
        {custom !== null ? (
          <div className="vex-backdrop-preview">
            <img
              src={custom.url}
              alt="Current background image"
              draggable={false}
              data-vex-backdrop-preview
              className="select-none"
            />
            <button
              type="button"
              aria-label="Remove background image"
              data-vex-backdrop-remove
              disabled={busy}
              onClick={remove}
              className="vex-backdrop-preview__remove disabled:cursor-not-allowed"
            >
              <LineClose size={14} />
            </button>
          </div>
        ) : null}
        <Button
          variant="quiet"
          size="sm"
          data-vex-backdrop-pick
          disabled={busy}
          aria-busy={pick.isPending || undefined}
          onClick={choose}
        >
          {custom === null ? "Choose image" : "Replace"}
        </Button>
      </div>
    </div>
  );
}
