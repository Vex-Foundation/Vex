/**
 * Mission preload bridge — per-command input validation (puzzle 04
 * phase 6). Each method validates its input against the matching
 * `missionXxxInputSchema` and forwards via `invokeWithSchema`.
 *
 * The output type comes from the shared per-command result schema
 * (the discriminated union); preload-side input validation is the
 * first guard, main-side `registerHandler` re-validates input + the
 * output before returning to renderer.
 */

import { CH } from "../../shared/ipc/channels.js";
import {
  missionAcceptContractInputSchema,
  missionContinueInputSchema,
  missionGetDiffInputSchema,
  missionGetDraftInputSchema,
  missionGetRenewableSourceInputSchema,
  missionRecoverInputSchema,
  missionRenewInputSchema,
  missionEditInputSchema,
  missionRetryInputSchema,
  missionSetAutoRetryInputSchema,
  missionStartInputSchema,
  missionStopInputSchema,
  missionUpdateDraftInputSchema,
} from "../../shared/schemas/mission.js";
import type {
  MissionAcceptContractInput,
  MissionContinueInput,
  MissionGetDiffInput,
  MissionGetDraftInput,
  MissionGetRenewableSourceInput,
  MissionRecoverInput,
  MissionRenewInput,
  MissionEditInput,
  MissionRetryInput,
  MissionSetAutoRetryInput,
  MissionStartInput,
  MissionStopInput,
  MissionUpdateDraftInput,
} from "../../shared/schemas/mission.js";
import type { MissionBridge } from "../../shared/types/bridge/agent/mission.js";
import { invokeWithSchema } from "../_dispatch.js";

export const mission = {
  getDraft(input: MissionGetDraftInput) {
    return invokeWithSchema(
      CH.mission.getDraft,
      input,
      missionGetDraftInputSchema,
    );
  },
  updateDraft(input: MissionUpdateDraftInput) {
    return invokeWithSchema(
      CH.mission.updateDraft,
      input,
      missionUpdateDraftInputSchema,
    );
  },
  getDiff(input: MissionGetDiffInput) {
    return invokeWithSchema(
      CH.mission.getDiff,
      input,
      missionGetDiffInputSchema,
    );
  },
  acceptContract(input: MissionAcceptContractInput) {
    return invokeWithSchema(
      CH.mission.acceptContract,
      input,
      missionAcceptContractInputSchema,
    );
  },
  start(input: MissionStartInput) {
    return invokeWithSchema(
      CH.mission.start,
      input,
      missionStartInputSchema,
    );
  },
  continue(input: MissionContinueInput) {
    return invokeWithSchema(
      CH.mission.continue,
      input,
      missionContinueInputSchema,
    );
  },
  recover(input: MissionRecoverInput) {
    return invokeWithSchema(
      CH.mission.recover,
      input,
      missionRecoverInputSchema,
    );
  },
  renew(input: MissionRenewInput) {
    return invokeWithSchema(
      CH.mission.renew,
      input,
      missionRenewInputSchema,
    );
  },
  retry(input: MissionRetryInput) {
    return invokeWithSchema(
      CH.mission.retry,
      input,
      missionRetryInputSchema,
    );
  },
  edit(input: MissionEditInput) {
    return invokeWithSchema(
      CH.mission.edit,
      input,
      missionEditInputSchema,
    );
  },
  stop(input: MissionStopInput) {
    return invokeWithSchema(
      CH.mission.stop,
      input,
      missionStopInputSchema,
    );
  },
  getRenewableSource(input: MissionGetRenewableSourceInput) {
    return invokeWithSchema(
      CH.mission.getRenewableSource,
      input,
      missionGetRenewableSourceInputSchema,
    );
  },
  setAutoRetry(input: MissionSetAutoRetryInput) {
    return invokeWithSchema(
      CH.mission.setAutoRetry,
      input,
      missionSetAutoRetryInputSchema,
    );
  },
} satisfies MissionBridge;
