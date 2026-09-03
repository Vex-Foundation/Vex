/**
 * `vex.search.*` - the preload gate for Vex Studio's go-to-file surface.
 *
 * EVERY INPUT IS VALIDATED HERE, before it reaches an invoke, with the same
 * strict schemas main parses it with. That is not redundant with main's own
 * validation: a renderer bug is caught in the process that made it, with a
 * `validation.invalid_input` the component can act on, rather than as a
 * contract violation logged in the privileged process.
 *
 * NO EVENT ROUTING and no flow control, unlike `files.ts`: this surface is
 * request/response only. There is no push, so there is nothing to acknowledge
 * and no listener to attach or release.
 *
 * CANCELLATION IS THE CALLER'S, and deliberately not this module's. A newer
 * keystroke supersedes an older one in the RENDERER, which drops the stale
 * answer by request identity; the main-side work a query does is a bounded
 * in-memory ranking pass, so cancelling it would cost more than letting it
 * finish. The walk that is genuinely long is per SESSION, not per keystroke,
 * and it is ended by `releaseSession`.
 */

import { CH } from "../../shared/ipc/channels.js";
import {
  searchFileNamesInputSchema,
  searchReleaseSessionInputSchema,
} from "../../shared/schemas/studio-search.js";
import type { SearchBridge } from "../../shared/types/bridge/shell/search.js";
import { invokeWithSchema } from "../_dispatch.js";

export const search = {
  fileNames(input) {
    return invokeWithSchema(CH.search.fileNames, input, searchFileNamesInputSchema);
  },

  releaseSession(input) {
    return invokeWithSchema(
      CH.search.releaseSession,
      input,
      searchReleaseSessionInputSchema,
    );
  },
} satisfies SearchBridge;
