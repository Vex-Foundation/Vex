import { trackInFlightSigning, tryAcquireSigningLock, type InFlightSigningKind } from "@vex-agent/engine/core/in-flight-signing.js";
import { LOCK_BUTTON } from "@shared/lock-button.js";
import { criticalOpInFlight } from "../updates/critical-ops.js";

export async function protectSigningOperation<T>(
  kind: InFlightSigningKind,
  work: () => Promise<T>,
  options: { readonly enabled?: boolean } = {},
): Promise<T> {
  // Admission tracking is a security boundary even when the lock UI is hidden.
  void options;
  return trackInFlightSigning(kind, work);
}

/** Refuse active work, then hold admission closed through the entire privileged teardown. */
export async function guardUserLock<T>(
  work: () => Promise<T>,
  options: { readonly enabled?: boolean; readonly criticalWorkActive?: () => boolean } = {},
): Promise<{ readonly kind: "busy" } | { readonly kind: "locked"; readonly value: T }> {
  if (!(options.enabled ?? LOCK_BUTTON)) return { kind: "locked", value: await work() };
  if ((options.criticalWorkActive ?? criticalOpInFlight)()) return { kind: "busy" };
  const release = tryAcquireSigningLock();
  if (release === null) return { kind: "busy" };
  try {
    return { kind: "locked", value: await work() };
  } finally {
    release();
  }
}
