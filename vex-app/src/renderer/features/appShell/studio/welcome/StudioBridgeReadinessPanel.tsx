/**
 * THE DIAGNOSTIC THAT APPEARS WHEN VEX STUDIO HAS NO BRIDGE (B1.6).
 *
 * The Docker bootstrap flow is the shape this follows, deliberately: a
 * `SetupStatusCard` states what is wrong in a colored word plus one sentence,
 * a body gives the ONE remedy for that exact state, and a re-check button
 * re-asks the question. `docker/bootstrap/branches/DaemonStoppedBody.tsx` is
 * the direct precedent, including the copy-paste command block.
 *
 * ## It renders nothing at all when the bridge is ready
 *
 * Not a green "all good" row: an installation whose bridge is present is the
 * ordinary case, and a permanent reassurance badge on the welcome screen would
 * teach users to stop reading the region the failure will appear in. The panel
 * is also absent while the FIRST read is in flight, so entering Studio does not
 * flash a diagnostic that then disappears.
 *
 * ## Two different failures, never collapsed
 *
 * "The bridge is not there" and "the check did not answer" are separate
 * branches with separate sentences (rule 04, error layers). The second says
 * explicitly that it proves nothing about the bridge, because a reader who is
 * told "missing" by a failed read will go install a toolchain they may already
 * have. A failed read is also never SILENT: a check that could not run must
 * not leave a welcome screen that looks perfectly healthy.
 *
 * ## Accessibility
 *
 * The panel appears without the user asking and is the reason the screen looks
 * different, so it has to be announced. The announcement belongs to the
 * `SetupStatusCard` inside it, which since B2.2 carries `role="alert"` for its
 * alert tones - the word, the title and the sentence ARE the diagnosis. This
 * section therefore carries a LABEL and no live role of its own: two nested
 * live regions over one appearance is how a screen reader ends up saying the
 * same failure twice, and the outer one would additionally re-announce every
 * time the guidance body below it changed.
 *
 * The re-check progress line is `role="status"`, because a polite update is
 * exactly right for work the user just started themselves. The button is an
 * ordinary `Button`, so it is in the tab order and operable from the keyboard
 * with no extra handling.
 */

import type { JSX, ReactNode } from "react";
import type { StudioBridgeReadiness } from "@shared/schemas/studio-bridge-readiness.js";
import { Button } from "../../../../components/ui/button.js";
import { DocsLink } from "../../../../components/onboarding/DocsLink.js";
import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";
import { useStudioBridgeReadiness } from "../../../../lib/api/studio.js";
import {
  needsGoInstallGuidance,
  studioBridgeGoSentence,
  studioGoInstallGuidance,
  STUDIO_BRIDGE_BUILD_COMMAND,
  STUDIO_BRIDGE_DETAILS,
  STUDIO_BRIDGE_PANEL_LABEL,
  STUDIO_BRIDGE_PURPOSE,
  STUDIO_BRIDGE_RECHECK_LABEL,
  STUDIO_BRIDGE_RECHECKING_LABEL,
  STUDIO_BRIDGE_TITLES,
} from "./bridge-readiness-copy.js";

