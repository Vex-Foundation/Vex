/**
 * The ticket gate's onboarding checklist: which of the three steps the chat
 * walks through (first deposit, trading key, fee approval) this session's
 * wallet has already completed.
 *
 * Read-only and address-only. The wallet comes from the session the same way
 * the AI lane resolves it (selected EVM wallet under the session's policy,
 * never a key decrypt); the deposit is the public Lighter account owned by
 * that address; the key is a scope in the unlocked vault for that account;
 * the fee is the same inspection the fee-setup tool runs.
 */

import type { WalletResolution } from "@tools/wallet/multi-auth.js";
import { buildLighterOnboardingReaders } from "@tools/lighter/wallet-funding/onboarding-readers.js";
import type { LighterOnboardingReaders } from "@tools/lighter/wallet-funding/onboarding-status.js";
import type { WalletPolicy } from "@vex-agent/engine/types.js";
import { resolveSelectedAddressForRead } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { LighterIntegrationEnvironment } from "@shared/schemas/lighter-integration.js";
import type { LighterOnboardingChecklist } from "@shared/schemas/lighter-trading.js";
import { inspectLighterFeeAuthorization } from "./fee-authorization-preparation.js";
import { listUnlockedLighterTradingCredentialScopes } from "../secrets/lighter-trading-credential.js";

export interface SessionWalletScope {
  /** The selected EVM address, resolved under the policy; the read-only variant. */
  readonly walletAddress: string;
  readonly walletResolution: WalletResolution;
  readonly walletPolicy: WalletPolicy;
}

export interface LighterOnboardingChecklistDeps {
  readonly readSessionWallet: (sessionId: string) => Promise<SessionWalletScope>;
  readonly readLighterAccount: LighterOnboardingReaders["readLighterAccount"];
  readonly hasTradingKey: (environment: LighterIntegrationEnvironment, accountIndex: number) => boolean;
  readonly inspectFee: typeof inspectLighterFeeAuthorization;
}

export async function resolveLighterOnboardingChecklist(
  input: { readonly sessionId: string; readonly environment: LighterIntegrationEnvironment },
  deps: LighterOnboardingChecklistDeps = defaultDeps(),
): Promise<LighterOnboardingChecklist> {
  const { walletAddress, walletResolution, walletPolicy } = await deps.readSessionWallet(input.sessionId);
  const account = await deps.readLighterAccount(input.environment, walletAddress);
  if (account === null) return { deposit: "todo", key: "todo", fee: "todo" };
  const key = deps.hasTradingKey(input.environment, account.account_index) ? "done" : "todo";
  const fee = await deps.inspectFee({
    sessionId: input.sessionId,
    environment: input.environment,
    walletResolution,
    walletPolicy,
  });
  return {
    deposit: "done",
    key,
    fee: fee.status === "ready" ? "done" : fee.status === "disabled" ? "not_required" : "todo",
  };
}

async function readSessionWalletFromEngine(sessionId: string): Promise<SessionWalletScope> {
  // The engine's own hydration, the way the desk lane and approval resume get
  // their wallet scope; fails closed when the session is gone.
  const { buildSessionWalletResolution, hydrateEngineSession } = await import(
    "@vex-agent/engine/core/hydrate.js"
  );
  const hydrated = await hydrateEngineSession(sessionId);
  if (hydrated === null) throw new Error("Lighter checklist: session not found.");
  const walletResolution = buildSessionWalletResolution(hydrated.context);
  const walletPolicy = hydrated.context.walletPolicy;
  return {
    walletAddress: resolveSelectedAddressForRead(walletResolution, walletPolicy, "eip155"),
    walletResolution,
    walletPolicy,
  };
}

function defaultDeps(): LighterOnboardingChecklistDeps {
  return {
    readSessionWallet: readSessionWalletFromEngine,
    readLighterAccount: buildLighterOnboardingReaders().readLighterAccount,
    hasTradingKey: (environment, accountIndex) =>
      listUnlockedLighterTradingCredentialScopes(environment)
        .some((scope) => scope.accountIndex === accountIndex),
    inspectFee: inspectLighterFeeAuthorization,
  };
}
