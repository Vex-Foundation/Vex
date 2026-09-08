import type { AbortableInvocation } from "../common.js";
import type { Result } from "../../../ipc/result.js";
import type {
  AnswerTerminalLinkInput,
  CancelTerminalLinkInput,
  OpenTerminalLinkInput,
  OpenTerminalLinkValue,
} from "../../../schemas/terminal-links.js";

/** Main owns URL policy, single-use proposals, host trust and browser effects. */
export interface TerminalLinksBridge {
  readonly open: (input: OpenTerminalLinkInput) => AbortableInvocation<OpenTerminalLinkValue>;
  readonly answer: (input: AnswerTerminalLinkInput) => AbortableInvocation<OpenTerminalLinkValue>;
  /** Withdraw a pending proposal on pane teardown or abandoned interaction. */
  readonly cancel: (input: CancelTerminalLinkInput) => Promise<Result<OpenTerminalLinkValue>>;
}
