/**
 * THE PUBLIC GATE of the Studio file viewer.
 *
 * The workspace mounts {@link FileViewer} through the render prop `TerminalTabs`
 * takes, and the app shell disposes the registry when the window goes away.
 * Everything else here - the session, the copy, the tokenizer, the worker
 * protocol, the port - is an implementation detail of this folder, imported
 * through its own module by its own tests only.
 *
 * The registry is exported as the LIVE INSTANCE plus its class, the shape
 * `explorer/index.ts` established: the instance is what the app uses, the class
 * is what a test constructs so two suites never share one process-wide registry.
 *
 * The port TYPES are public because the registry's `createHighlighter` option
 * takes one; the two implementations are not, because choosing between them is
 * `defaultHighlighterPort`'s decision and nothing outside this folder should be
 * making it.
 */

export { FileViewer, type FileViewerProps } from "./FileViewer.js";
export { FileViewerRegistry, fileViewerRegistry } from "./file-viewer-registry.js";
export type { ViewerViewportObservers } from "./FileViewerLines.js";
export type {
  HighlightAsk,
  HighlighterPort,
  HighlightOutcome,
  HighlightUnavailableReason,
} from "./highlight/highlighter-port.js";
