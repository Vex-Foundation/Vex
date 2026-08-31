/**
 * Vex Studio projects IPC domain (stage P).
 *
 * Explicit named composition, no `export *`: `register-all.ts` calls one
 * function and the reachability guard in
 * `__tests__/ipc-channel-registration-reconciliation.test.ts` walks this barrel
 * to the five handler modules.
 */

import { registerProjectsCreateHandler } from "./create.js";
import { registerProjectsDeleteHandler } from "./delete.js";
import { registerProjectsGetHandler, registerProjectsListHandler } from "./read.js";
import { registerProjectsRepairFilesHandler } from "./repair.js";
import { registerProjectsUpdateScopeHandler } from "./scope.js";

export function registerProjectsHandlers(): Array<() => void> {
  return [
    registerProjectsCreateHandler(),
    registerProjectsDeleteHandler(),
    registerProjectsGetHandler(),
    registerProjectsListHandler(),
    registerProjectsUpdateScopeHandler(),
    registerProjectsRepairFilesHandler(),
  ];
}
