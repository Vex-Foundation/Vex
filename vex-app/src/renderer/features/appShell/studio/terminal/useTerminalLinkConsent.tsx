import { useCallback, useEffect, useRef } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { OpenTerminalLinkValue, TerminalLinkRefusal } from "@shared/schemas/terminal-links.js";
import { openTerminalLink } from "../../../../lib/api/terminal-links.js";

const REFUSAL_MESSAGES: Readonly<Record<TerminalLinkRefusal, string>> = {
  terminal_link_unparsable: "Vex could not read this link. Copy a complete website address and try again.",
  terminal_link_scheme_refused: "Vex opens only HTTP and HTTPS terminal links. Use a website address.",
  terminal_link_credentials_refused: "Vex did not open this link because it contains sign-in credentials. Use an address without credentials.",
  terminal_link_host_refused: "Vex could not identify a valid website host in this link.",
  terminal_link_too_long: "This link exceeds Vex's 4,096-character limit. The address was not shortened or opened.",
  terminal_link_open_failed: "Vex could not open your browser. Check your default browser and try again.",
  terminal_link_copy_failed: "Vex could not copy the link. Try copying it again.",
  terminal_link_proposal_unknown: "Vex could not find this link request. Click the link again.",
  terminal_link_proposal_expired: "This link request expired. Click the link again to review it.",
  terminal_link_proposal_already_answered: "This link request was already answered. Click the link again for a new request.",
  terminal_link_proposal_other_window: "This link request belongs to another Vex window. Click the link in this window again.",
  terminal_link_proposal_cancelled: "The link request was cancelled. No link was opened.",
  terminal_link_consent_unavailable: "Vex could not show link confirmation. No link was opened. Try again.",
  terminal_link_proposal_limit: "Vex has too many pending link requests. Close a request and try again.",
};

function outcomeMessage(result: Result<OpenTerminalLinkValue>): string | null {
  if (!result.ok) return result.error.message;
  switch (result.data.kind) {
    case "opened": return result.data.rememberLimitReached ? "Link opened. Vex could not remember this host because this window already remembers 128 hosts." : null;
    case "copied": return "Link copied. No link was opened.";
    case "declined": return "Link opening declined. No link was opened.";
    case "cancelled": return "The link request was cancelled.";
    case "refused": return REFUSAL_MESSAGES[result.data.reason];
  }
}

/** Main owns the consent window; this renderer receives only the final outcome. */
export function useTerminalLinkConsent(onNotice: (message: string | null) => void): {
  readonly openLink: (url: string, signal: AbortSignal) => Promise<void>;
} {
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const notice = useRef(onNotice);
  notice.current = onNotice;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);
  const openLink = useCallback(async (url: string, signal: AbortSignal): Promise<void> => {
    if (signal.aborted || !mounted.current) return;
    if (active.current !== null) { notice.current("Finish the current link request before opening another link."); return; }
    const controller = new AbortController();
    active.current = controller;
    const focusTarget = document.activeElement;
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await openTerminalLink(url, controller.signal);
      if (mounted.current) notice.current(outcomeMessage(result));
    } catch {
      if (mounted.current) notice.current("Vex could not complete the link request. Try again.");
    } finally {
      signal.removeEventListener("abort", abort);
      active.current = null;
      if (mounted.current && !signal.aborted && focusTarget instanceof HTMLElement && document.contains(focusTarget)) focusTarget.focus();
    }
  }, []);
  return { openLink };
}
