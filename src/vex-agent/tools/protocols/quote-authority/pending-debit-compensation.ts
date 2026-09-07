/**
 * IS A `pending` BALANCE READ ACTUALLY CURRENT ON THIS CHAIN - and when the
 * chain cannot answer that, does Vex's own durable record say the wallet has
 * money in flight.
 *
 * ## The gap this closes
 *
 * Contract C2.4 makes `pending` the authorization tag because it is the only
 * tag that subtracts the wallet's own unconfirmed spending. WP2-E0 then
 * MEASURED what the tag does on every endpoint a Vex swap venue reaches
 * (`tools/evm-chains/pending-block-capability.ts`, re-measured 2026-09-01 with a
 * block-hash identity test after the first block-number method was shown to
 * confuse latency with state): fourteen of eighteen answer `pending` with the
 * head block or expose no pending block at all. On those
 * endpoints the tag is accepted and subtracts nothing, so a read taken at
 * `pending` is a `latest` read wearing the authorization tag's name, and a
 * balance that an unconfirmed transfer has already spent can authorize a swap.
 *
 * ## What replaces the chain's answer
 *
 * Vex is not a passive observer of this wallet: every EVM transaction it
 * broadcasts owns a durable row BEFORE the signature exists (the pending
 * `agent_activity` row for the venue paths, `evm_nonce_reservations` for the
 * one legacy allowance seam), and that row is not terminal until the outcome is
 * known. So on a chain with no pending state the question "could an in-flight
 * transaction of ours make this `latest` read stale" has an exact local answer:
 *
 *   - NO in-flight row for this wallet and chain: nothing this application has
 *     signed is unaccounted for, so the `latest` observation is current for
 *     every spend Vex can know about, and the read stands.
 *   - ANY in-flight row: the observation cannot prove spendability, and the
 *     verdict is `balance_unavailable` - fail closed, never
 *     `insufficient_balance` (contract C2.3), because nothing is known to be
 *     missing; what is missing is the ability to check.
 *
 * IN FLIGHT MEANS BROADCAST, NOT MERELY RESERVED. A row that owns a nonce but
 * carries no transaction hash has spent nothing: the signature does not exist
 * yet. Requiring the hash is also what lets THIS execution's own pre-sign gate
 * run at all - the leg about to be signed has reserved its nonce and has no
 * hash, so it never counts itself as its own reason to refuse.
 *
 * ## The limit of the mechanism, stated rather than implied
 *
 * This compensation sees what VEX broadcast. A transaction sent from the same
 * key by anything else - another wallet application holding the same seed, a
 * hardware signer, a previous install whose database is gone - is invisible to
 * it, and on a chain with no pending state it is invisible to the node's answer
 * too. Vex is a self-custodial wallet over a key the user may also hold
 * elsewhere, so this is a real gap and not a theoretical one. It is bounded in
 * the only honest way available: on a `distinct` chain the tag itself covers
 * that case, and on the others the swap's own pre-sign gate re-reads the
 * balance immediately before signing, so a third-party spend that has CONFIRMED
 * is seen. Only a third-party spend that is broadcast and unconfirmed at the
 * instant of signing escapes both, and it is named in the pin note.
 *
 * ## Why the query lives here and not in `db/repos`
 *
 * The fact ("this endpoint has no pending state") belongs to `src/tools`, which
 * may not reach the database; the policy ("then ask what we have in flight")
 * needs both that fact and the durable state, and this package is where the
 * spendability vocabulary already lives. Handlers reaching the client directly
 * is established here (`protocols/pools/handlers/launch/execute/broadcast.ts`,
 * the launch authorize step). Promoting this read
 * into `db/repos/agent-activity/` is a named follow-up, not a silent choice.
 */

import {
  getPendingBlockCapability,
  type PendingBlockCapability,
} from "@tools/evm-chains/pending-block-capability.js";

import { queryOne } from "../../../db/client.js";

/**
 * Why a `pending`-tagged observation may not be treated as current.
 *
 * Structural classes only, never provider or database text: the caller's
 * decision is the same whatever the underlying failure said, and raw text is
 * uncontrolled payload on an agent-visible surface (rule 04 error layers).
 */
