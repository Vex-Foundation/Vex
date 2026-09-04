/**
 * Vex Studio BRIDGE READINESS - the shared contract behind the diagnostic the
 * Studio welcome screen shows when the `vex-mcp` bridge binary is not there.
 *
 * A NEW FILE RATHER THAN A SECTION OF `studio.ts`, because these are two
 * different questions with two different owners. `studio.ts` answers "is the
 * MCP host serving right now", a level published by the running host. This
 * answers "does this installation HAVE a bridge binary at all", a filesystem
 * and toolchain fact main probes on request. Sharing a module would put a
 * pushed level and a pulled probe under one name.
 *
 * ## The distinction the union exists to make (owner decision 2026-09-01)
 *
 * In a PACKAGED app the bridge ships inside `resources/`. Its absence is an
 * installation-integrity failure and the only honest remedy is reinstalling
 * Vex. END USERS ARE NEVER TOLD ABOUT GO: they did not build the binary, they
 * cannot build the binary, and naming a compiler in that surface would be
 * advice they cannot act on.
 *
 * Only a FROM-SOURCE run reports toolchain state, because only there is
 * building the bridge the actual remedy. The pinned Go version travels on the
 * wire so the renderer can name it without a second copy of the pin: the ONE
 * owner of that value is `bridge/build.sh`, which main reads.
 *
 * ## What deliberately never crosses this wire
 *
 * NO ABSOLUTE PATHS, exactly as `studio.ts` refuses the host endpoint. The
 * renderer is treated as hostile, and the bridge's location is the command an
 * external coding agent is configured to spawn. Every payload here is a closed
 * CODE plus, at most, two version strings that are constrained by pattern.
 *
 * NO PROVIDER OR OS PROSE. `go env GOVERSION` failing produces stderr that can
 * name the developer's home directory and their shell's PATH; that text stays
 * in main's log and the wire carries `unusable`.
 */

import { z } from "zod";

/**
 * A Go toolchain version as Go itself reports it (`go1.27.0`).
 *
 * The pattern is a BOUND, not decoration. Both values that use it are read
 * from outside this process (a shell script Vex ships, and the output of a
 * binary on the developer's PATH), and this is the point where an unexpected
 * value becomes a rejected payload instead of a sentence rendered into the UI.
 */
export const studioGoVersionSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_.+-]+$/, "a Go version is a bare version token");

/**
 * The host platform, in Node's vocabulary, narrowed to what Vex ships for
 * plus `other`.
 *
 * It is on the wire because the renderer must NOT guess. `navigator.platform`
 * is a user-agent string the renderer can be lied to about and which does not
 * distinguish the cases that matter here; main knows `process.platform` for
 * certain, so main states it and the renderer selects its guidance from a
 * closed set.
 */
export const studioBridgeHostPlatformSchema = z.enum([
  "darwin",
  "win32",
  "linux",
  "other",
]);
export type StudioBridgeHostPlatform = z.infer<
  typeof studioBridgeHostPlatformSchema
>;

/**
 * The Go toolchain on a from-source machine, as far as it can be established
 * without running a build.
 *
 *  - `absent`        - no `go` on PATH at all.
 *  - `unusable`      - `go` is on PATH but did not report a version. The
 *                      specific failure stays in main's log; every remedy the
 *                      user has is the same as for a wrong version.
 *  - `wrong_version` - it reported a version, and it is not the pin. `found`
 *                      travels so the renderer can show both numbers, which is
 *                      the whole content of the diagnosis.
 *  - `present`       - the pin is installed, so nothing is missing except the
 *                      build itself.
 */
export const studioBridgeGoToolchainSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("unusable") }).strict(),
  z
    .object({
      kind: z.literal("wrong_version"),
      found: studioGoVersionSchema,
    })
    .strict(),
  z.object({ kind: z.literal("present") }).strict(),
]);
export type StudioBridgeGoToolchain = z.infer<
  typeof studioBridgeGoToolchainSchema
>;

/**
 * Whether Vex Studio has a bridge binary, and when it does not, the one thing
 * the user can do about it.
 *
 *  - `ready`                - the binary is where this installation puts it and
 *                             is executable. It carries NO target triple: in a
 *                             packaged app the goos/goarch would be derived
 *                             from `process`, not observed from the artifact,
 *                             and a derived value stated as a fact is a small
 *                             lie for a field nothing renders.
 *  - `missing_packaged`     - packaged, and `resources/bridge/` has no binary.
 *                             Installation integrity. Reinstall Vex.
 *  - `unsupported_platform` - a from-source run on an operating system or
 *                             architecture Vex builds no bridge for. Nothing
 *                             the developer installs changes this, so it is not
 *                             collapsed into `missing_dev`.
 *  - `pin_unreadable`       - a from-source run whose `bridge/build.sh` does not
 *                             declare `REQUIRED_GO_VERSION`. Vex cannot say
 *                             which Go to install without inventing a second
 *                             copy of the pin, so it says the checkout is
 *                             incomplete instead of guessing.
 *  - `missing_dev`          - a from-source run with no built binary, plus the
 *                             toolchain state that decides whether the remedy
 *                             is "install Go" or only "run the build".
 */
export const studioBridgeReadinessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }).strict(),
  z.object({ kind: z.literal("missing_packaged") }).strict(),
  z.object({ kind: z.literal("unsupported_platform") }).strict(),
  z.object({ kind: z.literal("pin_unreadable") }).strict(),
  z
    .object({
      kind: z.literal("missing_dev"),
      platform: studioBridgeHostPlatformSchema,
      /** The pin, read from `bridge/build.sh`, which is its only owner. */
      requiredGoVersion: studioGoVersionSchema,
      go: studioBridgeGoToolchainSchema,
    })
    .strict(),
]);
export type StudioBridgeReadiness = z.infer<typeof studioBridgeReadinessSchema>;
