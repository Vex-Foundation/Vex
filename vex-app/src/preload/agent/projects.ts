import { CH } from "../../shared/ipc/channels.js";
import {
  projectCreateInputSchema,
  projectGetInputSchema,
  projectUpdateScopeInputSchema,
} from "../../shared/schemas/projects.js";
import type {
  ProjectCreateInput,
  ProjectGetInput,
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
} satisfies ProjectsBridge;
