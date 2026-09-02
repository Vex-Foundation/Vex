# Vex Studio bridge endpoint and handshake contract (v1, FROZEN)

Status: frozen in stage A4a. Both sides of the wire implement it independently
and neither may change it alone.

AMENDED in the stage A4c fix arc: the config-directory resolver now defines
LEXICAL NORMALISATION explicitly (1.1.1), and the WINDOWS ENDPOINT is a served
named pipe following the VS Code pattern rather than a refusal (1.2, 1.4, 3.4,
3.5). Both are behaviour changes, both landed in every implementation in the
same change, and both carry vectors.

AMENDED AGAIN in the same fix arc, from external review turn 2:

- PIPE SYNTAX IS A WINDOWS-TARGET STATEMENT (1.4). A `\\`-prefixed override on
  a unix target is refused as `override_pipe_on_unix` rather than planned as a
  pipe, and both owners carry a defensive guard at their listen and dial sites.
- THE WINDOWS TRANSPORT IS RUNTIME-DISABLED behind one mechanical flag (1.6),
  refusing with `windows_pending_platform_proof`. Derivation, the pipe name,
  the override syntax and the handshake path are UNCHANGED and stay
  vector-tested; only opening the transport is refused.
- THE BRIDGE'S STDERR BOUND COVERS THE COMPLETE LINE (3.4), prefix and newline
  included.
- THE WINDOWS DIAL IS OVERLAPPED (3.5).

EXTENDED in stage A4c, additively and before the first bridge shipped: the
config-directory resolver rules (1.1.1), the frozen hash rules (1.1.2), the
bridge-side bounds in the section 3 limits table, and the bridge's failure
classes and shutdown state machine (3.4, 3.5). Nothing a v1 host or bridge
already observed changed shape; the resolver correction is described in 1.1.1
and landed in all three implementations in the same change.

SECURITY AMENDMENT after the independent backend audit: Unix endpoint use now
pins both the lexical ancestor chain and its realpath-resolved target chain by
filesystem identity (1.5). An identity change refuses locally with the shared
code `endpoint_ancestor_changed`, and the exact diagnostic is frozen in the
machine-readable companion fixture. This is additive under section 5.

- Host side: `vex-app/src/main/studio/mcp-host.ts` plus `mcp-host/endpoint.ts`,
  `mcp-host/handshake.ts`, `mcp-host/connection.ts`,
  `mcp-host/outbound-queue.ts`, and the engine's
  `src/vex-agent/mcp/socket-transport.ts`.
- Bridge side: the Go module `bridge/` - `cmd/vex-mcp` plus
  `internal/{configdir,endpoint,handshake,relay}`. It re-derives the endpoint
  from the same rules with no shared code and no configuration file to read,
  and its table tests consume this file's fixture by relative path.
- Config-directory owners, all three running the same `configDir` vectors:
  `src/config/paths.ts`, `vex-app/src/main/paths/config-dir.ts`,
  `bridge/internal/configdir`.

Machine-readable companion: `bridge-endpoint-vectors.json` beside this file.
Every rule below that can be expressed as data is in that fixture, and both
sides run it as a test. Prose here explains WHY; the fixture is what the tests
compare against.

Why a contract document at all: the bridge ships as a separate binary, on a
separate release cadence, and a user can run an old bridge against a new Vex.
The two cannot negotiate anything before the handshake, so everything before it
has to be derivable from facts both processes already hold.

---

## 1. The endpoint

### 1.1 The discriminator

```
hash = first 12 lowercase hex characters of SHA-256(realpath of the Vex config directory, UTF-8)
file = vex-studio-<hash>.sock
```

The hash input is the CONFIG DIRECTORY, resolved through `realpath`, with no
normalisation of its own: a trailing separator is a different string and
therefore a different endpoint, and both sides must agree on that rather than
each inventing a cleanup rule.

WHEN `realpath` FAILS, both sides hash the LITERAL path. That is frozen here and
pinned by the vector `realpathFallback: "literal"`. `realpath` fails when the
directory does not exist yet, which is every first run, and a side that refused
to derive an endpoint there while the other side derived one would produce a
bridge connecting to a path the app never bound. The fallback is not a trust
decision: the endpoint's parent directory is verified for real ownership, real
directory-ness and mode 0700 at bind time (section 1.5) whichever string was
hashed.

### 1.1.1 The config-directory resolver

Three implementations derive this directory independently: `src/config/paths.ts`
(engine), `vex-app/src/main/paths/config-dir.ts` (app) and
`bridge/internal/configdir` (bridge). All three execute the `configDir` section
of the vectors as a table test, because this is the highest-divergence seam on
the wire: the endpoint hash is taken over the result, so a difference of one
separator is a bridge that dials a path the app never bound.

| platform | config directory |
| --- | --- |
| Linux and other Unix | `$XDG_CONFIG_HOME/vex`, or `~/.config/vex` |
| macOS | `~/Library/Application Support/vex` |
| Windows | `%APPDATA%/vex`, or `~/AppData/Roaming/vex` |

`VEX_CONFIG_DIR` overrides all three. `XDG_CONFIG_HOME` and `APPDATA` select
their platform's base. All three are read under ONE rule:

> A directory environment variable is USABLE only when it is non-empty AND
> absolute for the TARGET platform. Anything else is treated as UNSET.

