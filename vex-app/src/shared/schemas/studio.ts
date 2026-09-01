/**
 * Vex Studio HOST STATUS - the shared contract for the renderer's Studio-mode
 * indicator (stage B0).
 *
 * ## What this payload is, and what it deliberately is not
 *
 * The Studio MCP host is a local socket an external coding agent's bridge
 * connects to. The renderer needs to answer three questions - is it serving,
 * why not, and is it full - and NOTHING else. So this payload carries a state,
 * a closed cause code, and three numbers.
 *
 * IT NEVER CARRIES THE ENDPOINT. The unix socket path and the Windows pipe name
 * are the address of a privileged local listener; a renderer that learned them
 * would hold a capability it has no business holding, and the app's own threat
 * model treats the renderer as hostile. `studio-host-status.test.ts` asserts
 * `.strict()` rejects an `endpoint` key, so the omission is enforced rather
 * than merely observed.
 *
 * IT NEVER CARRIES PROSE. `studioReadiness().cause` is a sentence written for
 * an MCP peer, and start refusals embed filesystem paths and provider error
 * text ("could not bind /run/user/1000/..."). Every other event channel in this
 * app refuses runtime prose for the same reason, so the wire carries a CODE and
 * the sentence stays main-side.
 *
 * ## Where the cause members come from
 *
 * `starting`, `fence_uninitialized` and `shutting_down` are the readiness
 * barrier's own unready set, whose authoritative list is `STUDIO_UNREADY_CODES`
 * in `main/studio/readiness.ts`. Shared code cannot import from main (the
 * process boundary runs the other way), so the two are reconciled by a TABLE
 * TEST that enumerates the barrier's codes against this enum and fails when
 * either side grows a member the other lacks. Adding an unready code without
 * adding it here is a test failure, not a silently unrepresentable state.
 *
 * `not_configured` and `endpoint_unavailable` are the host's own refusals,
 * which the readiness barrier knows nothing about: the host can be refused
 * before it ever consults readiness (no executor installed) or after it
 * (endpoint planning, the Windows transport gate, a directory-identity check,
 * a stale-socket probe, or `listen` itself failing). They are two codes rather
 * than one per refusal site on purpose - the renderer's remedy is identical for
 * every endpoint refusal, and a finer split would only put provider detail on
 * the wire under a different name.
 */

import { z } from "zod";

/**
 * Why the host is not serving. Non-null ONLY when `state` is `unavailable`;
 * `running`, `locked` and `starting` each explain themselves.
 */
export const studioHostUnavailableCauseSchema = z.enum([
  /** The readiness barrier has not finished (mirrors `STUDIO_UNREADY_CODES`). */
  "starting",
  /** The approval fence could not be initialized (mirrors the barrier). */
  "fence_uninitialized",
  /** The app is shutting down (mirrors the barrier). */
  "shutting_down",
  /** No executor is installed, so the host refuses to serve calls it cannot run. */
  "not_configured",
  /**
   * The endpoint could not be planned, verified, or bound. Covers directory
   * ownership and mode checks, the stale-endpoint probe, and `listen`
   * failures. The specific sentence stays in main's log.
   */
  "endpoint_unavailable",
  /**
   * The Windows named-pipe transport is DISABLED, pending the measurement of
   * its pipe security descriptor on a Windows runner
   * (`WINDOWS_TRANSPORT_PROVEN` in `main/studio/mcp-host/endpoint.ts`).
   *
   * ADDITIVE, and its own member rather than another `endpoint_unavailable`,
   * because it is the only unavailable cause that is not a failure at all: the
   * endpoint was planned correctly and Vex refused to open it. Telling a
   * Windows user "Vex Studio could not open its local endpoint on this
   * machine" invites them to go looking for a broken installation, when the
   * honest sentence is that this platform's transport is switched off until
   * its cross-user access has been proven and there is nothing for them to
   * fix. Renderer and main ship in one artifact, so the reader and the writer
   * change together and no rollout ordering applies.
   */
  "windows_transport_disabled",
]);
export type StudioHostUnavailableCause = z.infer<
  typeof studioHostUnavailableCauseSchema
>;

/**
 * The host's lifecycle state.
 *
 *  - `running`    - the listener is bound and a peer would be served.
 *  - `locked`     - Vex is locked. The listener stays bound and every connect
 *                   is answered with a typed `locked` refusal that reads no
 *                   project bytes, which is the honest answer a bridge cannot
 *                   derive from a connection error. Nothing is admitted.
 *  - `starting`   - a bind attempt is in flight and has not reached its
 *                   publication gate.
 *  - `unavailable`- not serving, and `cause` says why. Covers both a listener
 *                   that is not up and a bound listener whose readiness barrier
 *                   has not opened yet.
 */
export const studioHostStateSchema = z.enum([
  "running",
  "locked",
  "starting",
  "unavailable",
]);
export type StudioHostState = z.infer<typeof studioHostStateSchema>;

/**
 * The established-connection bound, mirrored onto the wire so the renderer can
 * render "3 of 16" without hard-coding the host's constant. Reconciled against
 * `STUDIO_MAX_CONNECTIONS` by a table test.
 */
export const STUDIO_MAX_CONNECTIONS_WIRE = 16;

export const studioHostStatusSchema = z
  .object({
    state: studioHostStateSchema,
    /** Null unless `state` is `unavailable`; enforced by a refinement below. */
    cause: studioHostUnavailableCauseSchema.nullable(),
    /**
     * ESTABLISHED connections only - the synchronous reservations the host
     * grants at handshake. Sockets still handshaking are deliberately excluded:
     * a peer that has not finished its handshake holds no slot a user would
     * recognise as a connection, and counting it would make the indicator
     * flicker on every probe.
     */
    connectionCount: z.number().int().nonnegative().max(STUDIO_MAX_CONNECTIONS_WIRE),
    maxConnections: z.literal(STUDIO_MAX_CONNECTIONS_WIRE),
    /**
     * `connectionCount >= maxConnections`. A handshake-pending capacity refusal
     * emits a status update but does NOT set this flag: that bound is a
     * different, smaller queue, and reporting it as "full" would tell the user
     * their 16 connection slots are gone when none of them are.
     */
    atCapacity: z.boolean(),
  })
  .strict()
  .refine(
    (value) => (value.state === "unavailable") === (value.cause !== null),
    {
      message: "cause is present exactly when state is unavailable",
      path: ["cause"],
    },
  );
export type StudioHostStatus = z.infer<typeof studioHostStatusSchema>;
