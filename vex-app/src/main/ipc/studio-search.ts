/**
 * `vex.search.*` - Vex Studio's go-to-file surface.
 *
 * Two handlers, both through `registerHandler`, so each gets sender and
 * subframe validation, a strict input schema, output validation and a redacted
 * `Result` for free. What is specific to this surface:
 *
 *  - NO CHANNEL HERE ACCEPTS OR RETURNS A PATH AS AN AUTHORITY. A match carries
 *    a project-relative path for DISPLAY and an opaque node token for opening,
 *    minted per response under the project's current epoch, exactly as a
 *    directory listing's rows are.
 *  - READ-ONLY, and not even a read of contents: this ranks names. Opening a
 *    match goes through `vex.files.readFile` with the token, which re-derives
 *    and re-checks the path on its own.
 *  - EVERY OUTCOME IS A SUCCESSFUL `Result` CARRYING A DISCRIMINATED OUTCOME,
 *    over the files surface's own error vocabulary. "The project was deleted"
 *    is an answer the UI renders as a statement, not an error.
 *  - THE SESSION IS A LIFETIME, NOT AN AUTHORITY. `sessionId` decides which
 *    index answers and when a fresh walk happens; it grants nothing, and every
 *    query re-establishes the project's authority from the database.
 */

import {
  searchFileNamesInputSchema,
  searchFileNamesResultSchema,
  searchReleaseSessionInputSchema,
  searchReleaseSessionResultSchema,
} from "@shared/schemas/studio-search.js";
import { CH } from "@shared/ipc/channels.js";
import { ok } from "@shared/ipc/result.js";

import { projectNameIndexes } from "../studio/search/search-composition.js";
import { registerHandler } from "./register-handler.js";

export function registerStudioSearchHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.search.fileNames,
      domain: "studio",
      inputSchema: searchFileNamesInputSchema,
      outputSchema: searchFileNamesResultSchema,
      handle: async (input) => ok(await projectNameIndexes().fileNames(input)),
    }),

    registerHandler({
      channel: CH.search.releaseSession,
      domain: "studio",
      inputSchema: searchReleaseSessionInputSchema,
      outputSchema: searchReleaseSessionResultSchema,
      handle: (input) =>
        Promise.resolve(ok(projectNameIndexes().releaseSession(input))),
    }),
  ];
}
