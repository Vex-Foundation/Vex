/**
 * The Background row of the Settings Preferences group: the user's own
 * wallpaper under the glass shell (owner screenshots 12, 14, 23: a terminal
 * over the user's own photo).
 *
 * WHAT THE ROW OWNS: intent only. It asks main to open the picker, shows the
 * record main answered with, and asks main to clear it. It never sees a
 * path and never sends bytes; the preview `<img>` loads the same
 * `app://vex/user-backdrop/<id>` URL the shell wall paints.
 *
 * GRAMMAR (stated, as the lane's design authority):
 *  - the row wears the Preferences grammar of its siblings (`.vex-pref`):
 *    hairline rule, 15px title, 13px hint that carries the LIMITS LINE - format, size and floor - the way deepseek's DropOverlay
 *    puts its limits under the invitation title;
 *  - the preview is a small card in the shape of the wall it previews
 *    (16:9, 112x63, square), after deepseek's AttachmentRail thumbnail
 *    (64px card, `object-fit: cover`, remove control INSIDE the card at the
 *    top-right, revealed on hover or focus, always visible on a coarse
 *    pointer). A wallpaper is not square, so the card is not either;
 *  - the actions are the sheet's square outline button (`.vex-sbtn`): "Choose
 *    image" while the shipped artwork is in use, "Replace" beside the preview
 *    once a custom one is set. The card's x is the remove.
 *
 * STATES: idle (shipped artwork), custom (preview + Replace), busy (the
 * picker is open: the pill is disabled and `aria-busy`, so a second click
 * cannot stack a dialog), refused (the typed refusal from main under the row
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
import { PxIcon } from "../../../../components/icons/index.js";

/** The copy's size figure. The gate is 8 MiB; "8 MB" is how a user says it. */
const LIMITS_LINE = `Your own PNG or JPEG under the glass, up to 8 MB and at least ${SHELL_BACKDROP_MIN_WIDTH}x${SHELL_BACKDROP_MIN_HEIGHT}. Stays on this machine.`;

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
      className="vex-pref vex-pref--stack"
      data-vex-settings-backdrop
      data-vex-backdrop-state={custom === null ? "shipped" : "custom"}
    >
      <div>
        <div className="vex-pref__title">Background</div>
        <p className="vex-pref__help">{LIMITS_LINE}</p>
      </div>
      <div className="vex-pref__note">
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
              <PxIcon name="close" size={16} />
            </button>
          </div>
        ) : (
          <span />
        )}
        <button
          type="button"
          data-vex-backdrop-pick
          disabled={busy}
          aria-busy={pick.isPending || undefined}
          onClick={choose}
          className="vex-sbtn"
        >
          <PxIcon name="image" size={16} />
          {custom === null ? "Choose image" : "Replace"}
        </button>
      </div>
      {refusal !== null ? (
        <p
          role="alert"
          data-vex-backdrop-refusal={refusal.code}
          className="text-[12px] leading-[18px] text-warning-label"
        >
          {refusal.message}
          {refusal.correlationId !== undefined ? (
            <span className="text-ink-tertiary"> (ref {refusal.correlationId})</span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
