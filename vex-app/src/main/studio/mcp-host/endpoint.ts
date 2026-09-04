/**
 * WHERE the Vex Studio MCP host listens, and whether it is allowed to.
 *
 * The frozen contract is `src/vex-agent/tools/tool-surface-spec/studio-mcp/
 * bridge-endpoint-contract.md`, and the golden vectors beside it
 * (`bridge-endpoint-vectors.json`) are executed against THIS module by
 * `__tests__/mcp-host-endpoint.test.ts` and, in stage A4c, against the Go
 * bridge's independent re-implementation. Both sides derive the same path from
 * the same facts with no shared code and no configuration file to read.
 *
 * ## Every path operation is TARGET-flavoured
 *
 * `platform` is an INPUT, not `process.platform`: the golden vectors carry
 * linux, darwin and win32 rows and every owner runs all of them on whatever
 * machine CI happens to give it. The ambient `node:path` follows the HOST, so
 * on a Windows runner `path.join("/run/user/1000", name)` is
 * `\run\user\1000\...` and `path.dirname("/srv/sockets/x.sock")` is
 * `\srv\sockets` - a red suite, and in a shipped build a host binding a path
 * the bridge never dials. Every join, dirname and isAbsolute below therefore
 * goes through `flavour(input.platform)` (`path.win32` or `path.posix`), the
 * same selector the config-directory resolver uses. On a real win32 host
 * `path.win32 === path`, so runtime behaviour is unchanged.
 *
 * ## Pure planner, injected facts
 *
 * `planStudioEndpoint` performs no I/O. Directory ownership and mode arrive
 * through `probeDirectory`, so the same function answers a real filesystem, a
 * golden vector and a hostile-permissions test case identically. The host owns
 * the real probe (`nodeDirectoryProbe`) and the bind-time stale/live checks,
 * which cannot be pure.
 *
 * ## The override is VALIDATED BEFORE BIND, never trusted
 *
 * `VEX_STUDIO_SOCKET` wins everywhere it is accepted, but a value that fails
 * validation REFUSES host startup with the named cause. It never silently
 * falls back to the derived path: the derived path's parent has verified
 * ownership and mode, and quietly substituting it would hide the fact that
 * somebody pointed Vex's privileged listener somewhere unverified. That is the
 * P4 trust boundary, and a bypass is the failure this whole module exists to
 * prevent.
 */

import { createHash } from "node:crypto";

import { flavour } from "../../paths/config-dir.js";

/** The target-flavoured path module every join and dirname below goes through. */
type PathFlavour = ReturnType<typeof flavour>;

/** `sun_path` is ~104 bytes INCLUDING the terminator on Linux and macOS. */
export const STUDIO_SUN_PATH_MAX_BYTES = 103;

/** The env name that overrides the derived endpoint. */
export const STUDIO_SOCKET_OVERRIDE_ENV = "VEX_STUDIO_SOCKET";