export const PENDING_COMPENSATION_CAUSES = {
  /** Vex has never measured this chain's pending behaviour. Fails closed. */
  capabilityUnknown: "evm_pending_block_capability_unmeasured",
  /** No pending state on this endpoint, and this wallet has a broadcast outstanding. */
  inFlightBroadcast: "evm_pending_state_absent_with_in_flight_broadcast",
  /** No pending state, and the durable in-flight record could not be read. */
  inFlightStateUnreadable: "evm_in_flight_broadcast_state_unreadable",
} as const;

export type PendingCompensationCause =
  (typeof PENDING_COMPENSATION_CAUSES)[keyof typeof PENDING_COMPENSATION_CAUSES];

/**
 * What makes an observation current, when it is.
 *
 * Two different facts, kept apart on purpose: one is the chain's own guarantee,
 * the other is Vex's local accounting standing in for it. A caller that logs or
 * discloses this must be able to say which it had.
 */
export type PendingObservationBasis = "chain_pending_state" | "durable_in_flight_accounting";

export type PendingObservationVerdict =
  | {
      readonly ok: true;
      readonly basis: PendingObservationBasis;
      readonly capability: PendingBlockCapability;
    }
  | { readonly ok: false; readonly cause: PendingCompensationCause };

/** The one durable question this module asks, injectable so a test needs no database. */
export type InFlightBroadcastReader = (input: {
  readonly chainId: number;
  readonly wallet: string;
}) => Promise<boolean>;

interface InFlightRow extends Record<string, unknown> {
  readonly in_flight: boolean | null;
}

/**
 * Does this wallet have any EVM transaction broadcast on this chain whose
 * outcome is not yet known.
 *
 * Both durable owners are consulted, because both allocate nonces for the same
 * key: the venue paths write their reservation onto the pending `agent_activity`
 * row, and the legacy Pendle allowance seam owns `evm_nonce_reservations`
 * (migration 091 states exactly that split). Reading one of them would be
 * reading half of what this application has in flight.
 */
export const readInFlightBroadcast: InFlightBroadcastReader = async (input) => {
  const wallet = input.wallet.toLowerCase();
  const row = await queryOne<InFlightRow>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM agent_activity
          WHERE chain_family = 'eip155' AND chain_id = $1
            AND lower(from_address) = $2
            AND status = 'pending' AND tx_hash IS NOT NULL
       )
       OR EXISTS (
         SELECT 1 FROM evm_nonce_reservations
          WHERE chain_id = $1 AND lower(from_address) = $2
            AND status IN ('staged', 'accepted')
       )
     ) AS in_flight`,
    [input.chainId, wallet],
  );
  if (row === null) {
    // A query that returned no row answered nothing. Treated as a failure by
    // the caller rather than as "nothing in flight", which is the whole point
    // of failing closed here.
    throw new Error("pending-debit compensation: in-flight query returned no row");
  }
  return row.in_flight === true;
};

/**
 * Decide whether a `pending`-tagged balance observation on this chain may be
 * treated as current for this wallet.
 *
 * NEVER THROWS. Every failure to learn something is a verdict naming its cause,
 * because the callers are quote paths that must still answer with a route
 * (contract C2.1) and pre-sign gates that must refuse by name rather than by
 * exception class.
 *
 * A chain whose pending state is `distinct` short-circuits before any database
 * call: the tag already did the subtraction, and asking the local record would
 * add a query and answer nothing new.
 */
export async function judgePendingObservation(
  input: {
    readonly chainId: number;
    readonly wallet: string;
  },
  readInFlight: InFlightBroadcastReader | undefined = readInFlightBroadcast,
): Promise<PendingObservationVerdict> {
  const capability = getPendingBlockCapability(input.chainId);
  if (capability === undefined) {
    return { ok: false, cause: PENDING_COMPENSATION_CAUSES.capabilityUnknown };
  }
  if (capability.state === "distinct") {
    return { ok: true, basis: "chain_pending_state", capability };
  }

  let inFlight: boolean;
  try {
    inFlight = await readInFlight({ chainId: input.chainId, wallet: input.wallet });
  } catch {
    return { ok: false, cause: PENDING_COMPENSATION_CAUSES.inFlightStateUnreadable };
  }
  return inFlight
    ? { ok: false, cause: PENDING_COMPENSATION_CAUSES.inFlightBroadcast }
    : { ok: true, basis: "durable_in_flight_accounting", capability };
}