EMPTY IS UNSET, and that is a correction, not a restatement. Until stage A4c
both Node owners used `env.XDG_CONFIG_HOME ?? join(home, ".config")`, and `??`
accepts an empty string: `join("", "vex")` is the RELATIVE path `"vex"`, so an
empty `XDG_CONFIG_HOME` put the config directory - keystores included - in
whatever working directory the launcher happened to have. The XDG Base
Directory specification is explicit that an empty value must be ignored
("If `$XDG_CONFIG_HOME` is either not set or empty, a default equal to
`$HOME/.config` should be used"), and `APPDATA` is held to the same rule so one
sentence covers every platform.

RELATIVE IS UNSET for the reason `VEX_CONFIG_DIR` already had: a typo must never
redirect a privileged path into the launcher's working directory.

An ACCEPTED `VEX_CONFIG_DIR` is returned VERBATIM. No join, no clean, no
trailing-separator normalisation: the hash is over exactly those bytes, and a
cleanup rule invented on one side is a different endpoint. The platform
defaults, by contrast, are JOINED, and a join absorbs a trailing separator on
its base - so `XDG_CONFIG_HOME=/x/` and `XDG_CONFIG_HOME=/x` agree, while
`VEX_CONFIG_DIR=/x/` and `VEX_CONFIG_DIR=/x` do not. Both facts are vectors.

PATH FLAVOUR follows the TARGET platform, not the host running the resolver.
Windows joins with a backslash and normalises forward slashes; everything else
joins with a forward slash. The Node owners select `path.win32` or `path.posix`
from their input rather than using the ambient `path`, which is what lets one
fixture name one expected string per case and all three implementations agree
on it.

LEXICAL NORMALISATION IS PART OF THE JOIN, and it is spelled out here because
the three implementations cannot each invent it. A joined platform default is
normalised exactly as `path.posix.join` / `path.win32.join` normalises:

- a `.` segment is dropped;
- a `..` segment is resolved against the segment before it, LEXICALLY - no
  filesystem is consulted and no symlink is followed - and is DISCARDED at the
  root of an absolute path (`/a/../..` is `/`);
- repeated separators collapse to one;
- a trailing separator on the base is absorbed;
- on win32 forward slashes become backslashes, and a UNC root
  (`\\server\share`) or device root (`C:`) is PRESERVED rather than consumed
  by a `..`.

This is a CORRECTION, landed in all three implementations in the same change.
The Node owners always normalised, because `path.join` does. The Go bridge
concatenated. So `XDG_CONFIG_HOME=/home/alice/../vex-x` - a legal, ordinary
value - resolved to `/home/vex-x/vex` on the app side and
`/home/alice/../vex-x/vex` on the bridge side, and since the endpoint hash is
taken over that string, the two DERIVED DIFFERENT SOCKETS: the bridge dialled a
path the app never bound. Every rule above is now pinned by its own
cross-owner vector in the `configDir` section, and the bridge implements the
flavour-aware normaliser itself (`bridge/internal/configdir/lexical.go`,
with its own table tests) because Go's `path/filepath` is HOST-flavoured and
cannot answer for a target platform.

The ASYMMETRY stands and is itself a vector: an accepted `VEX_CONFIG_DIR` is
returned VERBATIM and is NOT normalised, because the hash is over exactly those
bytes. `VEX_CONFIG_DIR=/srv//state/../x/` hashes as written; the same value in
`XDG_CONFIG_HOME` does not, because the platform default is JOINED.

### 1.1.2 The hash rules, frozen

The discriminator is SHA-256 over the EXACT UTF-8 bytes of the resolved config
directory. Explicitly forbidden, on both sides:

- no byte-order mark;
- no trailing newline;
- no case folding;
- no Unicode normalisation (NFC or NFD);
- no separator conversion;
- no `filepath.Clean` / `path.normalize`.

Each of those is pinned NEGATIVELY in `hashRules`: the fixture carries the hash
the forbidden transform would produce, and the tests assert it differs. A rule
whose violation cannot be detected is prose, not contract.

Symlink evaluation has exactly two branches:

- SUCCESS: hash the RESOLVED path. Go's `filepath.EvalSymlinks` cleans a
  successful result and Node's `realpathSync` returns a canonical path, so both
  sides land on the same string. That agreement is the only reason success is
  allowed to clean at all. The macOS `/var -> /private/var` case is a vector,
  because it is the realistic path on which one side could resolve and the
  other could not.
- FAILURE: hash the ORIGINAL literal, with NO `Clean`. Failure is every first
  run, before the directory exists. A side that cleaned here would derive a
  different endpoint from a side that did not, and the dotted-and-doubled
  literal in the fixture makes that difference visible.

The TEMPORARY DIRECTORY is never realpathed. It is used as the platform reports
it, because resolving it would move macOS from `/var/folders/...` to
`/private/var/folders/...` on whichever side did the resolving.

The PROJECTS ROOT was rejected as the hash input. It can be overridden in
`config.json`, and a standalone bridge has no validated way to read that file -
it would have to parse app configuration to learn where to connect, which is a
trust boundary the bridge does not have.

Twelve hex characters is 48 bits. That is a collision question about two config
directories on one machine, not an adversarial one: the socket's directory
permissions are the access control and the handshake is the admission check.

### 1.2 Derivation per OS

**Linux.** `$XDG_RUNTIME_DIR/vex-studio-<hash>.sock` when `XDG_RUNTIME_DIR` is
set, absolute, a directory, owned by the current uid, and has no group or other
permission bits. Any of those failing falls through to the tmpdir form below.
Those are the four ways a runtime directory stops being private, and a listener
in a directory another user can read is the failure this whole section exists
to prevent.

**Linux fallback and macOS.**

```
<tmpdir>/vex-studio-<uid>/vex-studio-<hash>.sock
```

The host CREATES that parent directory with mode 0700 and then verifies it:
`mkdir` honours the umask, so the requested mode is a request and not a fact.
Ownership and mode are re-checked after the `chmod`, and a directory that is
still not private refuses startup.

macOS always uses this form. This is a Vex adaptation, not the VS Code scheme
verbatim: VS Code's macOS static handle lives under a caller-supplied userData
directory, and the ownership, mode, symlink and stale-entry behavior below are
Vex's own and carry their own tests.

**Windows.**

```
\\.\pipe\vex-studio-<hash>
```

Same discriminator, same hash input, different transport. Windows has no
filesystem socket, so the endpoint lives in the machine's pipe namespace.

THE PATTERN IS VS CODE'S, ADOPTED 1:1 (owner decision, plan revision-log item
47), replacing the `windows_probe_pending` refusal that stood through A4a.
Evidence, verified in the reference checkout: `createStaticIPCHandle`
(`src/vs/base/parts/ipc/node/ipc.net.ts`) serves VS Code's MAIN IPC on win32 as
a named pipe with a hash-derived PREDICTABLE name through a plain
`createServer().listen`, and the entire `src/vs/base` + `src/vs/platform` tree
contains ZERO security-descriptor handling. The security model is therefore the
documented Windows DEFAULT pipe security descriptor - which does not grant
another user the duplex access a client needs - plus protocol-level validation.
Vex keeps its own additional layers on top: the listener exists only while Vex
is unlocked and ready, the handshake ack admits a project, and every mutating
call is approval-gated. The name is not a secret and is not treated as one.

NO CUSTOM ACL. Node exposes no security-descriptor option, and Vex does not
reach for one through a native module: P4 is satisfied the way VS Code
satisfies it.

LIFECYCLE, and the two places it differs from the unix arm:

- THERE IS NO UNLINK. A pipe exists only while its server does; the operating
  system reclaims the name on close. So there is no stale file to remove, no
  parent directory to create or verify, no symlink to refuse, no `sun_path`
  bound and no `chmod`. Section 1.5's four checks collapse to one.
- THE STALE CHECK IS A CONNECT PROBE ONLY. A pipe that answers means another
  Vex owns it, and startup REFUSES rather than racing it, for the same reason a
  live socket is never stolen.

