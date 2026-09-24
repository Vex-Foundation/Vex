import type { LighterEnvironment } from "@tools/lighter/types.js";
import logger from "@utils/logger.js";

export interface LighterNonceRecoveryScope {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
}

export type LighterNonceRecoveryRunner = (scope: LighterNonceRecoveryScope) => Promise<unknown>;

/**
 * The recovery the execution paths install by default. Loaded lazily because
 * recovery imports the repair modules, and those import these execution
 * modules.
 */
export const runLighterNonceRecovery: LighterNonceRecoveryRunner = async (scope) =>
  (await import("./nonce-recovery.js")).checkLighterNonceRecovery(scope);

/**
 * Observe the live nonce for an approved action at its commit point. When an
 * earlier action still holds the slot, run one recovery pass and observe again
 * before refusing, so an approval never fails over a lock the background sweep
 * would have cleared anyway. Recovery releases only a reservation it can prove
 * is safe to release, so this never frees an action that may still execute.
 */
export async function observeLighterNonceWithRecovery<T>(input: {
  readonly scope: LighterNonceRecoveryScope;
  readonly observe: () => Promise<T | null>;
  readonly recover: LighterNonceRecoveryRunner | undefined;
}): Promise<T | null> {
  const observed = await input.observe();
  if (observed !== null || input.recover === undefined) return observed;
  try {
    await input.recover(input.scope);
  } catch (error) {
    logger.warn("lighter.nonce.commit_recovery_failed", {
      environment: input.scope.environment,
      accountIndex: input.scope.accountIndex,
      reason: error instanceof Error ? error.name : typeof error,
    });
  }
  return input.observe();
}
