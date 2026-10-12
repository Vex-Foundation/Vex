/**
 * Docker Desktop license notice modal — shown BEFORE the user triggers
 * an installer download (skill Appendix A + codex turn 4 YELLOW #1).
 *
 * Plain inline modal (no Radix Portal yet — that primitive needs its
 * own CSP audit per MOTION-POLICY.md before adoption). Backdrop
 * deny-clicks outside the dialog so the user must explicitly accept or
 * dismiss.
 *
 * Visual: the V10 dialog language: a solid panel (--color-surface-1)
 * behind a hairline rule, the mask behind it with NO blur, no shadow; a
 * mono caps title; square actions from the Button primitive (the quiet
 * outlined Cancel, the one blue fill on Continue).
 *
 * No "I have a license" toggle — Vex cannot verify legal state and
 * presenting one would imply a verification it doesn't perform.
 */

import { Button } from "../../components/ui/button.js";
import { useCallback, useEffect, useRef } from "react";
import { IconArrowUpRight } from "../../components/icons/index.js";
import { cn } from "../../lib/utils.js";

interface LicenseNoticeProps {
  readonly open: boolean;
  readonly onAccept: () => void;
  readonly onDismiss: () => void;
}

const DOCKER_LICENSE_URL = "https://docs.docker.com/subscription/desktop-license/";

export function LicenseNotice({
  open,
  onAccept,
  onDismiss,
}: LicenseNoticeProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const openDocs = useCallback((): void => {
    // Anchor-target so the renderer's deny-all window-open handler
    // routes via the main process `shell.openExternal` allowlist.
    const win = globalThis.open(DOCKER_LICENSE_URL, "_blank");
    win?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }
      // Focus cycle: keep Tab navigation contained inside the dialog
      // while it's open (codex post-impl SHOULD-FIX #5 — Vex UI rules
      // require actual focus containment, not just initial focus).
      if (event.key !== "Tab" || dialog === null) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      // Initial open focuses the dialog container itself (tabIndex=-1).
      // Without this branch, the first Tab/Shift+Tab from there would
      // escape to the page behind. Move focus into the dialog instead
      // (codex post-impl SHOULD-FIX — focus trap escape on dialog body).
      if (active === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    dialog?.focus();
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onDismiss]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-mask-1 px-6"
      onClick={onDismiss}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vex-license-title"
        tabIndex={-1}
        className={cn(
          "w-full max-w-md outline-none",
          // One-shot rise-and-settle on mount (the landing dialog law:
          // modals never pop); reduced motion collapses it globally.
          "vex-entry-settle",
          "border border-[var(--color-border)] bg-surface-1 p-6 text-ink-primary",
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <h2
          id="vex-license-title"
          className="mb-4 font-mono text-[11px] uppercase tracking-[var(--tracking-eyebrow)]"
        >
          Docker Desktop license
        </h2>
        <p className="mb-3 text-sm leading-relaxed text-ink-secondary">
          Docker Desktop is a third-party product distributed by Docker, Inc.
          Larger commercial and government use may require a paid Docker
          subscription. By downloading and installing it you agree to
          Docker&rsquo;s terms.
        </p>
        <p className="mb-4 text-sm leading-relaxed text-ink-secondary">
          Vex does not manage your Docker license - it only starts and stops
          its own local services through Docker&rsquo;s public CLI.
        </p>
        <button
          type="button"
          onClick={openDocs}
          className="mb-5 inline-flex items-center gap-1 text-sm text-[var(--vex-accent-text,var(--color-accent-primary))] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-onboarding-accent,var(--color-accent-primary))] focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1"
        >
          Docker Desktop license terms
          <IconArrowUpRight size={14} />
        </button>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="quiet" size="sm" onClick={onDismiss}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={onAccept}>
            Continue to download
          </Button>
        </div>
      </div>
    </div>
  );
}