RUNTIME-DISABLED UNTIL MEASURED. Everything above is what the implementations
DERIVE; section 1.6 is the gate that decides whether they may open it, and it
is currently closed. Derivation, pipe syntax, the shared discriminator, the
plan shape and the relay's half-close seam are what the Linux-hosted tests
prove, and they prove nothing about the descriptor.

### 1.3 The `sun_path` bound

Every candidate path is asserted at BUILD TIME of the path, before any bind:
its UTF-8 byte length must be at most 103 (`sun_path` is ~104 bytes including
the terminator on Linux and macOS). A path over the bound REFUSES startup with
a message naming `VEX_STUDIO_SOCKET` as the remedy. It is never shortened,
hashed differently, or truncated: a silently different path is a bridge that
connects to nothing.

### 1.4 `VEX_STUDIO_SOCKET`, and its validation BEFORE bind

The override wins everywhere it is accepted. It is validated first, and a value
that fails validation REFUSES host startup with the named cause. It never falls
back to the derived path, because the derived path's parent has verified
ownership and mode and a silent substitution would hide that somebody pointed
Vex's privileged listener somewhere unverified. That is the P4 trust boundary.

On Unix, all of these must hold:

| requirement | refusal code |
| --- | --- |
| absolute path | `override_not_absolute` |
| within the `sun_path` bound | `path_too_long` |
| parent directory exists | `override_parent_missing` |
| parent is a directory | `override_parent_not_directory` |
| parent owned by the current uid | `override_parent_not_owned` |
| parent mode is EXACTLY 0700 | `override_parent_mode` |

The parent's mode is compared exactly rather than "0700 or tighter", unlike the
derived case. An override is an operator statement about a directory Vex did
not create; a mode that is not the one the contract names is worth refusing
rather than interpreting.

Vex never CREATES an override's parent directory. Creating it would mean Vex
chose its permissions on the operator's behalf.

PIPE SYNTAX IS A WINDOWS-TARGET STATEMENT, and only that.

On a WIN32 target, a value beginning `\\` is treated as a Windows named pipe
and is checked structurally: `\\.\pipe\<name>` or `\\?\pipe\<name>`, `<name>`
non-empty and containing no separator. A malformed one is
`override_invalid_pipe`. A valid one REPLACES the derived pipe (section 1.2)
and is subject to the section 1.6 gate before it is bound or dialled. The
DERIVED name is held to the same syntax rule, so the host cannot bind a name
the bridge's own validator would refuse.

On a UNIX target, a value beginning `\\` is refused as `override_pipe_on_unix`.

| requirement | refusal code |
| --- | --- |
| a `\\`-prefixed override on a unix target is refused | `override_pipe_on_unix` |

It used to be planned as a pipe on EVERY platform, keyed off the value rather
than the target. That skipped the whole unix table above - absolute path,
`sun_path`, parent existence, ownership and the exact 0700 mode - and handed
the literal to `listen`, where a host on Linux bound an ordinary FILE named
`\\.\pipe\...` relative to its working directory while the bridge ENOENTed
against a path that was never a socket. A privileged listener in an unverified
location is the exact P4 failure section 1.4 exists to prevent, so the refusal
is by name and the classification is by TARGET.

Both owners additionally carry a DEFENSIVE RUNTIME GUARD at the site that
touches the transport - the host before `server.listen`, the bridge before the
dial - so a pipe path can never reach `listen` or `CreateFile` off win32 even
if a plan were constructed by hand. Three unix negative vectors pin the rule
(`\\.\pipe\<name>` on linux, `\\?\pipe\<name>` on darwin, and a MALFORMED
pipe on linux, which is `override_pipe_on_unix` rather than
`override_invalid_pipe`: on a unix target the wrong-platform fact is the one
worth reporting).

### 1.5 Stale and live endpoints

Removing an existing socket file is NEVER a blind unlink. In order:

1. verify the parent's ownership and mode (section 1.2 or 1.4);
2. `lstat` the endpoint - a SYMLINK is seen as a symlink, not as whatever it
   points at;
3. anything that is not a socket REFUSES startup and is left in place;
4. a socket is PROBED by connecting to it. A probe that connects, or that
   connects and never answers within one second, means the endpoint is LIVE:
   another Vex owns it, startup REFUSES, and the path is not stolen. Taking it
   would leave that Vex's bridges talking to nothing;
5. only a socket that refuses the probe connection is unlinked.

The socket itself is `chmod`ed to 0600 after bind, in addition to the 0700
directory.

#### 1.5.1 Ancestor identity between validation and use

Ownership, mode and immediate-parent validation are snapshots. They are not
permission to keep using the same path after an ancestor has been replaced.
On Unix, both owners therefore capture every existing ancestor from the
filesystem root through the endpoint parent before transport use. Each entry
is pinned by kind plus device/inode identity. The host verifies the snapshot
before stale removal, immediately before unlink, immediately before bind, and
after bind. The bridge captures before dial and verifies after connect but
before sending the project handshake.

The path walk has TWO views. The LEXICAL chain records an intermediate symlink
itself. A lexical chain alone does not record the real target ancestors behind
that link, so a stable link plus a replaced target chain could otherwise pass
verification. Both owners also resolve the endpoint parent through realpath
and pin every ancestor in that resolved chain. Failure to resolve or inspect
either chain refuses before transport use.

| requirement | refusal code |
| --- | --- |
| every lexical and realpath-resolved ancestor retains its captured kind and filesystem identity | `endpoint_ancestor_changed` |

The emitted local-refusal sentence is frozen, including its code prefix:

```
endpoint_ancestor_changed: The Vex Studio endpoint ancestor <absolute-path> changed before use.
```

The `endpointAncestorIdentity.changed` golden vector supplies one path and the
complete expected sentence. The TypeScript host and Go bridge independently
format and test that same vector, so code or sentence drift is a red test.

ACCEPTED RESIDUAL, STATED PLAINLY. These checks are path-based because Node has
no descriptor-relative socket bind/unlink API, and Go has no matching
cross-platform standard-library primitive. If a filesystem removes and
recreates an entry between checks with the same kind, device and immediately
reused inode, identity comparison cannot distinguish it from the captured
entry. The held-original race tests prevent inode reuse in the measured attack
case, but they do not claim that inode reuse is impossible.

The prior INTERMEDIATE-SYMLINK residual is not accepted silently: the lexical
chain still cannot describe a symlink target, which is why the realpath chain
is mandatory too. Replacing a target ancestor in the ordinary case changes an
identity in that second chain and refuses. The same-path device/inode reuse
residual above applies to both views.

### 1.6 The Windows transport gate, and how it opens

