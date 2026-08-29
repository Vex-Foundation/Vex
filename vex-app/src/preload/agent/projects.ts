import { CH } from "../../shared/ipc/channels.js";
import {
  projectCreateInputSchema,
  projectDeleteInputSchema,
  projectGetInputSchema,
  projectRepairFilesInputSchema,
  projectUpdateScopeInputSchema,
} from "../../shared/schemas/projects.js";
import type {
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectGetInput,
  ProjectRepairFilesInput,
  ProjectUpdateScopeInput,
} from "../../shared/schemas/projects.js";
import type { ProjectsBridge } from "../../shared/types/bridge/agent/projects.js";
import { invokeWithSchema } from "../_dispatch.js";

export const projects = {
  create(input: ProjectCreateInput) {
    return invokeWithSchema(CH.projects.create, input, projectCreateInputSchema);
  },
  get(input: ProjectGetInput) {
    return invokeWithSchema(CH.projects.get, input, projectGetInputSchema);
  },
  list() {
    return invokeWithSchema(CH.projects.list, {});
  },
  updateScope(input: ProjectUpdateScopeInput) {
    return invokeWithSchema(
      CH.projects.updateScope,
      input,
      projectUpdateScopeInputSchema
    );
  },
  repairFiles(input: ProjectRepairFilesInput) {
    return invokeWithSchema(
      CH.projects.repairFiles,
      input,
      projectRepairFilesInputSchema
    );
  },
  // Validated at the GATE like every sibling: `projectDeleteInputSchema` is
  // strict, so a caller-supplied extra field is rejected by name here rather
  // than travelling to a handler that destroys authority.
  delete(input: ProjectDeleteInput) {
    return invokeWithSchema(CH.projects.delete, input, projectDeleteInputSchema);
  },
} satisfies ProjectsBridge;
