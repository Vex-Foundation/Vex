import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { AnswerTerminalLinkInput, OpenTerminalLinkValue, TerminalLinkProposal, TerminalLinkRefusal } from "@shared/schemas/terminal-links.js";
import { answerTerminalLink, cancelTerminalLink, openTerminalLink } from "../../../../lib/api/terminal-links.js";
import { TerminalLinkDialog } from "./TerminalLinkDialog.js";

type Choice = Pick<AnswerTerminalLinkInput, "choice" | "rememberHost">;
interface Interaction {
  readonly controller: AbortController;
  proposalId?: string;
  resolveChoice?: (choice: Choice | null) => void;
}
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
  terminal_link_proposal_limit: "Vex has too many pending link requests. Close a request and try again.",
};

function outcomeMessage(result: Result<OpenTerminalLinkValue>): string | null {
  if (!result.ok) return result.error.message;
  switch (result.data.kind) {
    case "opened": return null;
    case "copied": return "Link copied. No link was opened.";
    case "declined": return "Link opening declined. No link was opened.";
    case "cancelled": return "The link request was cancelled.";
    case "refused": return REFUSAL_MESSAGES[result.data.reason];
    case "pending": return "Vex could not complete this link request. Click the link again.";
  }
}

/** One visible proposal owns its answer, expiry and pane-lifetime cancellation. */
export function useTerminalLinkConsent(onNotice: (message: string | null) => void): {
  readonly openLink: (url: string, signal: AbortSignal) => Promise<void>;
  readonly dialog: JSX.Element | null;
} {
  const [proposal, setProposal] = useState<TerminalLinkProposal | null>(null);
  const active = useRef<Interaction | null>(null);
  const mounted = useRef(true);
  const notice = useRef(onNotice);
  notice.current = onNotice;
  const report = useCallback((message: string | null): void => {
    if (mounted.current) notice.current(message);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
    };
  }, []);

  const openLink = useCallback(async (url: string, signal: AbortSignal): Promise<void> => {
    if (signal.aborted || !mounted.current) { report("The link request was cancelled."); return; }
    if (active.current !== null) { report("Finish the current link request before opening another link."); return; }
    const interaction: Interaction = { controller: new AbortController() };
    active.current = interaction;
    const abort = (): void => interaction.controller.abort();
    const clearPrompt = (): void => {
      interaction.resolveChoice?.(null);
      if (mounted.current) setProposal(null);
    };
    interaction.controller.signal.addEventListener("abort", clearPrompt, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingProposal: TerminalLinkProposal | undefined;
    let expired = false;
    try {
      const result = await openTerminalLink(url, interaction.controller.signal);
      if (!result.ok || result.data.kind !== "pending") { report(outcomeMessage(result)); return; }
      pendingProposal = result.data.proposal;
      if (interaction.controller.signal.aborted) {
        report(outcomeMessage(await cancelTerminalLink(pendingProposal.id)));
        pendingProposal = undefined;
        return;
      }
      const remaining = pendingProposal.expiresAt - Date.now();
      if (remaining <= 0) {
        report(outcomeMessage(await cancelTerminalLink(pendingProposal.id)));
        pendingProposal = undefined;
        report(REFUSAL_MESSAGES.terminal_link_proposal_expired);
        return;
      }
      interaction.proposalId = pendingProposal.id;
      const choicePromise = new Promise<Choice | null>(resolve => { interaction.resolveChoice = resolve; });
      timer = setTimeout(() => {
        expired = true;
        clearPrompt();
        report(REFUSAL_MESSAGES.terminal_link_proposal_expired);
      }, remaining);
      setProposal(pendingProposal);
      const choice = await choicePromise;
      clearTimeout(timer);
      if (mounted.current) setProposal(null);
      if (choice === null || interaction.controller.signal.aborted) {
        const cancellation = await cancelTerminalLink(pendingProposal.id);
        pendingProposal = undefined;
        report(expired && cancellation.ok && cancellation.data.kind === "cancelled"
          ? REFUSAL_MESSAGES.terminal_link_proposal_expired : outcomeMessage(cancellation));
        return;
      }
      const answer = await answerTerminalLink({ proposalId: pendingProposal.id, ...choice }, interaction.controller.signal);
      report(outcomeMessage(answer));
      if (!(answer.ok && answer.data.kind === "cancelled")) pendingProposal = undefined;
    } catch {
      report("Vex could not complete the link request. Try again.");
    } finally {
      clearTimeout(timer);
      interaction.controller.signal.removeEventListener("abort", clearPrompt);
      signal.removeEventListener("abort", abort);
      if (pendingProposal !== undefined) {
        try { report(outcomeMessage(await cancelTerminalLink(pendingProposal.id))); }
        catch { report("Vex could not cancel the link request. It will expire without opening a link."); }
      }
      if (active.current === interaction) active.current = null;
      if (mounted.current) setProposal(null);
    }
  }, [report]);

  return {
    openLink,
    dialog: proposal === null ? null : <TerminalLinkDialog key={proposal.id} proposal={proposal} onAnswer={(choice, rememberHost) => {
      const interaction = active.current;
      if (interaction === null || interaction.proposalId !== proposal.id || interaction.controller.signal.aborted) return;
      const resolve = interaction.resolveChoice;
      interaction.resolveChoice = undefined;
      resolve?.({ choice, rememberHost });
    }} />,
  };
}
