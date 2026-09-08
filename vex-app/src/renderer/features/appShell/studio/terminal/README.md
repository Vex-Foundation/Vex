# Terminal input and external links

`XtermHost` attaches a registry terminal to its visible pane. It delegates clipboard and paste lifetime to `useTerminalInput`, file drag decoration to `useTerminalFileDrop`, external-link consent to `useTerminalLinkConsent`, and user-facing outcomes to the branded `TerminalNotice`. These owners do not change PTY lifetime, replay, resizing, or ordinary shell input.

## Clipboard

The renderer never uses the browser clipboard API on this path. `terminalInput` is the narrow preload namespace; strict shared schemas and `registerHandler` validate native main-process clipboard operations. Browser permissions remain denied.

`readClipboardContent` prefers nonempty text, then local file availability, then image, then empty. Files precede images because a copied file can also include a file icon. Text is refused whole above 1,048,576 UTF-16 code units. It is never silently cut. Copy and OSC 52 use the same bounded main-owned text service. OSC 52 PRIMARY selection requests are reported as unsupported instead of being redirected to the ordinary clipboard.

Text goes through the paste policy and `terminal.paste()`. Image paste sends raw user input to the PTY: Ctrl+V on macOS/Linux and Alt+V on Windows. It leaves the original image on the OS clipboard for the running program to read. This reports that a shortcut was sent, not that the program attached the image.

For copied files, main identifies a native file transfer and asks Chromium to deliver a native paste event. The pane intercepts it before xterm, then resolves the File objects using the narrow preload `files.getPathForFile` method. No custom Finder/Explorer format parser is maintained. Native Edit > Paste and Copy also pass the pane's capture listeners.

## File insertion

Drops and copied files insert between 1 and 32 paths together, separated by spaces. Paths are quoted individually. The batch is refused whole if any path cannot be resolved, contains control characters, or exceeds the combined 32,768-code-unit insertion bound. No newline or execution prefix is appended.

macOS/Linux use POSIX single quotes with literal apostrophe escaping. Windows uses double quotes for paths that need no shell-specific expansion rules. Paths containing percent, exclamation, dollar, backtick, double quote, or a trailing backslash receive a specific quoting notice. The pane has no authoritative live shell dialect; guessing between cmd, PowerShell, Git Bash, or WSL would be unsafe. Automatic shell detection and WSL path translation remain outside this change.

## Paste policy

Bracketed-paste mode suppresses the multiline warning and preserves the text. Otherwise one final line ending is removed, including when warnings are disabled. Remaining multiple lines require Paste, Paste as one line, or Cancel. One-line paste replaces line endings with spaces to keep adjacent words separate.

The default preview shows up to three lines with thirty characters per line, explicitly reports omitted or shortened content, and offers Show all text. The full text remains available in the dialog. Don't ask again persists only on a confirmed choice through the UI store's validated `terminalPasteWarning` preference. Paste contents and link proposals are never persisted.

## Link authority

Both OSC 8 and detected web links require Cmd+left-click on macOS or Ctrl+left-click elsewhere. The hint uses the shared platform label owner and textContent for untrusted link text. Its timer and element are cleared on leave, scroll, render, detach, hide, and disposal.

| Field or effect | Authority and invariant |
| --- | --- |
| Raw URL and both host spellings | Main validates and stores them. Renderer displays them whole. Answers carry no replacement URL or host. |
| Proposal ID and expiry | Main creates a random UUID and a 120-second deadline. Missing or expired answers open nothing. |
| Window | Sender validation requires the trusted top frame. A proposal belongs to exactly one webContents ID. |
| Answer | Main consumes the proposal once before any external side effect. Unknown, expired, cancelled, replayed, and other-window proposals have named refusals. |
| Copy | Main copies the proposal's raw URL. It neither opens nor remembers the host. |
| Open | Main rechecks URL policy and invokes shell.openExternal with the original string. |
| Remembered host | Main remembers only an explicit successful Open, at most 128 hosts per window. Navigation, destruction, and app shutdown clear trust. |
| Bounds | At most 32 live proposals per window and 1,024 proposal records globally. Only closed diagnostic records can be evicted to admit another proposal. |
| Cancellation | The pane's signal cancels open/answer IPC and withdraws a late-arriving proposal. An OS browser invocation cannot be undone after dispatch. |

The dialog uses the shared native-dialog primitive, initial Cancel focus, and `VexMark` with `text-brand-mark`. The token is white in the dark Chronos theme and brand blue in the light Celeris theme. Copy, decline, refusal, cancellation, and transport failure are surfaced through the same branded notice owner.

Literal localhost, 127.0.0.1, and [::1] are automatically trusted. Other hosts retain consent. The separate application-link allowlist and navigation policy remain unchanged.

## Reference decisions

The reference clone is `/home/kubas/Vex/agents-colab/vscode`. Relevant implementations and tests:

- `src/vs/workbench/contrib/terminalContrib/links/browser/terminalLink.ts`, `terminalLinkManager.ts`, `terminalLinkOpeners.ts`, and their `test/browser` suites: modifier activation, delayed cancellable hints, original URL preservation.
- `src/vs/workbench/contrib/url/browser/trustedDomainsValidator.ts`, `trustedDomains.ts`, and `test/browser/trustedDomains.test.ts`: Copy without Open and safe default cancellation.
- `src/vs/workbench/contrib/terminalContrib/clipboard/browser/terminalClipboard.ts`, `terminal.clipboard.contribution.ts`, and `test/browser/terminalClipboard.test.ts`: bracketed-paste suppression, multiline confirmation, clipboard resources, and keyboard arbitration.
- `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts`, `common/terminalEnvironment.ts`, and `test/common/terminalEnvironment.test.ts`: path insertion without execution, file-drop lifetime, and shell-dependent quoting.
- `src/vs/workbench/services/clipboard/electron-browser/clipboardService.ts`, `src/vs/platform/native/electron-main/nativeHostMainService.ts`, and `src/vs/base/parts/sandbox/electron-browser/preload.ts`: native clipboard ownership and the narrow webUtils bridge.

Vex deliberately does not adopt durable wildcard trust, configurable additional link schemes, shortened consent URLs, first-file-only insertion, executable path prefixes, or shell-specific transformations without authoritative shell metadata. VS Code additionally trusts localhost subdomains; Vex retains consent for them. Its resource fallback reads private `code/file-list` data, not generic Finder/Explorer formats. Its one-line paste joins lines without a separator; Vex inserts spaces. Vex also strips a final newline while its warning preference is disabled.

Small additional affordances are Windows Ctrl+V, Linux Shift+Insert using the ordinary clipboard, and Shift+right-click to open the context menu on Windows. Copy-on-selection remains off.

## Verification limits

Unit and native integration probes cover the available Linux environment. A native clipboard probe is distinct from a complete foreground-program attachment or OS browser-opening test. Before platform acceptance, verify the built app on macOS and Windows: selected-text copy via keyboard/context menu; text, screenshot, and copied-file paste; file drop; native Edit actions; multiline Cancel focus; both OSC 8 and detected links; branded refusals and declines in both themes; and the default browser actually opening. Image attachment also depends on the foreground terminal program handling the forwarded key.
