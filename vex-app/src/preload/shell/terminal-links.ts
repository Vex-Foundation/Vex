/**
 * `vex.terminalLinks.*` - the preload gate for opening a link a shell printed.
 *
 * Request/response only: no push, no port, no listener, nothing to release. The
 * input is validated HERE with the same strict schema main parses it with, so a
 * renderer bug surfaces as a `validation.invalid_input` in the process that
 * made it rather than as a contract violation logged in the privileged one.
 *
 * The renderer never sees `shell`, `dialog`, a `BrowserWindow` or a channel
 * string. It sees one domain method that takes a string.
 */

import { CH } from "../../shared/ipc/channels.js";
import { openTerminalLinkInputSchema } from "../../shared/schemas/terminal-links.js";
import type { TerminalLinksBridge } from "../../shared/types/bridge/shell/terminal-links.js";
import { invokeWithSchema } from "../_dispatch.js";

export const terminalLinks = {
  open(input) {
    return invokeWithSchema(CH.terminal.openLink, input, openTerminalLinkInputSchema);
  },
} satisfies TerminalLinksBridge;
