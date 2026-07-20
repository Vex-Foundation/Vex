/**
 * Mission IPC barrel — registers every mission handler (one per file).
 *
 * Layout mirrors `runtime/`: one handler per file, shared helpers in
 * `_engine-dispatch.ts`, this barrel composes them.
 *
 * `updateDraft` stays fail-closed (the structured setup form lands in a
 * later phase); `setAutoRetry` (phase 4d-5) is the first live host-side
 * constraints writer.
 */

import { registerMissionAcceptContractHandler } from "./accept-contract.js";
import { registerMissionContinueHandler } from "./continue.js";
import { registerMissionEditHandler } from "./edit.js";
import { registerMissionGetDiffHandler } from "./get-diff.js";
import { registerMissionGetDraftHandler } from "./get-draft.js";
import { registerMissionGetRenewableSourceHandler } from "./get-renewable-source.js";
import { registerMissionGetResultForRunHandler } from "./get-result-for-run.js";
import { registerMissionGetSessionResultHandler } from "./get-session-result.js";
import { registerMissionListResultsHandler } from "./list-results.js";
import { registerMissionRecoverHandler } from "./recover.js";
import { registerMissionRenewHandler } from "./renew.js";
import { registerMissionRetryHandler } from "./retry.js";
import { registerMissionSetAutoRetryHandler } from "./set-auto-retry.js";
import { registerMissionStartHandler } from "./start.js";
import { registerMissionStopHandler } from "./stop.js";
import { registerMissionUpdateDraftHandler } from "./update-draft.js";

export function registerMissionHandlers(): ReadonlyArray<() => void> {
  return [
    registerMissionGetDraftHandler(),
    registerMissionUpdateDraftHandler(),
    registerMissionGetDiffHandler(),
    registerMissionAcceptContractHandler(),
    registerMissionStartHandler(),
    registerMissionContinueHandler(),
    registerMissionRecoverHandler(),
    registerMissionRetryHandler(),
    registerMissionEditHandler(),
    registerMissionRenewHandler(),
    registerMissionStopHandler(),
    registerMissionGetRenewableSourceHandler(),
    registerMissionSetAutoRetryHandler(),
    registerMissionListResultsHandler(),
    registerMissionGetResultForRunHandler(),
    registerMissionGetSessionResultHandler(),
  ];
}
