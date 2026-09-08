import { generateShareToken } from "./share-token.js";
import {
  buildShareTokenClient,
  type RegisterShareTokenOutcome,
} from "./share-token-client.js";

export type { RegisterShareTokenOutcome };

export async function registerPersistedShareToken(deps: {
  baseUrl: () => string | null;
  getState: () => Promise<{
    ingestToken: string | null;
    shareToken: string | null;
    registrationGeneration: number;
  }>;
  persistShareToken: (token: string) => Promise<void>;
  markShareTokenRegistered: (input: {
    registrationGeneration: number;
    shareToken: string;
  }) => Promise<boolean>;
  generate?: () => string;
  post?: ReturnType<typeof buildShareTokenClient>["register"];
}): Promise<RegisterShareTokenOutcome> {
  let state = await deps.getState();
  const baseUrl = deps.baseUrl();
  if (state.ingestToken === null || baseUrl === null) return { kind: "not_ready" };

  if (state.shareToken === null) {
    await deps.persistShareToken((deps.generate ?? generateShareToken)());
    // Read credentials and generation together with the write-once winner.
    state = await deps.getState();
  }
  if (state.ingestToken === null || state.shareToken === null) return { kind: "not_ready" };

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