/**
 * The systemd per-user runtime root on Linux, PROBED rather than assumed, and
 * PREFERRED over `XDG_RUNTIME_DIR`.
 *
 * It is the rung that keeps the two owners from disagreeing.
 * `XDG_RUNTIME_DIR` is an environment variable, and an MCP client is free to
 * spawn the bridge with an environment that does not carry it: Codex CLI does
 * exactly that, so the app derived `/run/user/<uid>` from the variable IT
 * could see while the bridge fell all the way through to
 * `<tmpdir>/vex-studio-<uid>`, and the client saw a broken pipe. The
 * derivation is a pure function of (uid, config directory, `XDG_RUNTIME_DIR`,
 * and the FILESYSTEM facts of `/run/user/<uid>`), and that last term is the
 * one both sides read identically whatever their environment says.
 *
 * THE ORDER IS THE OTHER HALF OF THAT, and it was measured wrong first.
 * Probing the directory only AFTER the variable failed still lets the two
 * sides diverge: a private CUSTOM `XDG_RUNTIME_DIR` (WSLg's
 * `/mnt/wslg/runtime-dir` on some distributions) is a directory the app can
 * see and a scrubbed bridge cannot, so the host bound there while the bridge
 * found `/run/user/<uid>` private and dialled that. Same privacy gate, two
 * endpoints, no rendezvous. The environment-independent fact therefore goes
 * first, and the variable decides only where a system with no
 * `/run/user/<uid>` keeps its runtime directory.
 *
 * THE RESIDUAL, NAMED RATHER THAN CLOSED (contract 1.2): a machine with no
 * private `/run/user/<uid>` AND a custom private `XDG_RUNTIME_DIR` the
 * launcher drops still diverges. Nothing both processes can read describes
 * that directory; the follow-up is a rendezvous file, not another environment
 * rung.
 *
 * The directory is held to the SAME `isPrivateDirectory` gate the variable is
 * held to - a directory, owned by this uid, with no group or other bits -
 * which is the systemd guarantee that makes it a safe socket home. When
 * neither holds, the tmpdir fallback is exactly what it was.
 *
 * VS Code's `createStaticIPCHandle` (`src/vs/base/parts/ipc/node/ipc.net.ts`
 * in the reference checkout) reads `XDG_RUNTIME_DIR` once at module load and
 * otherwise falls back to a caller-supplied directory, with no probed runtime
 * root at all. Vex needs one, and needs it FIRST, because VS Code's two sides
 * are one process tree sharing an environment and ours are not: our client
 * half is spawned by somebody else's agent, with somebody else's environment.
 */
export const LINUX_RUNTIME_DIR_ROOT = "/run/user";

/** What one directory looks like to the planner. `null` means it is absent. */
export interface EndpointDirectoryFacts {
  readonly isDirectory: boolean;
  /** Owning uid. Compared against the running process's uid. */
  readonly uid: number;
  /** Permission bits only (`stat.mode & 0o777`). */
  readonly mode: number;
}

export type EndpointDirectoryProbe = (dir: string) => EndpointDirectoryFacts | null;

export interface EndpointPlanInput {
  readonly platform: NodeJS.Platform;
  /** The REALPATH of the Vex config directory. The hash input, and only that. */
  readonly configDirRealPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tmpdir: string;
  readonly uid: number;
  readonly probeDirectory: EndpointDirectoryProbe;
}

export type StudioEndpointRefusalCode =
  | "override_not_absolute"
  | "override_invalid_pipe"
  | "override_pipe_on_unix"
  | "endpoint_ancestor_changed"
  | "override_parent_missing"
  | "override_parent_not_directory"
  | "override_parent_not_owned"
  | "override_parent_mode"
  | "path_too_long";

/** Runtime refusal when an endpoint ancestor cannot be proven unchanged. */
export const ENDPOINT_ANCESTOR_CHANGED_CODE =
  "endpoint_ancestor_changed" satisfies StudioEndpointRefusalCode;

export type StudioEndpointPlan =
  | {
      readonly kind: "unix";
      readonly path: string;
      readonly parentDir: string;
      /**
       * Whether the host owns this parent and must create it 0700. False for
       * `XDG_RUNTIME_DIR` (the system owns it, already verified) and for an
       * override (the operator owns it, and it must already exist).
       */
      readonly createParent: boolean;
    }
  | { readonly kind: "pipe"; readonly path: string }
  | {
      readonly kind: "refused";
      readonly code: StudioEndpointRefusalCode;
      readonly message: string;
    };

/**
 * The endpoint discriminator: the first 12 hex characters of SHA-256 over the
 * REALPATH of the Vex config directory.
 *
 * The config directory, not the projects root: the standalone Go bridge can
 * derive the config directory from the platform convention alone, and has no
 * validated way to learn a `config.json` override for the projects root. 12
 * hex characters is 48 bits, which is a collision-resistance question about
 * two config directories on one machine, not an adversarial one - the bridge
 * still has to pass the handshake, and the socket's own directory permissions
 * are the access control.
 */
export function studioEndpointHash(configDirRealPath: string): string {
  return createHash("sha256").update(configDirRealPath, "utf8").digest("hex").slice(0, 12);
}

/** The socket file name for one config directory. */
export function studioEndpointFileName(configDirRealPath: string): string {
  return `vex-studio-${studioEndpointHash(configDirRealPath)}.sock`;
}

