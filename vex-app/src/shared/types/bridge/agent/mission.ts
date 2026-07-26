import type { Result } from "../../../ipc/result.js";
import type {
  MissionAcceptContractInput,
  MissionAcceptContractResult,
  MissionContinueInput,
  MissionContinueResult,
  MissionGetDiffInput,
  MissionGetDiffResult,
  MissionGetDraftInput,
  MissionGetDraftResult,
  MissionGetRenewableSourceInput,
  MissionGetRenewableSourceResult,
  MissionRecoverInput,
  MissionRecoverResult,
  MissionRenewInput,
  MissionRenewResult,
  MissionEditInput,
  MissionEditResult,
  MissionRetryInput,
  MissionRetryResult,
  MissionSetAutoRetryInput,
  MissionSetAutoRetryResult,
  MissionStartInput,
  MissionStartResult,
  MissionStopInput,
  MissionStopResult,
  MissionUpdateDraftInput,
  MissionUpdateDraftResult,
} from "../../../schemas/mission.js";

/**
 * Mission draft + contract + command surface. Phase 6 ships 9 real
 * handlers + 1 fail-closed (`updateDraft` — structured setup form
 * lands in phase 7+). Phase 7 adds `getRenewableSource` so the
 * renderer can resolve the previousMissionId before calling `renew`.
 */
export interface MissionBridge {
  readonly getDraft: (
    input: MissionGetDraftInput,
  ) => Promise<Result<MissionGetDraftResult>>;
  readonly updateDraft: (
    input: MissionUpdateDraftInput,
  ) => Promise<Result<MissionUpdateDraftResult>>;
  readonly getDiff: (
    input: MissionGetDiffInput,
  ) => Promise<Result<MissionGetDiffResult>>;
  readonly acceptContract: (
    input: MissionAcceptContractInput,
  ) => Promise<Result<MissionAcceptContractResult>>;
  readonly start: (
    input: MissionStartInput,
  ) => Promise<Result<MissionStartResult>>;
  readonly continue: (
    input: MissionContinueInput,
  ) => Promise<Result<MissionContinueResult>>;
  readonly recover: (
    input: MissionRecoverInput,
  ) => Promise<Result<MissionRecoverResult>>;
  readonly renew: (
    input: MissionRenewInput,
  ) => Promise<Result<MissionRenewResult>>;
  readonly retry: (
    input: MissionRetryInput,
  ) => Promise<Result<MissionRetryResult>>;
  readonly edit: (
    input: MissionEditInput,
  ) => Promise<Result<MissionEditResult>>;
  readonly stop: (
    input: MissionStopInput,
  ) => Promise<Result<MissionStopResult>>;
  readonly getRenewableSource: (
    input: MissionGetRenewableSourceInput,
  ) => Promise<Result<MissionGetRenewableSourceResult>>;
  readonly setAutoRetry: (
    input: MissionSetAutoRetryInput,
  ) => Promise<Result<MissionSetAutoRetryResult>>;
}