THE WINDOWS NAMED-PIPE TRANSPORT IS RUNTIME-DISABLED. Both owners hold one
flag, and both refuse a pipe plan with the code `windows_pending_platform_proof`
while it is false:

| owner | flag |
| --- | --- |
| host | `WINDOWS_TRANSPORT_PROVEN` in `vex-app/src/main/studio/mcp-host/endpoint.ts` |
| bridge | `endpoint.WindowsTransportProven` in `bridge/internal/endpoint/endpoint.go` |

The refusal is applied at the site that would TOUCH the transport - the host
before `server.listen`, the bridge before the dial - and it maps to the
existing local-refusal exit code 2 (section 3.4).

WHAT IS NOT DISABLED. The pattern stays, and stays vector-tested: the
derivation of `\\.\pipe\vex-studio-<hash>` (1.2), the pipe-syntax validator and
the win32 override plan (1.4), the plan shape, and the handshake and relay
paths a pipe would use. A change that "disabled Windows" by breaking any of
those would fail the vectors, which is the point.

WHY IT IS CLOSED. libuv - what Node's `server.listen` reaches on win32 -
creates the pipe with a NULL security descriptor and WITHOUT
`PIPE_REJECT_REMOTE_CLIENTS`. The resulting DEFAULT security descriptor grants
Everyone, and the anonymous logon, READ access. Duplex is denied to a second
user, so the handshake itself cannot be driven by one; a READ-ONLY connect is
not denied, and on a self-custodial wallet that is a cross-user
handshake-slot-exhaustion vector against `maxHandshakePending`, plus a
remote-client posture nobody has measured. Rule 90 fails closed until it is
measured, and VS Code's precedent is evidence about VS Code's threat model,
not a measurement of ours.

HOW IT OPENS - MECHANICALLY, NOT EDITORIALLY. The REQUIRED CI job
`bridge-windows` (`.github/workflows/ci.yml`) runs on `windows-latest`. It
exists today as a STUB: it compiles every package for `windows/amd64`,
including the build-tagged overlapped dial, and runs the Go vector tests there.
FLIPPING EITHER FLAG REQUIRES EXTENDING THAT JOB with the full proof matrix
below, and the reviewer's check is mechanical: no matrix in the job, no flip.

THE INSTRUMENT THAT MEASURES FIVE OF THE EIGHT. `bridge/cmd/probe-pipe-acl`
is a Windows-only probe binary (non-Windows stub, exit 2, the shape of
`cmd/spike-overlapped-stdio`). It ships in nothing and no packaging path builds
it. It has two modes:

- `serve --name <pipe> --ready <file> [--descriptor front|winio-default|open]`
  binds through the REAL `listener.Bind` - the front's compiled-in descriptor
  and the front's readback, nothing re-implemented - writes the CONFIRMED BOUND
  flags to the ready file as JSON, runs the real `listener.Serve`, records every
  accepted connection's client pid and the impersonation level a server actually
  receives, and exits on stdin EOF. The two non-`front` descriptors are TEST
  ONLY arms of the measurement, and they exist on the probe and never on the
  front: `winio-default` is go-winio's default named-pipe ACL, the CONTROL that
  attributes a denial to the front's DACL rather than to the account; `open` is
  `D:P(A;;FA;;;WD)`, the accurate SQUATTER, because an adversary who takes the
  pipe name in order to be talked to grants everyone access.
- `dial --name <pipe> [--expect connected|denied] [--access duplex|read]` opens
  the pipe with the SAME flags the shipped bridge sends
  (`FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`,
  mirroring `cmd/vex-mcp/dial_windows.go`), classifies the result into the
  closed set `{connected, access_denied, file_not_found, pipe_busy,
  other(code)}` and prints ONE JSON line. Omitting `--expect` RECORDS the
  outcome without asserting one, which is what an unmeasured question gets.

Its output is structural: outcome names, Windows error codes, process ids and
enum numbers. Never the descriptor, never a SID, never an account name, never
the password the job generates, never the pipe path - a Windows error string
carries that path, which is why no error string is ever printed.

The proof matrix, all eight on a Windows runner:

1. SECOND-USER DUPLEX DENIAL - CI-MEASURED on `bridge-windows`, run
   `<measured on run N>`. A temporary local account, created by the job and
   removed in an always-step, dials the pipe the front bound and is refused with
   ERROR_ACCESS_DENIED, while the same account CONNECTS to the control pipe
   served with go-winio's default descriptor in the same run. The pairing is
   what makes it evidence: the denial is the front's DACL, not the account.
   (Was: "denied by the default security descriptor" - superseded, the front now
   binds its own PROTECTED two-ACE descriptor and libuv never sees the pipe.)
2. READ-ONLY CROSS-USER CONNECT - CI-MEASURED on `bridge-windows`, run
   `<measured on run N>`. The same temporary account dials the front's pipe with
   GENERIC_READ only and is refused with ERROR_ACCESS_DENIED: the front's DACL
   has no Everyone ACE, so the read-only open the default descriptor would have
   allowed is denied too. The serve side's `serve_done` line reports how many
   connections were accepted in total, so a read-only connect that had consumed
   an instance would be visible as one. The slot-exhaustion vector this row was
   written for therefore cannot be reached by another local user; it remains
   reachable by another process of the SAME user, which is out of scope for this
   boundary and is bounded instead by `maxRaw` (section 8.1).
3. REMOTE-CLIENT REJECTION - PARTIALLY CI-MEASURED on `bridge-windows`, run
   `<measured on run N>`. Two facts are recorded and neither is asserted: the
   `rejectRemote` bit of the BOUND flags the front CONFIRMED by readback
   (`<measured on run N>`), and the classified outcome of a dial through the
   loopback redirector path `\\localhost\pipe\<name>`, which the pipe file system
   treats as a network client (`<measured on run N>`). A connect arriving from
   ANOTHER MACHINE is NOT measured and cannot be on a hosted runner: it needs a
   second host on the same network and inbound SMB, neither of which a GitHub
   runner has.
4. NATIVE PIPE ROUND TRIP - UNPROVEN. The real host and the real built bridge
   exchanging a handshake and MCP frames over the pipe. No test in this
   repository drives that path end to end on Windows today; the front's Windows
   suite (`listener/bind_windows_test.go`) covers the bind, the descriptor and
   the half-close, and the conformance suite runs over a unix socket on Linux.
5. OVERLAPPED DUPLEX - UNPROVEN. A pending read and a concurrent write on the
   SAME overlapped handle both completing. The `studio-overlapped-spike` job
   measured that property for INHERITED STDIO handles under Electron, which is a
   different handle from a different creator; nothing has measured it on the
   pipe handle `cmd/vex-mcp/dial_windows.go` opens.
