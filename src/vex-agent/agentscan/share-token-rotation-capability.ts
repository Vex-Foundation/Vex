/**
 * May this install offer a Superboard key rotation?
 *
 * The server advertises `share_token_rotation_v1` in `GET /capabilities` when
 * it accepts the `replaces` field. A client that has not seen the literal must
 * not send it: an old server would answer 400 and the rotation would die as a
 * confusing refusal instead of a hidden button. The three answers mirror the
 * Lighter gate's posture: only a real negative (`absent`, or a list without
 * the literal) is `unavailable`; every failed lookup is `unknown`, which the
 * UI renders as "checking", never as a verdict about the server.
 *
 * Answers are cached in memory per server fingerprint: a positive answer
 * stands 6 hours, a negative or unknown one 10 minutes (the Lighter cadence
 * constants - one refresh rhythm for both gates).
 */

import {
  agentscanServerFingerprint,
  LIGHTER_CAPABILITY_POSITIVE_TTL_MS,
  LIGHTER_CAPABILITY_REFRESH_MS,
  type ServerCapabilityAnswer,
} from "../sync/agentscan-report/lighter-capability.js";

export const SHARE_TOKEN_ROTATION_CAPABILITY = "share_token_rotation_v1";

export type ShareTokenRotationAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: "server" }
  | { readonly kind: "unknown"; readonly reason: "transport" | "refused" | "no_ingest_token" };

interface CachedAvailability {
  readonly availability: ShareTokenRotationAvailability;
  readonly atMs: number;
}

const cache = new Map<string, CachedAvailability>();

function ttlFor(availability: ShareTokenRotationAvailability): number {
  return availability.kind === "available"
    ? LIGHTER_CAPABILITY_POSITIVE_TTL_MS
    : LIGHTER_CAPABILITY_REFRESH_MS;
}

function toAvailability(answer: ServerCapabilityAnswer): ShareTokenRotationAvailability {
  if (answer.kind === "list") {
    return answer.capabilities.includes(SHARE_TOKEN_ROTATION_CAPABILITY)
      ? { kind: "available" }
      : { kind: "unavailable", reason: "server" };
  }
  if (answer.kind === "absent") return { kind: "unavailable", reason: "server" };
  return { kind: "unknown", reason: answer.reason };
}

export async function readShareTokenRotationAvailability(input: {
  baseUrl: string;
  ingestToken: string | null;
  nowMs: number;
  fetchCapabilities: (input: { ingestToken: string | null }) => Promise<ServerCapabilityAnswer>;
}): Promise<ShareTokenRotationAvailability> {
  const fingerprint = agentscanServerFingerprint(input.baseUrl);
  const cached = cache.get(fingerprint);
  if (cached !== undefined && input.nowMs - cached.atMs < ttlFor(cached.availability)) {
    return cached.availability;
  }
  const availability = toAvailability(await input.fetchCapabilities({ ingestToken: input.ingestToken }));
  cache.set(fingerprint, { availability, atMs: input.nowMs });
  return availability;
}

/** Test seam: forget every cached answer. */
export function resetShareTokenRotationAvailability(): void {
  cache.clear();
}
