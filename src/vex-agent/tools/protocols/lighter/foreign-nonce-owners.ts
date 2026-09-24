import type { LighterNonceStateRow } from "@vex-agent/db/repos/lighter-nonce-state.js";

/**
 * Nonce owners whose executors live in Electron main, not in the engine.
 *
 * A leverage change (`lighter-leverage:*`) and a fee authorization
 * (`lighter-fees:*`) reserve the same per-key nonce slot an order does. Their
 * reconcilers are main-process code, so the engine's nonce recovery reaches
 * them through this registry, installed by each service at startup.
 *
 * A reconciler is EVIDENCE-ONLY: it never signs, submits, or retries. It must
 * return `null` unless its intent owns this exact reservation (environment,
 * account, key, reservation id and nonce value), so an unrelated reservation is
 * never touched.
 */
export type LighterForeignNonceOwnerKind = "leverage" | "fees";

export type LighterForeignNonceOwnerReconciler = (
  reservation: LighterNonceStateRow,
) => Promise<Record<string, unknown> | null>;

const reconcilers = new Map<LighterForeignNonceOwnerKind, LighterForeignNonceOwnerReconciler>();

export function configureLighterForeignNonceOwner(
  kind: LighterForeignNonceOwnerKind,
  reconciler: LighterForeignNonceOwnerReconciler,
): () => void {
  reconcilers.set(kind, reconciler);
  return () => {
    if (reconcilers.get(kind) === reconciler) reconcilers.delete(kind);
  };
}

export function getConfiguredLighterForeignNonceOwner(
  kind: LighterForeignNonceOwnerKind,
): LighterForeignNonceOwnerReconciler | null {
  return reconcilers.get(kind) ?? null;
}