export function StudioBridgeReadinessPanel(): JSX.Element | null {
  const query = useStudioBridgeReadiness();
  const result = query.data;

  // BOTH ways the read can fail have to reach the failure branch, which is the
  // same defect `StudioWelcome`'s own `readFailed` note records: a settled
  // Result that says `ok: false`, AND a REJECTED call that leaves no Result at
  // all (the preload bridge throwing, the window tearing down mid-call). The
  // second one silently rendered NOTHING, which on this surface means a user
  // whose check could not run sees a welcome screen that looks completely
  // healthy.
  //
  // Only a read that has not settled yet renders nothing, and that is not a
  // failure: it is the half-second before the first answer, where claiming
  // anything would be a diagnostic that flashes and disappears.
  if (result === undefined && !query.isError) return null;

  const recheck = (): void => {
    void query.refetch();
  };
  // `isFetching` rather than `isLoading`: the button's own re-check is a
  // background refetch of a query that already has data, which `isLoading`
  // stays false for.
  const rechecking = query.isFetching;

  if (result === undefined || !result.ok) {
    return (
      <ReadinessShell
        tone="warn"
        word="Unknown"
        title={STUDIO_BRIDGE_TITLES.read_failed}
        detail={STUDIO_BRIDGE_DETAILS.read_failed}
        rechecking={rechecking}
        onRecheck={recheck}
      />
    );
  }

  const readiness: StudioBridgeReadiness = result.data;
  if (readiness.kind === "ready") return null;

  if (readiness.kind === "missing_packaged") {
    return (
      <ReadinessShell
        tone="error"
        word="Damaged"
        title={STUDIO_BRIDGE_TITLES.missing_packaged}
        detail={STUDIO_BRIDGE_DETAILS.missing_packaged}
        rechecking={rechecking}
        onRecheck={recheck}
      />
    );
  }

  if (readiness.kind === "unsupported_platform") {
    return (
      <ReadinessShell
        tone="warn"
        word="Unsupported"
        title={STUDIO_BRIDGE_TITLES.unsupported_platform}
        detail={STUDIO_BRIDGE_DETAILS.unsupported_platform}
        rechecking={rechecking}
        onRecheck={recheck}
      />
    );
  }

  if (readiness.kind === "pin_unreadable") {
    return (
      <ReadinessShell
        tone="warn"
        word="Incomplete"
        title={STUDIO_BRIDGE_TITLES.pin_unreadable}
        detail={STUDIO_BRIDGE_DETAILS.pin_unreadable}
        rechecking={rechecking}
        onRecheck={recheck}
      />
    );
  }

  const guidance = needsGoInstallGuidance(readiness.go)
    ? studioGoInstallGuidance(readiness.platform, readiness.requiredGoVersion)
    : null;

  return (
    <ReadinessShell
      tone="warn"
      word="Not built"
      title={STUDIO_BRIDGE_TITLES.missing_dev}
      detail={STUDIO_BRIDGE_PURPOSE}
      rechecking={rechecking}
      onRecheck={recheck}
    >
      <p className="text-xs leading-relaxed text-ink-secondary">
        {studioBridgeGoSentence(readiness.go, readiness.requiredGoVersion)}
      </p>

      {guidance !== null ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs leading-relaxed text-ink-secondary">
            {guidance.pinned.text}
          </p>
          {/* The addresses are ANCHORS, not text inside the sentence: an
            * address a user cannot click, cannot tab to and hears spelled out
            * letter by letter is not a route to anywhere. Both hosts are
            * path-scoped entries on main's openExternal allowlist. */}
          {guidance.pinned.links.map((link) => (
            <DocsLink key={link.href} href={link.href} label={link.label} />
          ))}
          {guidance.packaged !== null ? (
            <p className="text-xs leading-relaxed text-ink-tertiary">
              {guidance.packaged}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <p className="vex-micro text-ink-secondary">
          Then build the bridge from the repository root
        </p>
        <pre className="overflow-auto rounded-lg border border-[var(--color-border)] bg-gate-code p-3 font-mono text-xs leading-relaxed text-ink-primary">
          <code>{STUDIO_BRIDGE_BUILD_COMMAND}</code>
        </pre>
      </div>
    </ReadinessShell>
  );
}

/**
 * The frame every branch shares: the status stanza, the branch body, and the
 * re-check control.
 *
 * One frame rather than five, because the alert semantics, the region label
 * and the re-check affordance are the same fact in every branch and a copy per
 * branch is five chances for one of them to lose its `role`.
 */
function ReadinessShell({
  tone,
  word,
  title,
  detail,
  rechecking,
  onRecheck,
  children,
}: {
  readonly tone: "warn" | "error";
  readonly word: string;
  readonly title: string;
  readonly detail: string;
  readonly rechecking: boolean;
  readonly onRecheck: () => void;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <section
      aria-label={STUDIO_BRIDGE_PANEL_LABEL}
      data-vex-area="studio-bridge-readiness"
      className="flex flex-col gap-4"
    >
      <SetupStatusCard tone={tone} word={word} title={title} detail={detail} />
      {children}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          disabled={rechecking}
          onClick={onRecheck}
          className="self-start text-ink-secondary"
        >
          {rechecking
            ? STUDIO_BRIDGE_RECHECKING_LABEL
            : STUDIO_BRIDGE_RECHECK_LABEL}
        </Button>
        {rechecking ? (
          <span role="status" className="text-xs text-ink-tertiary">
            {STUDIO_BRIDGE_RECHECKING_LABEL}
          </span>
        ) : null}
      </div>
    </section>
  );
}
