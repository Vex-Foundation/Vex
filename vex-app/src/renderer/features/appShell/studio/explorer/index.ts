/**
 * THE PUBLIC GATE of the Studio explorer.
 *
 * B4 mounts the tree in the Studio sidebar and owns which projects stay alive;
 * B3c replaces what a file row opens into. Everything else here - the model,
 * the session, the keyboard table, the copy, the row - is an implementation
 * detail of this folder and is imported through its own module by its own
 * tests only.
 *
 * The registry is exported as the LIVE INSTANCE plus its class: the instance is
 * what the app uses, the class is what a test constructs so two suites never
 * share one process-wide registry.
 */

export { ExplorerTree, type ExplorerTreeProps } from "./ExplorerTree.js";
export { ExplorerHeader, type ExplorerHeaderProps } from "./ExplorerHeader.js";
export { ExplorerRegistry, explorerRegistry } from "./explorer-registry.js";
export type { ExplorerSession, ExplorerSessionState } from "./explorer-session.js";
export type {
  ExplorerRow,
  ExplorerNodeRow,
  ExplorerLoadMoreRow,
  ExplorerNoticeRow,
} from "./explorer-rows.js";
