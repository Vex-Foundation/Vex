import "./styles/globals.css";
import { createRoot } from "react-dom/client";
import { terminalLinkProposalSchema } from "@shared/schemas/terminal-links.js";
import type { TerminalLinkConsentBridge } from "@shared/types/bridge/shell/terminal-links.js";
import { TerminalLinkDialog } from "./features/appShell/studio/terminal/TerminalLinkDialog.js";

declare global { interface Window { readonly terminalLinkConsent: TerminalLinkConsentBridge } }

const root = document.getElementById("root");
if (root !== null) {
  try {
    const proposal = terminalLinkProposalSchema.parse(JSON.parse(decodeURIComponent(window.location.hash.slice(1))));
    createRoot(root).render(<TerminalLinkDialog proposal={proposal} onAnswer={(choice, rememberHost) => {
      void window.terminalLinkConsent.answer({ proposalId: proposal.id, choice, rememberHost });
    }} />);
  } catch {
    root.textContent = "Vex could not display this link request. Close this window and try again.";
  }
}
