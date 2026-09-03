/**
 * STUDIO HOST STATUS PREVIEW - the diagnostic viewer for the status pill,
 * sibling of `UpdaterPreview` and built the same way: a build made with
 * `VITE_VEX_STUDIO_HOST_PREVIEW=1` replaces the live pill with a panel that
 * renders one pill per host state and per wire cause, from local schema-valid
 * statuses. No IPC is called, main is never touched, and release builds are
 * made without the flag, so this component is unreachable in production.
 *
 * WHY IT EXISTS. Section 6 of the UX audit could not capture a single
 * unavailable cause: only `locked` was reachable live, and nothing in the
 * renderer could drive the others. Every cause's card is a user-facing error
 * surface, so "we cannot see it" is not an acceptable state for it to ship in.
 * The panel makes each one reachable in the real app, in both themes, without
 * a seam that could ever influence the live path.
 *
 * The cases walk `studioHostUnavailableCauseSchema.options`, not a hand-written
 * list, so a cause added on the wire appears here without anybody remembering
 * to add it.
 */

import type { JSX } from "react";
import {
  studioHostUnavailableCauseSchema,
  STUDIO_MAX_CONNECTIONS_WIRE,
  type StudioHostStatus,
} from "@shared/schemas/studio.js";
import {
  StudioHostStatusPill,
  studioHostStatusView,
  STUDIO_HOST_VIEW_LOADING,
  STUDIO_HOST_VIEW_UNKNOWN,
  type StudioHostStatusView,
} from "./StudioHostStatusWord.js";

export const STUDIO_HOST_PREVIEW_ENABLED =
  import.meta.env.VITE_VEX_STUDIO_HOST_PREVIEW === "1";

function status(overrides: Partial<StudioHostStatus> = {}): StudioHostStatus {
  return {
    state: "running",
    cause: null,
    connectionCount: 2,
    maxConnections: STUDIO_MAX_CONNECTIONS_WIRE,
    atCapacity: false,
    ...overrides,
  };
}

/**
 * Built when the panel renders, not at module scope: this module and
 * `StudioHostStatusWord` import each other (the live path chooses the preview,
 * the preview renders the live pill), and a top-level table would read that
 * module's consts inside the cycle, before they are initialized.
 */
function previewCases(): ReadonlyArray<{
  readonly key: string;
  readonly view: StudioHostStatusView;
}> {
  return [
    { key: "loading", view: STUDIO_HOST_VIEW_LOADING },
    { key: "read-failed", view: STUDIO_HOST_VIEW_UNKNOWN },
    { key: "running", view: studioHostStatusView(status()) },
    {
      key: "running-at-capacity",
      view: studioHostStatusView(
        status({
          connectionCount: STUDIO_MAX_CONNECTIONS_WIRE,
          atCapacity: true,
        }),
      ),
    },
    {
      key: "starting",
      view: studioHostStatusView(status({ state: "starting" })),
    },
    { key: "locked", view: studioHostStatusView(status({ state: "locked" })) },
    // PREFIXED, because `starting` is both a host STATE and an unavailable
    // CAUSE: a bare cause key collided with the state above it, and a capture
    // pass keyed on it silently overwrote one card with the other.
    ...studioHostUnavailableCauseSchema.options.map((cause) => ({
      key: `unavailable-${cause}`,
      view: studioHostStatusView(status({ state: "unavailable", cause })),
    })),
  ];
}

export function StudioHostStatusPreview(): JSX.Element {
  const cases = previewCases();
  return (
    <div
      data-vex-area="studio-host-status-preview"
      // NO SCROLL PORT, deliberately. A pill's card is positioned against the
      // pill, so an `overflow-y-auto` ancestor CLIPS it - the panel's first
      // capture pass photographed sixteen pills and not one card, and no
      // assertion caught it because a clipped element still has a layout box.
      // Sixteen rows fit the capture viewport unscrolled; a panel that needed
      // to scroll would have to move the card to a portal first.
      className="fixed top-12 left-1/2 z-50 flex w-[380px] -translate-x-1/2 flex-col gap-1 rounded-xl border border-line-2 bg-surface-overlay p-3"
    >
      {cases.map((entry) => (
        <div
          key={entry.key}
          data-vex-host-preview-case={entry.key}
          className="flex items-center justify-between gap-3"
        >
          <span className="font-mono text-[11px] text-ink-tertiary">
            {entry.key}
          </span>
          <StudioHostStatusPill
            view={entry.view}
            onUnlock={() => undefined}
            onRecheck={() => undefined}
          />
        </div>
      ))}
    </div>
  );
}
