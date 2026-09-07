import { generateShareToken } from "./share-token.js";
import {
  buildShareTokenClient,
  type RegisterShareTokenOutcome,
} from "./share-token-client.js";

export type { RegisterShareTokenOutcome };

export async function registerPersistedShareToken(deps: {
  baseUrl: () => string | null;
  getState: () => Promise<{ ingestToken: string | null; shareToken: string | null }>;
  persistShareToken: (token: string) => Promise<void>;
  markShareTokenRegistered: () => Promise<void>;
  generate?: () => string;
  post?: ReturnType<typeof buildShareTokenClient>["register"];
  mode: "ensure" | "rotate";
}): Promise<RegisterShareTokenOutcome> {
  const state = await deps.getState();
  const baseUrl = deps.baseUrl();
  if (state.ingestToken === null || baseUrl === null) return { kind: "not_ready" };

  const generate = deps.generate ?? generateShareToken;
  let shareToken = state.shareToken;
  if (deps.mode === "rotate" || shareToken === null) {
    shareToken = generate();
    await deps.persistShareToken(shareToken);
  }

  const post = deps.post ?? buildShareTokenClient(baseUrl).register;
  const outcome = await post({ ingestToken: state.ingestToken, shareToken });
  if (outcome.kind === "registered") await deps.markShareTokenRegistered();
  return outcome;
}
