import type { AbortableInvocation } from "../common.js";
import type { Result } from "../../../ipc/result.js";
import type { AnswerTerminalLinkInput, OpenTerminalLinkInput, OpenTerminalLinkValue, TerminalLinkOpenOptions } from "../../../schemas/terminal-links.js";

/** The proposing renderer cannot answer its own link requests. */
export interface TerminalLinksBridge {
  readonly open: {
    (input: OpenTerminalLinkInput): Promise<Result<OpenTerminalLinkValue>>;
    (input: OpenTerminalLinkInput, options: TerminalLinkOpenOptions): AbortableInvocation<OpenTerminalLinkValue>;
  };
}
/** Exposed only in the separate main-owned consent window. */
export interface TerminalLinkConsentBridge {
  readonly answer: (input: AnswerTerminalLinkInput) => Promise<Result<OpenTerminalLinkValue>>;
}