6. DEADLINE AND CLOSE CANCELLATION - UNPROVEN. The ack and drain deadlines
   firing on a pipe handle, and close cancelling a blocked operation. The
   deadline paths are covered on Linux sockets only.
7. FOREIGN-USER FIRST-SERVER PIPE SQUATTING - CI-MEASURED on `bridge-windows`,
   run `<measured on run N>`, in two halves.
   - The FRONT'S half: the temporary account serves the name first, then the
     front is asked to bind the SAME name through the real `listener.Bind` and
     FAILS CLOSED - go-winio's first instance uses the FILE_CREATE disposition,
     so the collision is a bind failure and no BOUND is ever reported. The job
     asserts the probe's `{"outcome":"bind_failed"}` line and the ABSENCE of a
     ready file.
   - The BRIDGE'S half: with the temporary account's server up,
     `go test -run TestHostAuthRefusesAForeignUsersServer ./cmd/vex-mcp` drives
     the PRODUCTION `dialPipe` against it - real CreateFile with the shipped SQOS
     flags, real `GetNamedPipeServerProcessId`, real token query, real SID
     comparison - and asserts the typed local refusal
     `windows_host_not_current_user`, that no connection was returned, and that
     the refusal carries a pid and no SID. Off that job the test SKIPS with its
     reason rather than passing.
   This is the test that proves the anti-squatting control exists, so it must
   fail if the control is removed.
8. SERVER IMPERSONATION LEVEL - CI-MEASURED on `bridge-windows`, run
   `<measured on run N>`. Measured FROM THE SERVER'S SIDE, which is the only
   honest way to ask it: for every accepted connection the probe impersonates
   the client on a locked operating-system thread
   (`ImpersonateNamedPipeClient`), reads `TokenImpersonationLevel` off the
   thread token, reverts, and reports the enum number and its name. Against the
   bridge's own SQOS flags the level must be SecurityIdentification, which is
   **1** - the value 2 is SecurityImpersonation, the level those flags exist to
   prevent, and TokenImpersonation, a different enum in the same header, is also
   2. The job asserts 1 on the runner-user duplex dial and records the level for
   every other accepted connection.

REQUIRED BEFORE THE FLIP: HOST AUTHENTICATION - IMPLEMENTED, AND CROSS-USER
MEASURED SINCE THE TWO-ACCOUNT STEP OF ROW 7 ABOVE.

The bridge authenticates the pipe server before the handshake. In
`bridge/cmd/vex-mcp/hostauth_windows.go`, between `CreateFile` returning a
handle and that handle becoming a connection, the bridge calls
`GetNamedPipeServerProcessId` on the connected handle, opens the reported
process with `PROCESS_QUERY_LIMITED_INFORMATION`, opens its token with
`TOKEN_QUERY`, reads `GetTokenInformation(TokenUser)`, and compares the
resulting user SID, in canonical string form, with this process's own
process-token user SID. Anything other than an exact match - a mismatch, an
empty SID, or a failure at any step - closes the raw handle and returns the
local refusal `windows_host_not_current_user`, which exits 2 (local refusal,
section 3.4), not 3 (dial failed). No byte, and in particular not the project
id, leaves the process on that path: the handshake is unreachable because no
connection is ever constructed. The refusal names the pipe path and the server
pid; it never reports the other user's identity.

The SQOS flag of item 8 is NECESSARY, NOT SUFFICIENT. It bounds what a hostile
server can do with the client's token; it says nothing about WHO the server is.
The host-authentication check is the load-bearing anti-squatting control, and
item 7 is its test.

This does not flip the gate. `endpoint.WindowsTransportProven` stays false, and
rows 4, 5 and 6 are why.

What the `bridge-windows` job now proves about THIS control: the SAME-USER path
end to end against a real in-test named-pipe server, driving the real
`GetNamedPipeServerProcessId` and token comparison; the refusal branches through
an injected identity-resolver seam, asserting in each case that the pipe server
received zero bytes; and, since row 7's second half, the CROSS-USER refusal
against a pipe genuinely served by a temporary local account the job creates and
removes. The check accepts any same-user server by design - the boundary this
control enforces is the other user, not another program running as this one.

Until all eight run in that job, Windows users get one honest refusal sentence
naming the reason, and Vex Studio is a Linux and macOS feature.

---

## 2. The handshake

### 2.1 The exchange

```
bridge -> host   {"v":1,"projectId":"<uuid>"}\n
host   -> bridge {"ok":true}\n
                 or {"ok":false,"code":"<code>","message":"<sentence>"}\n
```

The bridge sends ONE line and WAITS. Only after `{"ok":true}` does it read and
forward MCP stdin. On `ok:false` the host closes the connection after writing
the ack.

Bounds: the handshake line is at most 4096 bytes and must arrive within 5000 ms
of the connection being accepted. A socket that misses either is refused
`malformed` and closed.

### 2.2 Refusal codes

Closed set. The bridge switches on the code and prints one actionable line.

| code | meaning |
| --- | --- |
| `unknown_project` | no such project in this Vex |
| `incompatible_version` | unknown `v` major; the message NAMES the supported one |
| `locked` | Vex is locked, still starting, or shutting down |
| `at_capacity` | 16 connections, or 4 sockets already waiting to handshake |
| `malformed` | not JSON, not an object, bad `v`, bad `projectId`, over the bound, or no line within the deadline |

`v` is a MAJOR. An unknown major is `incompatible_version`, never `malformed`:
the two have different remedies (update the bridge versus fix the caller).

### 2.3 The project check is NON-AUTHORITATIVE

The host's existence check exists so a misconfigured bridge gets a real
sentence instead of a silent MCP surface with nothing behind it. Its result is
DISCARDED the moment the ack is written. It is not an authorization decision
and it does not become one: `runStudioCall` loads the project's permission and
wallet scope in ONE atomic snapshot on EVERY call, `vex_ToolSearch` included.
A scope carried on a connection would be a stale authorization cache - a
connection opened while a project was `full` would keep executing mutations
after the user made it `restricted`, with no approval row for the A3 gates to
protect.

The handshake binds a `projectId` and nothing else.

### 2.4 The parser is REMAINDER-PRESERVING

A conforming bridge waits for the ack. A non-conforming one may put
`handshake\n` and `initialize\n` in the same segment. The host's parser returns
every byte after the handshake newline, and those bytes become the MCP
transport's starting buffer. A coalesced opening therefore loses nothing.

The host also PAUSES the socket between the handshake parser detaching and the
transport attaching. Removing the last `data` listener does not stop a flowing
socket - it makes Node drop what arrives - and that window spans an ack write
and a dynamic import of the MCP SDK, which is easily long enough for an
`initialize` to land in it.