/**
 * The Windows named pipe for one config directory.
 *
 * Same discriminator, same input, different transport: Windows has no
 * filesystem socket, so the endpoint lives in the machine's pipe namespace.
 *
 * The name is PREDICTABLE by design. This is VS Code's own pattern for its
 * main IPC, verified in the reference checkout: `createStaticIPCHandle`
 * (`src/vs/base/parts/ipc/node/ipc.net.ts`) derives `\\.\pipe\<hash>-...`
 * from a SHA-256 of the user data directory and serves it with a plain
 * `createServer().listen`, and the whole `src/vs/base` + `src/vs/platform`
 * tree contains no security-descriptor handling. The boundary is the
 * documented Windows DEFAULT pipe security descriptor - which does not grant a
 * second user the duplex access a client needs - plus protocol-level
 * validation. Vex keeps its own additional layers on top: a locked or unready
 * Vex refuses every connect with a typed ack before it reads a byte, the
 * handshake ack admits a project, and every mutating call is approval-gated.
 *
 * DERIVING the name is not permission to OPEN it: the front binds that name
 * under its own protected descriptor and main publishes only what Windows
 * CONFIRMED back to it (contract section 1.6, `mcp-host/front-endpoint.ts`).
 */
export function studioEndpointPipeName(configDirRealPath: string): string {
  return `\\\\.\\pipe\\vex-studio-${studioEndpointHash(configDirRealPath)}`;
}

/** Is this directory usable as a private runtime directory for `uid`? */
function isPrivateDirectory(facts: EndpointDirectoryFacts | null, uid: number): boolean {
  if (facts === null || !facts.isDirectory) return false;
  if (facts.uid !== uid) return false;
  // No group and no other bits. 0700 or tighter.
  return (facts.mode & 0o077) === 0;
}

function refuse(
  code: StudioEndpointRefusalCode,
  message: string,
): StudioEndpointPlan {
  return { kind: "refused", code, message };
}

/** The `sun_path` assertion, applied to every Unix plan before it is returned. */
function withinSunPath(candidate: string): boolean {
  return Buffer.byteLength(candidate, "utf8") <= STUDIO_SUN_PATH_MAX_BYTES;
}

/**
 * Windows named-pipe syntax, checked structurally.
 *
 * Applied to an override on every platform, and to the DERIVED Windows pipe
 * too, so the host and the bridge cannot disagree about what a pipe name is. A
 * pipe whose name is empty, or that contains a path separator after the
 * `pipe\` prefix, is not a pipe name Node will bind.
 */
export function isWindowsPipePath(value: string): boolean {
  const match = /^\\\\[.?]\\pipe\\(.+)$/.exec(value);
  if (match === null) return false;
  const name = match[1] ?? "";
  return name.length > 0 && !name.includes("\\") && !name.includes("/");
}

/**
 * THE WINDOWS TRANSPORT GATE, OPENED. One flag, one owner, and the identical
 * flag on the other side of the wire (contract 1.6).
 *
 * WHY TRUE. The eight-row proof matrix of contract section 1.6 was MEASURED on
 * the required Windows CI jobs, not argued: rows 1, 2, 3, 7 and 8 on
 * `bridge-windows` run 33646484002 (second-user duplex denial paired with a
 * control pipe, a read-only cross-user connect denied with no instance
 * consumed, `rejectRemote` confirmed by readback and the loopback redirector
 * refused, a foreign user's first-server squat failing the front's bind closed
 * and refused by host authentication, and impersonation level 1); row 4's host
 * half on `vex-app-windows` run 33650332655; rows 5 and 6 on `bridge-windows`
 * run 33663385959. The libuv reasoning this gate was closed for describes a
 * pipe Vex no longer creates: the `vex-pipe-front` child binds it under its
 * own PROTECTED two-ACE descriptor and reports back what Windows CONFIRMED,
 * and libuv never sees the handle.
 *
 * WHAT DID NOT CHANGE. The derivation, the pipe name, the override syntax and
 * the plan shape are exactly what they were and stay vector-tested. Opening
 * the gate changed no plan.
 *
 * IT STAYS OPEN MECHANICALLY, NOT EDITORIALLY. The Go bridge carries
 * `endpoint.WindowsTransportProven`, and the two are ONE decision: a reviewer
 * who sees either flag false while the other is true rejects the change, in
 * that direction as much as in the other. Closing the transport again is a
 * contract change (section 5) with both owners in the same diff, never an edit
 * to one constant.
 */
