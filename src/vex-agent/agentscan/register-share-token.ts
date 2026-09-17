import { generateShareToken } from "./share-token.js";
import {
  buildShareTokenClient,
  type RegisterShareTokenOutcome,
} from "./share-token-client.js";

export type { RegisterShareTokenOutcome };

export interface ShareTokenProcedureState {
  readonly ingestToken: string | null;
  readonly shareToken: string | null;
  readonly shareTokenRegisteredAt: string | null;
  readonly shareTokenRotationCandidate: string | null;
  readonly registrationGeneration: number;
}

export interface ShareTokenProcedureDeps {
  readonly baseUrl: () => string | null;
  readonly getState: () => Promise<ShareTokenProcedureState>;
  readonly persistShareToken: (token: string) => Promise<void>;
  readonly persistRotationCandidate: (token: string) => Promise<void>;
  readonly markShareTokenRegistered: (input: {
    registrationGeneration: number;
    shareToken: string;
  }) => Promise<boolean>;
  readonly commitShareTokenRotation: (input: {
    registrationGeneration: number;
    previousShareToken: string;
    candidate: string;
  }) => Promise<boolean>;
  readonly generate?: () => string;
  readonly post?: ReturnType<typeof buildShareTokenClient>["register"];
}

export async function registerPersistedShareToken(
  deps: ShareTokenProcedureDeps,
): Promise<RegisterShareTokenOutcome> {
  let state = await deps.getState();
  const baseUrl = deps.baseUrl();
  if (state.ingestToken === null || baseUrl === null) return { kind: "not_ready" };

  if (state.shareToken === null) {
    await deps.persistShareToken((deps.generate ?? generateShareToken)());
    // Read credentials and generation together with the write-once winner.
    state = await deps.getState();
  }
  if (state.ingestToken === null || state.shareToken === null) return { kind: "not_ready" };

  if (state.shareTokenRotationCandidate !== null) {
    return sendRotationAttempt(deps, baseUrl, {
      ingestToken: state.ingestToken,
      shareToken: state.shareToken,
      shareTokenRotationCandidate: state.shareTokenRotationCandidate,
      registrationGeneration: state.registrationGeneration,
    });
  }

  const post = deps.post ?? buildShareTokenClient(baseUrl).register;
  const outcome = await post({ ingestToken: state.ingestToken, shareToken: state.shareToken });
  if (outcome.kind === "registered") {
    const applied = await deps.markShareTokenRegistered({
      registrationGeneration: state.registrationGeneration,
      shareToken: state.shareToken,
    });
    if (!applied) return { kind: "not_ready" };
  }
  return outcome;
}

export type RotateShareTokenOutcome =
  | RegisterShareTokenOutcome
  | { readonly kind: "rotation_not_allowed"; readonly reason: "not_registered" | "not_ready" };

export async function rotatePersistedShareToken(
  deps: ShareTokenProcedureDeps,
): Promise<RotateShareTokenOutcome> {
  let state = await deps.getState();
  const baseUrl = deps.baseUrl();
  if (state.ingestToken === null || baseUrl === null) {
    return { kind: "rotation_not_allowed", reason: "not_ready" };
  }

  // A pending rotation is retried, never replaced: an unknown outcome may
  // already have applied the candidate server-side, and the server treats a
  // re-sent candidate for a completed rotation as success.
  if (state.shareTokenRotationCandidate !== null) {
    if (state.shareToken === null) return { kind: "rotation_not_allowed", reason: "not_ready" };
    return sendRotationAttempt(deps, baseUrl, {
      ingestToken: state.ingestToken,
      shareToken: state.shareToken,
      shareTokenRotationCandidate: state.shareTokenRotationCandidate,
      registrationGeneration: state.registrationGeneration,
    });
  }

  if (state.shareToken === null || state.shareTokenRegisteredAt === null) {
    return { kind: "rotation_not_allowed", reason: "not_registered" };
  }

  await deps.persistRotationCandidate((deps.generate ?? generateShareToken)());
  // The persisted candidate wins if two callers raced: re-read everything.
  state = await deps.getState();
  if (
    state.ingestToken === null ||
    state.shareToken === null ||
    state.shareTokenRotationCandidate === null
  ) {
    return { kind: "rotation_not_allowed", reason: "not_ready" };
  }
  return sendRotationAttempt(deps, baseUrl, {
    ingestToken: state.ingestToken,
    shareToken: state.shareToken,
    shareTokenRotationCandidate: state.shareTokenRotationCandidate,
    registrationGeneration: state.registrationGeneration,
  });
}

/**
 * Send the persisted candidate with `replaces` naming the current token, and
 * commit the rotation when the server acknowledges it. The commit is fenced on
 * the generation read BEFORE the request, so a late success for a rotation
 * that recovery has since abandoned publishes nothing.
 */
async function sendRotationAttempt(
  deps: ShareTokenProcedureDeps,
  baseUrl: string,
  state: {
    readonly ingestToken: string;
    readonly shareToken: string;
    readonly shareTokenRotationCandidate: string;
    readonly registrationGeneration: number;
  },
): Promise<RegisterShareTokenOutcome> {
  const post = deps.post ?? buildShareTokenClient(baseUrl).register;
  const outcome = await post({
    ingestToken: state.ingestToken,
    shareToken: state.shareTokenRotationCandidate,
    replaces: state.shareToken,
  });
  if (outcome.kind === "registered") {
    const applied = await deps.commitShareTokenRotation({
      registrationGeneration: state.registrationGeneration,
      previousShareToken: state.shareToken,
      candidate: state.shareTokenRotationCandidate,
    });
    if (!applied) return { kind: "not_ready" };
  }
  return outcome;
}
