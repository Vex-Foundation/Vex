/**
 * Non-list transcript surfaces: the loading, initial-error and empty states,
 * plus the small in-flow older-page loading/error strips. V10 (docs/design/
 * V10-SPREAD.md section 1): loading is the brand loader (the ongoing swatch at
 * size), an error speaks in ink behind the ink cross, never red.
 */

import type { JSX } from "react";
import { Swatch } from "../../../components/ui/swatch.js";
import { VexLoader } from "../../../components/ui/vex-loader.js";

export function TranscriptLoadingState(): JSX.Element {
  return (
    <div
      data-vex-area="chat-transcript"
      data-state="loading"
      className="flex min-h-0 flex-1 items-center justify-center"
    >
      <VexLoader size={28} label="Loading conversation" />
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
        className="flex items-start gap-2 border border-rule px-3 py-2 text-[13px] leading-5 text-ink-primary"
      >
        <Swatch state="error" size={9} className="mt-[5px]" />
        <span>{message}</span>
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
      <p className="text-center text-[14px] text-ink-secondary">
        Start the conversation - your messages and Vex&apos;s replies appear
        here.
      </p>
    </div>
  );
}

export function OlderPageLoadingStrip(): JSX.Element {
  return (
    <div className="flex justify-center py-1">
      <VexLoader size={14} label="Loading older messages" />
    </div>
  );
}

export function OlderPageErrorStrip(): JSX.Element {
  return (
    <div
      role="alert"
      className="mx-auto flex items-center gap-2 font-mono text-[11px] uppercase tracking-status text-ink-primary"
    >
      <Swatch state="error" size={9} />
      Couldn&apos;t load older messages.
    </div>
  );
}
