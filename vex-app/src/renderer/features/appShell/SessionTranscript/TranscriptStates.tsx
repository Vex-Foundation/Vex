/**
 * Non-list transcript surfaces: the loading, initial-error and empty states,
 * plus the small in-flow older-page loading/error strips.
 */

import type { JSX } from "react";
import { DotmHex3 } from "../../../components/ui/dotm-hex-3.js";

export function TranscriptLoadingState(): JSX.Element {
  return (
    <div
      data-vex-area="chat-transcript"
      data-state="loading"
      className="flex min-h-0 flex-1 items-center justify-center"
    >
      <DotmHex3
        size={28}
        dotSize={4}
        color="var(--vex-accent)"
        ariaLabel="Loading conversation"
      />
    </div>
  );
}

export function TranscriptErrorState({
  message,
}: {
  readonly message: string;
}): JSX.Element {
  return (
    <div
      data-vex-area="chat-transcript"
      data-state="error"
      className="flex min-h-0 flex-1 items-center justify-center px-4"
    >
      <div
        role="alert"
        className="rounded-[6px] border border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)] bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        {message}
      </div>
    </div>
  );
}

export function TranscriptEmptyState(): JSX.Element {
  return (
    <div
      data-vex-area="chat-transcript"
      data-state="empty"
      className="flex min-h-0 flex-1 items-center justify-center px-4"
    >
      <p className="text-center text-sm text-[var(--vex-text-2)]">
        Start the conversation — your messages and Vex&apos;s replies appear
        here.
      </p>
    </div>
  );
}

export function OlderPageLoadingStrip(): JSX.Element {
  return (
    <div className="flex justify-center py-1">
      <DotmHex3
        size={18}
        dotSize={3}
        color="var(--vex-accent)"
        ariaLabel="Loading older messages"
      />
    </div>
  );
}

export function OlderPageErrorStrip(): JSX.Element {
  return (
    <div
      role="alert"
      className="mx-auto rounded-[6px] border border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)] bg-destructive/10 px-2.5 py-1 text-[11px] text-destructive"
    >
      Couldn&apos;t load older messages.
    </div>
  );
}
