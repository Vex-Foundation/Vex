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
 *  - the row wears the Preferences grammar of its siblings (`SubmitKeyRow`):
 *    hairline top rule, 14px title, 12px tertiary hint that carries the
 *    LIMITS LINE - format, size and floor - the way deepseek's DropOverlay
 *    puts its limits under the invitation title;
 *  - the preview is a small card in the shape of the wall it previews
 *    (16:9, 112x63, `rounded-xl`), after deepseek's AttachmentRail thumbnail
 *    (64px card, `object-fit: cover`, remove control INSIDE the card at the
 *    top-right, revealed on hover or focus, always visible on a coarse
 *    pointer). A wallpaper is not square, so the card is not either;
 *  - the actions are the register's own pills (`h-7 rounded-full`): "Choose
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
import { IconClose } from "../../../../components/icons/index.js";
import {
  currentShellBackdrop,
  useClearShellBackdrop,
  usePickShellBackdrop,
  useShellBackdrop,
} from "../../../../lib/api/shell-backdrop.js";
import { cn } from "../../../../lib/utils.js";

const PILL_CLASS =
  "h-7 rounded-full border border-line-2 px-3 text-[12px] leading-[18px] text-ink-secondary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:cursor-not-allowed disabled:opacity-40";

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
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line-1 py-4"
      data-vex-settings-backdrop
      data-vex-backdrop-state={custom === null ? "shipped" : "custom"}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="text-[14px] leading-[22px] text-ink-primary">Background</div>
        <div className="text-[12px] leading-[18px] text-ink-tertiary">{LIMITS_LINE}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {custom !== null ? (
          <div className="group relative h-[63px] w-[112px] shrink-0 overflow-hidden rounded-xl border border-line-2 bg-interactive-hover">
            <img
              src={custom.url}
              alt="Current background image"
              draggable={false}
              data-vex-backdrop-preview
              className="h-full w-full select-none object-cover"
            />
            <button
              type="button"
              aria-label="Remove background image"
              data-vex-backdrop-remove
              disabled={busy}
              onClick={remove}
              className={cn(
                "absolute right-1 top-1 grid h-[18px] w-[18px] place-items-center rounded-full bg-button-accent text-ink-on-button-accent opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:cursor-not-allowed [@media(pointer:coarse)]:opacity-100 motion-reduce:transition-none",
              )}
            >
              <IconClose size={12} />
            </button>
          </div>
        ) : null}
        <button
          type="button"
          data-vex-backdrop-pick
          disabled={busy}
          aria-busy={pick.isPending || undefined}
          onClick={choose}
          className={PILL_CLASS}
        >
          {custom === null ? "Choose image" : "Replace"}
        </button>
      </div>
      {refusal !== null ? (
        <p
          role="alert"
          data-vex-backdrop-refusal={refusal.code}
          className="basis-full text-[12px] leading-[18px] text-warning"
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