---

## 3. Framing after the ack

Newline-delimited JSON in both directions. One JSON-RPC object per line, no
embedded raw newline.

| bound | value | behavior at the bound |
| --- | --- | --- |
| inbound MCP line | 4 MiB | typed `-32600` error frame with `id: null`, then close |
| decoded messages queued per connection | 16 | socket PAUSED at the bound; a chunk that decodes past it gets the typed error and a close |
| established connections | 16 | connection 17 refused `at_capacity`. NO EVICTION |
| sockets waiting to handshake | 4 | the fifth refused `at_capacity` |
| sockets the listener accepts at all | 21 | 16 + 4 + ONE overflow, so the first socket past the two bounds is REFUSED with a typed ack instead of dropped by Node; the 22nd is dropped |
| in-flight calls per connection | 8 | typed busy tool result, never a hang |
| in-flight calls globally | 32 | typed busy tool result (matches the approval broker's waiter cap) |
| pending outbound frames per connection | 64 | responses fail the connection at the bound; progress is dropped |
| established-connection reservations | 16 | claimed SYNCHRONOUSLY when the handshake line parses, before any await, so two concurrent handshakes cannot both pass the bound |
| shutdown | 5000 ms | `end()`, then destroy |

The BRIDGE's own bounds, named here because the bridge ships on a separate
cadence and cannot negotiate them:

| bound | value | behavior at the bound |
| --- | --- | --- |
| dial timeout | 2000 ms | the connect attempt fails with a named sentence. The socket is local, so anything slower is a host that is not answering |
| ack read deadline | 5000 ms | MATCHES the host's handshake deadline, so neither side outlives the other's silence |
| drain deadline | 5000 ms | MATCHES the host's shutdown deadline. The bounded drain after `CloseWrite` stops here, and the fact is REPORTED on stderr rather than presented as a clean close |
| stderr diagnostic | 512 bytes | one line. Over the bound, the remainder is dropped WITH its byte count named; control characters become spaces so a peer message cannot forge a second line |


The overflow slot is why the listener cap is 21 and not 20. `maxConnections` is
a Node-level drop: the socket is accepted and destroyed with no byte written, so
at exactly 16 established plus 4 pending the next bridge saw an unexplained
close where this contract promises a typed `at_capacity` ack. The 21st socket is
admitted so it can reach the handshake-pending path, be refused with the ack,
and be closed. It can never become established: the established-connection
reservation is a separate, synchronous bound.

There is no eviction anywhere in that table. An approval-blocked connection has
no traffic and is not idle, so any "least recently used" rule would pick exactly
the connection a human is deciding.

A blank line is a no-op keepalive, not a frame and not an error.

### 3.1 Outbound: a real queue, not a high-water mark

`socket.write` returning `false` is not backpressure; it is a notice that Node
has started buffering, without a bound. Approval progress fires every two
seconds, so a peer that stops reading would otherwise accumulate one frame per
tick for as long as the human takes to decide.

So the host owns one serialized send owner per connection:

- RESPONSES are never dropped, never coalesced and never cut. They wait.
- `notifications/progress` coalesces per progress token: at most ONE may be
  queued for a request, and a newer one REPLACES the queued one. Replacement
  only ever touches an entry still in the queue - an entry the writer has taken
  is immutable, so a coalesce can never overlap a blocked send.
- Every pending send SETTLES on close rather than rejecting; the connection's
  own teardown is the event that matters and it has already fired.

### 3.2 Close

CORRECTED to the landed seam. An earlier revision of this section said a peer
FIN propagates as the transport's `onclose`. IT DOES NOT, and the difference is
a whole class of session:

- A PEER FIN raises the wire's `end` - readable EOF - and the WRITABLE SIDE IS
  PRESERVED. `src/vex-agent/mcp/duplex-transport.ts` states it as an obligation
  on every implementation: "A peer that half-closes is saying 'no more
  requests', not 'no more answers': `end` must fire without the writable side
  being torn down, so the last response of a one-shot session can still be
  written. An implementation that ends the writable side on peer FIN breaks
  every `claude -p` style session, silently." On that edge
  `StudioSocketTransport` starts its BOUNDED POST-EOF DRAIN under one absolute
  deadline, so answers to already-sent requests are still written. The edge is
  queryable after the fact as `readableEnded`, because Node does not replay
  `end` to a late listener.
- THE WIRE BEING GONE - the `close` edge - is what announces `onclose`, exactly
  once. THAT is what aborts every in-flight MCP request handler's `AbortSignal`,
  which is what withdraws a blocked Studio approval. Missing that edge leaves an
  approval waiting for a peer that is gone; firing it twice is a second teardown
  of an already-closed instance. The transport latches it.

Announcing `onclose` on the FIN edge is the exact defect the drain exists to
undo: it aborted every in-flight handler at the moment a one-shot bridge stopped
asking, so the answers it was waiting for were never written.

Shutdown gives the writable side 5000 ms to flush, then destroys.

---

## 3.3 The tool surface `_meta` keys

`tools/list` records carry two `_meta` keys, both stable wire contract:

| key | value | meaning |
| --- | --- | --- |
| `anthropic/alwaysLoad` | `true` | the HOT SET. Present only when true, never `false` |
| `vex/requiresEnv` | array of strings | the environment variable NAMES this tool needs |

`vex/requiresEnv` carries NAMES ONLY and never values: a value would be a secret
on a wire an external agent reads. It is an array because the key is contract and
a tool that later needs two variables must not change its shape.

It is METADATA, never enforcement. The list of tools never varies by environment,
and an unmet variable is answered at CALL time with a typed
`configuration_unavailable` result naming the variable and the remedy. A client
may use the key to explain to a user why a tool will refuse; a client that
ignores the key loses nothing but the explanation.

---

## 3.4 The bridge's failure classes and exit codes

The bridge answers every failure with ONE sanitized stderr line and a distinct
non-zero exit code. The codes are contract: a supervising client can tell "Vex
is locked" from "that project is gone" without parsing English.

THE LINE IS BOUNDED AT `bridgeDiagnosticMaxBytes` (512), AND THE BOUND IS THE
COMPLETE WIRE PAYLOAD: the `vex-mcp: ` prefix, the sanitized body, and the
terminating newline. The body budget is therefore `512 - 9 - 1 = 502`, applied
INSIDE the diagnostic assembly so the omission notice is paid for too. The
built binary previously emitted 522 bytes from a "512-byte" bound because the
body was budgeted 512 and the writer then added the framing; the conformance
suite now measures the UNSLICED captured stderr, so the assertion is on what
reaches the pipe rather than on the part the program formats. Content that does
not fit is REPORTED with its exact omitted byte count, never silently dropped.

| exit | class | source |
| --- | --- | --- |
| 0 | the session ended cleanly | client stdin EOF after the drain, or peer EOF |
| 1 | usage | no project id, a non-UUID project id, an unknown argument |
| 2 | endpoint refused locally | every `RefusalCode` in sections 1.4 and 1.5.1, including `override_pipe_on_unix` and `endpoint_ancestor_changed`, plus `windows_pending_platform_proof` from the section 1.6 gate. `windows_probe_pending` was REMOVED with the Windows adoption in section 1.2 and is no longer a code either side emits |
| 3 | dial failed | ENOENT, ECONNREFUSED, EACCES, or the dial timeout |
| 4 | handshake failed | write failure, ack deadline, ack over the bound, or an ack that fails the strict parse |
| 5 | refused `unknown_project` | ack |
| 6 | refused `incompatible_version` | ack |
| 7 | refused `locked` | ack |
| 8 | refused `at_capacity` | ack |
| 9 | refused `malformed` | ack |
| 10 | refused with a code this bridge does not know | ack. A NEW refusal code is an additive change (section 5), so a v1 bridge prints the host's message and exits non-zero rather than crashing |
| 11 | the relay failed | the client stopped reading, or the socket failed mid-session |
| 12 | a signal stopped the bridge | SIGINT, SIGTERM or SIGHUP |

NO RETRY, anywhere. AN ACK IS A DECISION THE HOST ALREADY MADE, AND IT IS
TERMINAL FOR THIS PROCESS. That is the whole rationale, and it does not depend
on the listener's lifecycle: since section 4.1 the host keeps its listener bound
across a relock, so a `locked` refusal is an answer the host chose to send, not
a door that happened to be shut. Reconnecting would re-ask a question that was
answered - the host would answer it the same way for as long as the vault stays
locked - and it would hide the honest exit code (7) from the supervising client
behind a loop. The user unlocks Vex and starts the bridge again; the client is
the thing that decides to reconnect, not the bridge.

The only future reconsideration on the record is ONE bounded pre-handshake retry
for ENOENT/ECONNREFUSED - never after an ack, and never for `locked`,
`malformed`, `at_capacity` or a version refusal.

### 3.5 The relay's shutdown state machine, asymmetric on purpose

| event | the bridge does |
| --- | --- |
| stdin EOF | half-close the write side if the transport can (`UnixConn.CloseWrite`), so the host sees a clean FIN, then DRAIN socket-to-stdout under the 5000 ms bound, then exit 0. Responses to already-sent requests are still in flight, and cutting the drain would look to the client like the host answered nothing. On a transport with NO half-close the drain runs under the SAME bound and the connection is then closed fully; the outcome records which of the two happened, so a bound that elapsed is never reported as a clean close |
| socket EOF | close stdout and RETURN WITHOUT WAITING for the stdin reader, which is parked in a read nothing will complete. Waiting there is a hang |
| stdout failure, socket failure, or a signal | tear down through ONE owner, which closes the connection exactly once no matter which fired first |

A goroutine left blocked on a read or write that no longer matters is abandoned
deliberately: its only remaining owner is process exit, and the alternative is a
teardown that waits for the very thing that is stuck.

WINDOWS DIALS THE PIPE OVERLAPPED, in pure stdlib: `syscall.CreateFile` on the
pipe name with `FILE_FLAG_OVERLAPPED`, handed to `os.NewFile`. It lives in the
build-tagged `bridge/cmd/vex-mcp/dial_windows.go`; `net` has no named-pipe
network and none is needed.

OVERLAPPED IS A REQUIREMENT, not a preference. `os.OpenFile(path, os.O_RDWR,
0)` is CreateFile WITHOUT that flag, which yields a SYNCHRONOUS handle: the
Windows I/O manager serializes every operation on it, so a pending read blocks
the next write on the same handle - and the relay reads and writes
concurrently from two goroutines, which is exactly the pattern a synchronous
handle deadlocks. Microsoft, on `CreateFileW`'s `FILE_FLAG_OVERLAPPED`: "the
file or device is being opened or created for asynchronous I/O ... operations
being performed on the file or device can complete concurrently"
(`learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew`).

`os.NewFile` is the supported hand-off in go1.27, verified against the
installed toolchain source rather than remembered: `os/file_windows.go`'s
`newFile` calls `internal/syscall/windows.IsNonblock`, which asks
`NtQueryInformationFile` for `FileModeInformation` and reports true when
neither `FILE_SYNCHRONOUS_IO_ALERT` nor `FILE_SYNCHRONOUS_IO_NONALERT` is set -
what `FILE_FLAG_OVERLAPPED` produces - and passes that as `pollable` to
`internal/poll.FD.Init`, which associates the handle with the runtime poller
("It is safe to add overlapped handles that also perform I/O outside of the
runtime poller"). `internal/poll.setDeadlineImpl` returns `ErrNoDeadline` only
when `pd.runtimeCtx == 0`, so a handle taken by the poller honours
`SetDeadline`.

This dial is UNREACHABLE at runtime while the section 1.6 gate is closed. The
`bridge-windows` CI job compiles it; matrix items 5 and 6 are what prove it.

Three differences follow from the transport, and all three are behaviour a
reader has to know about:

- NO HALF-CLOSE. A pipe has no FIN; closing the handle closes both directions
  and would discard answers still in flight. So on stdin EOF the Windows arm
  drains under the SAME 5000 ms bound and then closes fully. The seam is
  `halfCloseOrDeadline`, which keeps the unix arm on a true half-close, and the
  relay reports which path it took so the user gets the honest sentence.
- NO CONNECT BOUND. `CreateFile` takes no timeout and stdlib exposes no
  `WaitNamedPipe`, so a pipe that exists but is saturated blocks in the open
  rather than failing at `bridgeDialTimeoutMs`. The bound is enforced on unix
  only. THIS OMISSION STANDS, and it is named here rather than left as a silent
  gap; overlapped I/O does not close it, because the flag governs operations on
  an open handle and not the open itself.
- THE ACK DEADLINE HAS A FALLBACK. `Perform` sets a real deadline and, if the
  transport answers `os.ErrNoDeadline`, enforces `bridgeAckDeadlineMs` by
  CLOSING the handle when it elapses. An overlapped handle is expected to take
  the real deadline (see the `setDeadlineImpl` evidence above), and the closing
  fallback remains for any handle the poller declines. A host that accepts and
  never answers must not hang the bridge forever either way.

None of the three is proven from a Linux runner. They are matrix items 5 and 6
of the section 1.6 gate.

---

## 4. Teardown causes

The cause a blocked call reports is a TRUSTED, typed value set by the owner of
the teardown. It is never derived from anything the peer sent, and it is what
`approval_intents.refusal_reason` records.

| event | cause |
| --- | --- |
| MCP `notifications/cancelled` | `cancelled` |
| peer FIN, or a lost socket | `disconnect` |
| secret-session lock | `lock` |
| application quit | `vex_quit` |

The client's own `reason` string in a cancellation notification is untrusted
agent text, and it is never read, never logged and never stored.

The classification is POSITIVE and it tests exactly one thing: is the abort
reason the SDK's own `SdkError` carrying `SdkErrorCode.ConnectionClosed`? That
error is raised by the transport teardown alone, so it is the one abort the
OWNER is entitled to name, and its cause comes from the host through
`cancelCause` - `disconnect`, `lock` or `vex_quit`.

Everything else on that signal came from `_oncancel`, which passes
`notification.params.reason` straight to `abort()`. That parameter is OPTIONAL,
so a client that cancels without a reason aborts with `undefined`; identifying a
client cancellation by "the reason is a string" would therefore have missed it
and named it a disconnect. Every non-ConnectionClosed abort, `undefined`
included, is `cancelled`.

A transport-produced error carries a CLOSED code and nothing else
(`invalid_json`, `line_too_long`, `queue_overflow`, `socket_error`,
`sdk_wire_error`). Parser text and payload bytes are peer-controlled, so they
never travel into an `Error` the host logs; the log line carries the code and,
for an over-long line, the byte count.

### 4.1 Lock order, and what a lock does NOT close

THE LISTENER AND THE DOOR ARE TWO OWNERS. The listener is bound once at
app-ready, as soon as the host's executor is configured, and it is independent
of the vault and of the settlement readiness barrier. ADMISSION - may what
arrives on that socket be served - is what a lock closes. Only application quit
closes the listener.

The trade this replaces was worse for the bridge and for the user: while a lock
closed the listener, "Vex is locked" reached a bridge as the same
`ECONNREFUSED` that also means "Vex is not installed" and "Vex is still
starting", so the only honest sentence a bridge could print covered three
unrelated causes.

A LOCKED OR UNREADY HOST ANSWERS BEFORE IT READS. The connection is accepted, a
typed refusal is written, and the host closes the connection:

- the refusal code is `locked`, which is ALREADY in the closed set of section
  2.2 ("Vex is locked, still starting, or shutting down"), so this is not a
  protocol change and a v1 bridge already switches on it (exit code 7);
- NO project bytes are read. The host does not parse a handshake line, so no
  project identifier crosses the wire in either direction and the refusal
  carries none;
- NO established-connection reservation is taken and no handshake-pending slot
  is held, so a flood of connects against a locked Vex can consume only the raw
  listener bound of section 3 and never the bounds a real bridge needs;
- NO idle connection is retained. The host does not hold an open socket for a
  peer it has refused.

`lockSecretSession` runs, in this order:

1. the synchronous scrub and signing revocation, unchanged and FIRST;
2. `lockStudioMcpHost()` - close ADMISSION (which advances the lifecycle epoch,
   so every start and every in-progress connection establish is fenced) and
   destroy every established and handshaking connection with the trusted cause,
   SYNCHRONOUSLY. The listener and its endpoint SURVIVE, and their identity does
   not change: an unlock serves again over the same bound socket, with no
   rebind and no new address for a bridge to discover;
3. the existing provider reset, dispatch-generation advance and durable
   refusal pass.

Step 2 is synchronous because the generation advance in step 3 must not queue
behind network teardown: the advance is the fence that stops a queued action
from dispatching, and a fence delayed behind a peer's FIN is a fence that is
down for as long as that peer is slow. Per-connection EOF refusals are never
awaited before the advance.

UNLOCK IS NOT THE MIRROR OF LOCK. Admission opens only after the unlock's own
dispatch-generation advance has committed, its dispatch poison is clear, and
its pending durable refusal has been written. A vault that is unlocked while
those are outstanding is `unready`, not `ready`, and it refuses exactly the way
a locked host does.

READINESS GATES ADMISSION, NOT THE BIND. The settlement readiness barrier
refuses handshakes and calls; it never decides whether a socket exists. A host
that binds while the barrier is still closed, and whose barrier then opens
through the barrier's own retry path, starts serving with no second unlock and
no listener restart.

Quit runs listener, then connections, then the existing Studio teardown, inside
the ordered quit task so it happens before Compose stops Postgres.

#### 4.1.1 The Windows front-relayed transport, WHEN it lands (B4.2b)

CONDITIONAL, and it describes nothing that exists today. Wave 1 speaks to the
host over a DIRECT socket on every platform, and the Windows named-pipe
transport remains gated by section 1.6. The paragraph exists so the lock
invariant above is not later weakened silently to fit a transport whose handles
main does not own.

When the Windows transport is served through a front relay, main can no longer
destroy the peer's handle itself, and claiming synchronous remote destruction
would be false. The invariant is therefore LOGICAL-SYNC PLUS BOUNDED-PHYSICAL:

- SYNCHRONOUS AND LOGICAL, in main, in the tick the lock is decided: admission
  is closed, the epoch is advanced, the trusted cause is latched on every
  logical connection, every host-side handler is aborted, and every frame that
  arrives from the front under a stale epoch is discarded. Nothing a peer can
  do after this tick reaches a tool.
- A PRIORITY LOCK FRAME to the front, ahead of any queued traffic.
- A BOUNDED PHYSICAL CLOSE: the front closes the real handles and acknowledges
  within a stated deadline. If the control frame cannot be admitted immediately,
  or the acknowledgement does not arrive within the deadline, main KILLS the
  front process and restarts it LOCKED. A front that cannot be commanded is
  never left holding live handles.
- FAIL CLOSED ON CONTROL-CHANNEL LOSS: a lost control channel defaults to
  closing, never to optimistic admission. B4.2b owes a test for exactly this,
  and it is a test obligation of that stage rather than something wave 1 can
  fake with a direct socket.

---

## 5. Changing this contract

The version in the handshake is a MAJOR. Anything that changes what a v1 bridge
observes - a new bound that refuses traffic v1 allowed, a changed ack shape, a
different derivation - is a v2 and ships with both sides updated and the
`incompatible_version` path exercised.

Additive and compatible: a new refusal code (a v1 bridge prints the message and
exits non-zero, which is already the contract), a new optional field a v1
bridge ignores, a bound that is RAISED.

Regenerate `bridge-endpoint-vectors.json` deliberately in the same change, and
review it as the wire artifact it is.
