import { contextBridge } from "electron";
import { CH } from "../shared/ipc/channels.js";
import { answerTerminalLinkInputSchema } from "../shared/schemas/terminal-links.js";
import type { TerminalLinkConsentBridge } from "../shared/types/bridge/shell/terminal-links.js";
import { invokeWithSchema } from "./_dispatch.js";
import { checkedTerminalLinkOutput } from "./shell/terminal-links.js";

const terminalLinkConsent = {
  answer(input) {
    return checkedTerminalLinkOutput(invokeWithSchema(CH.terminal.answerLink, input, answerTerminalLinkInputSchema));
  },
} satisfies TerminalLinkConsentBridge;
Object.freeze(terminalLinkConsent);
contextBridge.exposeInMainWorld("terminalLinkConsent", terminalLinkConsent);