export const WINDOWS_TRANSPORT_PROVEN = true;

export function planStudioEndpoint(input: EndpointPlanInput): StudioEndpointPlan {
  const override = input.env[STUDIO_SOCKET_OVERRIDE_ENV];
  if (typeof override === "string" && override.length > 0) {
    return planOverride(override, input);
  }

  // WINDOWS: a named pipe, derived from the SAME hash input as the unix
  // socket. There is no directory to create or verify and no `sun_path` bound
  // to check: a pipe is not a filesystem object. See
  // `studioEndpointPipeName` for the security model and its evidence.
  if (input.platform === "win32") {
    return { kind: "pipe", path: studioEndpointPipeName(input.configDirRealPath) };
  }

  const fileName = studioEndpointFileName(input.configDirRealPath);

  // Linux: a private runtime directory when the system gave us one, and the
  // fallback below when it did not.
  // Unix targets only from here: a win32 target returned its pipe above, and
  // a pipe is not a filesystem path. The flavour is still selected from the
  // input rather than assumed, so a future non-win32 flavour cannot be
  // silently inherited from the host.
  const target = flavour(input.platform);

  if (input.platform === "linux") {
    // THE FILESYSTEM FACT FIRST, THE ENVIRONMENT SECOND (contract 1.2). Both
    // rungs are held to the same privacy gate; what the order decides is which
    // one wins when they name DIFFERENT directories, and only one of the two
    // is a fact both processes read identically. See `LINUX_RUNTIME_DIR_ROOT`.
    const systemdRuntimeDir = target.join(LINUX_RUNTIME_DIR_ROOT, String(input.uid));
    if (isPrivateDirectory(input.probeDirectory(systemdRuntimeDir), input.uid)) {
      return planPrivateRuntimeDir(systemdRuntimeDir, fileName, target);
    }

    // NO `/run/user/<uid>`, SO THE VARIABLE NAMES THE ONLY PRIVATE RUNTIME
    // DIRECTORY THIS SYSTEM OFFERS. A distribution that puts one elsewhere
    // (WSLg's `/mnt/wslg/runtime-dir`) is served here rather than pushed down
    // to the tmpdir form. It is also the rung that carries the residual
    // divergence contract 1.2 names by hand: a launcher that drops the
    // variable on such a machine derives a different endpoint from this one,
    // and no fact available to both sides closes it.
    const runtimeDir = input.env["XDG_RUNTIME_DIR"];
    if (
      typeof runtimeDir === "string"
      && runtimeDir.length > 0
      && target.isAbsolute(runtimeDir)
      && isPrivateDirectory(input.probeDirectory(runtimeDir), input.uid)
    ) {
      return planPrivateRuntimeDir(runtimeDir, fileName, target);
    }
  }

  // macOS always, and Linux when neither runtime directory is private: no
  // `/run/user/<uid>`, and an `XDG_RUNTIME_DIR` that is unset, relative, not a
  // directory, not ours, or readable by anyone else.
  const parentDir = target.join(input.tmpdir, `vex-studio-${String(input.uid)}`);
  const candidate = target.join(parentDir, fileName);
  if (!withinSunPath(candidate)) {
    return refuse("path_too_long", sunPathMessage(candidate));
  }
  return { kind: "unix", path: candidate, parentDir, createParent: true };
}

/**
 * A system-owned private runtime directory, planned. `createParent` is false
 * for both callers: the system created these and Vex only verified them.
 */
function planPrivateRuntimeDir(
  runtimeDir: string,
  fileName: string,
  target: PathFlavour,
): StudioEndpointPlan {
  const candidate = target.join(runtimeDir, fileName);
  if (!withinSunPath(candidate)) {
    return refuse("path_too_long", sunPathMessage(candidate));
  }
  return { kind: "unix", path: candidate, parentDir: runtimeDir, createParent: false };
}

