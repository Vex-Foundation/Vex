/**
 * Public gate for the Studio terminal surface.
 *
 * B4 mounts `StudioWorkspaceController` behind its `runtimeMode` dispatch and
 * needs nothing else: the controller owns the strip, the splits, the hosts, the
 * restore and the persistence. The registry is exported because window teardown
 * has to be able to dispose every terminal, and the two lower seams are exported
 * for tests and for a future consumer that renders a single pane.
 *
 * Everything else in this folder is an implementation detail with one owner.
 */

export { StudioWorkspaceController } from "./StudioWorkspaceController.js";
export type { StudioWorkspaceControllerProps } from "./StudioWorkspaceController.js";
export { TerminalTabs, TERMINAL_TABS_ID_SCOPE } from "./TerminalTabs.js";
export type { TerminalTabsProps } from "./TerminalTabs.js";
export { TerminalPaneGroup } from "./TerminalPaneGroup.js";
export type { TerminalPaneGroupProps } from "./TerminalPaneGroup.js";
export { XtermHost } from "./XtermHost.js";
export type { XtermHostProps } from "./XtermHost.js";
export {
  TerminalRegistry,
  terminalRegistry,
  TERMINAL_ACTIVE_CLASS,
  TERMINAL_WRAPPER_CLASS,
} from "./terminal-registry.js";
export type {
  FittedSize,
  TerminalEntry,
  TerminalRegistryOptions,
} from "./terminal-registry.js";
export {
  enableWebglRenderer,
  importWebglAddon,
  RendererPreference,
  sharedRendererPreference,
} from "./webgl-renderer.js";
export type {
  WebglAddonConstructor,
  WebglAddonLoader,
  WebglAddonLike,
  WebglAttachment,
} from "./webgl-renderer.js";
