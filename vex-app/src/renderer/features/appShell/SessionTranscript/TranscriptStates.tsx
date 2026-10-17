/**
 * Non-list transcript surfaces: the loading, initial-error and empty states,
 * plus the small in-flow older-page loading/error strips
 * (docs/design/R3-MINIMAL.md sections 6 and 12): loading is a word and the
 * quiet bar, a failure is the ink callout behind the ink cross, never red.
 */

import type { JSX } from "react";
import { ErrorCallout } from "../../../components/ui/error-callout.js";
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
      <ErrorCallout role="alert" compact title={message} className="max-w-[560px]" />
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
      <p className="text-center text-[13.5px] leading-[1.5] text-ink-tertiary">
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
      className="mx-auto flex items-center gap-2 text-[13px] text-ink-primary"
    >
      <Swatch state="error" size={10} />
      Couldn&apos;t load older messages.
    </div>
  );
}