function planOverride(value: string, input: EndpointPlanInput): StudioEndpointPlan {
  // PIPE SYNTAX IS A WINDOWS-TARGET STATEMENT, and only that.
  //
  // It used to be accepted whenever the VALUE began `\\`, on every platform.
  // On Linux that skipped the ownership, mode and `lstat` validation this
  // function exists for and handed the literal to `server.listen`, which bound
  // a FILE named `\\.\pipe\...` relative to the process's working directory
  // while the bridge ENOENTed against a path that was never a socket. A pipe
  // override on a unix target is now refused BY NAME.
  if (input.platform !== "win32" && value.startsWith("\\\\")) {
    return refuse(
      "override_pipe_on_unix",
      `${STUDIO_SOCKET_OVERRIDE_ENV} looks like a Windows named pipe `
        + "(\\\\.\\pipe\\<name>), but this is not Windows. A pipe name is not a "
        + "unix socket path and would not be validated as one. Set an absolute "
        + "path in a directory you own with mode 0700. The Vex Studio host did "
        + "not start.",
    );
  }
  if (input.platform === "win32") {
    if (!isWindowsPipePath(value)) {
      return refuse(
        "override_invalid_pipe",
        `${STUDIO_SOCKET_OVERRIDE_ENV} is not a valid named pipe. Use `
          + "\\\\.\\pipe\\<name> with no separators in <name>. The Vex Studio "
          + "host did not start.",
      );
    }
    return { kind: "pipe", path: value };
  }

  const target = flavour(input.platform);
  if (!target.isAbsolute(value)) {
    return refuse(
      "override_not_absolute",
      `${STUDIO_SOCKET_OVERRIDE_ENV} must be an absolute path. A relative value `
        + "would put Vex's privileged listener wherever it happened to be "
        + "launched from. The Vex Studio host did not start.",
    );
  }
  if (!withinSunPath(value)) {
    return refuse("path_too_long", sunPathMessage(value));
  }

  const parentDir = target.dirname(value);
  const facts = input.probeDirectory(parentDir);
  if (facts === null) {
    return refuse(
      "override_parent_missing",
      `${STUDIO_SOCKET_OVERRIDE_ENV} points into ${parentDir}, which does not `
        + "exist. Vex does not create an override's directory: the operator owns "
        + "it, and creating it would mean Vex chose its permissions. The Vex "
        + "Studio host did not start.",
    );
  }
  if (!facts.isDirectory) {
    return refuse(
      "override_parent_not_directory",
      `${STUDIO_SOCKET_OVERRIDE_ENV} points into ${parentDir}, which is not a `
        + "directory. The Vex Studio host did not start.",
    );
  }
  if (facts.uid !== input.uid) {
    return refuse(
      "override_parent_not_owned",
      `${STUDIO_SOCKET_OVERRIDE_ENV} points into ${parentDir}, which is owned by `
        + "another user. Vex will not put a privileged listener in a directory it "
        + "does not own. The Vex Studio host did not start.",
    );
  }
  // EXACTLY 0700 for an override, not "0700 or tighter": an override is an
  // operator statement about a directory Vex did not create, and a mode that is
  // not what the contract names is worth refusing rather than interpreting.
  if ((facts.mode & 0o777) !== 0o700) {
    return refuse(
      "override_parent_mode",
      `${STUDIO_SOCKET_OVERRIDE_ENV} points into ${parentDir}, whose mode is `
        + `0${(facts.mode & 0o777).toString(8)} rather than 0700. Another user `
        + "could reach the socket. The Vex Studio host did not start.",
    );
  }
  return { kind: "unix", path: value, parentDir, createParent: false };
}

function sunPathMessage(candidate: string): string {
  return (
    `The Vex Studio socket path is ${String(Buffer.byteLength(candidate, "utf8"))} `
    + `bytes, over the ${String(STUDIO_SUN_PATH_MAX_BYTES)}-byte sun_path limit. `
    + `Set ${STUDIO_SOCKET_OVERRIDE_ENV} to a shorter absolute path in a `
    + "directory you own with mode 0700. The Vex Studio host did not start."
  );
}
