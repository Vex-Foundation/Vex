/**
 * User backdrop - public entry point.
 *
 * Explicit re-exports, no `export *`. `store.ts` is internal: nothing outside
 * this folder resolves a path into the backdrop directory, and nothing
 * outside it names a file. Callers pass nothing (there is one backdrop) or,
 * on the protocol path, an opaque id the route matcher already validated.
 */

export {
  clearShellBackdrop,
  installShellBackdropFromFile,
  readShellBackdrop,
  shellBackdropUrl,
  type InstallBackdropOutcome,
} from "./service.js";

export {
  matchUserBackdropRoute,
  serveUserBackdrop,
  type UserBackdropRoute,
} from "./serve.js";

export {
  validateShellBackdropBytes,
  type ShellBackdropRejection,
  type ShellBackdropValidation,
} from "./validation.js";
