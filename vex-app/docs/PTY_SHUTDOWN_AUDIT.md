# PTY shutdown settlement audit

## Evidence

Both Windows jobs failed in cleanup with `EBUSY` removing a
`vex-realpty-work-*` directory:

- [Job 102114875908](https://github.com/Vex-Foundation/Vex/actions/jobs/102114875908):
  the slow-consumer test, with 11,567 other tests passing. Its pause assertion
  did not fail. Cleanup spent about 5,007 ms in `shutdownAll`, then reported
  zero surviving shell PIDs before directory removal failed.
- [Job 102062382075](https://github.com/Vex-Foundation/Vex/actions/jobs/102062382075):
  the continuous snapshot producer. Its failure was directory removal, not
  the snapshot assertion. The scoped rerun passed this case in 5,296 ms.

The logs do not identify the process or handle holding the directory.

`PtyHostService.runShutdown` limits the terminal phase to 5,000 ms.
`TerminalProcess.beginGracefulShutdown` previously spent that same 5,000 ms
before issuing a forced kill when output kept resetting the quiet-period
timer. The host could therefore dispose the terminal at the moment of kill,
removing the native exit listener and resolving the lifecycle promises before
the native exit. The existing 3,000 ms settlement window was bypassed.

The process now reserves that settlement window inside the unchanged total
budget. The host watchdog remains for a pty or final cwd probe that never
settles. No timeout value was increased.

## Reference comparison

Read from the local VS Code checkout:

- `src/vs/platform/terminal/node/terminalProcess.ts`: data accounting,
  pause/resume, exit debounce, forced shutdown and Windows handling.
- `src/vs/platform/terminal/common/terminal.ts`: high/low watermarks.
- `src/vs/platform/terminal/test/node/ptyHostService.test.ts`: listener ownership
  across host restarts. A search of the requested terminal test subtree found
  no real-process Windows teardown test to adopt.

Adopted: synchronous producer-side character accounting with hysteresis,
trailing-output debounce, bounded shutdown, and retained exit subscriptions.
The production flow-control decision already follows these patterns and needs
no new transition API for the supplied failures.

Rejected: treating VS Code's kill-then-announce sequence as proof of native
settlement, or using its fixed Windows kill/spawn throttle to prove a race.
Vex releases terminal ownership on completion, which requires observing exit.

The installed `node-pty@1.2.0-beta.15` emits Windows `onExit` from the ConPTY
output socket's close handler. Its console descendant termination also has
asynchronous work. A root PID disappearing is therefore insufficient evidence
for removing the fixture directory. The real-process fixture now records
native exits at spawn, including the Windows canary, and awaits those exits
in addition to its independent PID leak detector before removal.

## Verification boundary

`shutdown-settlement.test.ts` keeps two native exits under explicit control
while continuous output forces a kill. It fails against the original code
because shutdown has already completed before either exit. It also checks that
a missing exit still respects the existing total shutdown bound.

The slow-consumer integration test gates production on completed replay, holds
real parser acknowledgements, checks stopped output after delivery drains, and
requires new output after releasing the acknowledgements. Its existing
500 ms absence interval remains; it is not the sole proof of ordering.

Linux exercises a real POSIX pty only. Windows CI must prove that native exit
plus PID disappearance precedes successful directory removal for these
ConPTY workloads, including its asynchronous descendant cleanup. The logs and
Linux tests alone cannot prove which Windows handle held the directory.

## Hard main-process death and project cleanup (2026-09-09)

The owner's Windows measurements identified two orphaned utility processes,
one from September 4 and one from September 8. Their main processes had died;
a surviving cmd.exe held the deleted project's directory as its cwd. Every
file could be opened exclusively, but the directory could not be renamed.
Killing the orphan trees released it. Neither folder size, path length nor
Recycle Bin configuration explained this incident.

The orderly main-side `PtyHostStarter.dispose` ladder remains primary.
`pty-host/parent-lifetime.ts` adds a child-side existence check at the existing
5,000 ms heartbeat cadence. Main passes its PID and the exact
`--vex-pty-host` marker in both fork arguments and `execArgv`. Electron 42 sends
regular arguments over Mojo; `execArgv` also reaches the OS command line.
Only the utility host receives this marker. No shell environment carries it.

On parent loss the host closes admission, disposes every owned terminal and
exits. This path deliberately skips snapshot capture so disk work cannot delay
termination. The normal shutdown still captures snapshots first. Windows
terminal termination runs System32/taskkill.exe with `/PID <shell> /T /F`
through `platform/process-lifetime.ts`, then releases the node-pty adapter.
The synchronous platform seam ensures disposal cannot abandon an in-flight
taskkill command. Taskkill has a 3,000 ms deadline per tree. Other platforms
retain node-pty termination. A native exit suppresses a later tree kill against
a possibly reused PID, while retaining adapter cleanup.

At app startup, before runtime initialization and project repair, the Windows
reaper selects only the same executable path, the exact host marker, matching
recorded parent PID, a known creation time and a parent absent from both the
process snapshot and the existence probe. It re-enumerates and checks creation
time before killing each host tree. It logs reaped PIDs, count and ages.
It never selects an unmarked process or a foreign Electron installation.

### Runtime evidence and reference decisions

Read the prescribed VS Code utilityProcess.ts `createEnv`, bootstrap-fork.ts
parent watcher, ipc.cp.ts fork environment, processes.ts `killTree`,
ptyHostMain.ts service composition, ptyService.ts terminal ownership and
shutdown, and terminal/test/node/ptyHostService.test.ts listener-lifetime test.
Adopted parent identity, periodic existence checks, explicit process-tree
termination and one terminal registry owner. Rejected exiting before killing
owned terminals, interpreting every probe error as death, and using node-pty's
Windows root kill as sufficient evidence that descendants died. EPERM is not
proof of a dead parent; only ESRCH is.

[Node's process documentation](https://nodejs.org/api/process.html#signal-events)
explicitly describes signal 0 as a platform-independent existence check,
including Windows. It sends no terminating signal. Windows process-group
signalling is unsupported, which is why taskkill owns tree termination.

Read the installed electron@42.0.0 ParentPort typings and the
[ParentPort documentation](https://www.electronjs.org/docs/latest/api/parent-port).
Only `message` is documented. Also inspected Electron v42.0.0
[shell/browser/api/electron_api_utility_process.cc](https://github.com/electron/electron/blob/v42.0.0/shell/browser/api/electron_api_utility_process.cc),
[shell/services/node/node_service.cc](https://github.com/electron/electron/blob/v42.0.0/shell/services/node/node_service.cc),
[shell/services/node/parent_port.cc](https://github.com/electron/electron/blob/v42.0.0/shell/services/node/parent_port.cc),
[shell/common/node_bindings.cc](https://github.com/electron/electron/blob/v42.0.0/shell/common/node_bindings.cc)
and [lib/utility/init.ts](https://github.com/electron/electron/blob/v42.0.0/lib/utility/init.ts).
The native disconnect closes the port without emitting a JavaScript close or
disconnect event. The JS initializer starts the native port when the first
message listener is added. Removed the redundant manual optional start call.
The installed Electron runtime was probed on Linux: both argv arrays and the
OS command line contained the marker and parent PID when `execArgv` was supplied.
The installed node-pty Windows conout reader creates a worker thread, not a
child process. A second installed-Electron probe confirmed that a worker can
start with these inherited exec arguments and remains in the host process.

### Trash diagnosis, authority and compensation

An aborted local Windows trash operation now tries a sibling rename and
restores the original name. A sharing violation reports `busy`; a successful
round trip reports `aborted`. A restore failure records `restore_failed` with
both complete paths. Subsequent retries detect the recovery directory before
interpreting a missing original as success. Recovery requires restoring that
folder manually; the application never silently chooses a new project path.

A busy failure asks the live host about its terminal cwds, and inspects only
descendants of positively identified orphan hosts. Windows orphan cwd lookup
reads a 64-bit PEB through a read-only process handle and closes that handle on
every path. Unsupported WOW64 processes and unreadable cwds remain unknown.
[Microsoft documents PEB as an internal, changeable structure](https://learn.microsoft.com/en-us/windows/win32/api/winternl/ns-winternl-peb);
this diagnostic requires Windows verification and fails closed if the memory
read cannot be completed. The resolver has a 15-second total deadline.

The holder DTO identifies a live Vex terminal, a previous-session Vex terminal,
or an external holder. Unknown external PIDs are not invented. A project's
name and ID accompany a live terminal when known. Complete folder and recovery
paths are display diagnostics only. Native errors and command lines are not
returned to the renderer. Legacy reason-only tombstones remain readable;
structured failures are stored in the existing text column. No migration is
needed. An older build cannot display the richer cause, but retains and retries
the obligation.

| Authority | Source | Revalidation and effect |
| --- | --- | --- |
| Deleted project and original trash intent | Tombstone transaction | A retry cannot change the recorded folder choice |
| Cleanup directory | Configured root and stored slug | Resolve and confine to a direct root child |
| Live terminal ownership | Host registry and current known cwd | Host performs the folder query and termination |
| Orphan ownership | Own binary, marker, dead parent, creation time | Re-enumerate host and shell, check ancestry and cwd before taskkill |
| User close intent | Strict existing delete input, `closeHolders` | Renderer supplies no PID, path or process-kind authority |
| Cancellation | Existing request ID and cancellation gate | Stop before holder termination; already-issued termination cannot be undone |
| Completion and attempts | Existing cleanup owner | One retry, fifth failure remains pending, success marks the same tombstone done |

Both host requests and replies use strict shared schemas. The existing delete
channel, main sender/subframe gate and safe Result contract remain the sole
renderer operation. `projects.deleteAbortable` exposes its cancellation through
preload, and the renderer adapter cancels on request or unmount. Pending reads
refresh holder observations so saved PIDs cannot authorize a kill or silently
masquerade as a fresh process observation.

### Rail presentation

Read deepseek-harness ConnectionBanner, Pill, DisclosureRow and HoverCard,
including each module stylesheet. Adopted the compact disclosure header,
semantic state dot, quiet secondary copy and keyboard disclosure. Used Vex's
DisclosureRow, StateDot, Button and surface tokens. Rejected a center-column
banner and a hover-only remediation action: neither fits a durable,
keyboard-accessible cleanup obligation. Long summary names remain reachable
through horizontal scrolling, and detail paths wrap without cutting text.

The notice is mounted below the Projects list in StudioSidebar, including the
empty-project state. The center no longer mounts it. In the collapsed rail the
named status button expands the rail. Details include cause, folder, known
holder, attempt count and Retry or Close it and retry. The section retains its
accessible name and each pending project is a status region.

### Compatibility limits and verification contract

Already-running hosts from builds before this marker cannot be identified
under the required selection rule. They require the coordinator's measured,
PID-specific one-time cleanup. Process name alone is never a fallback.
The startup reaper is Windows-only. POSIX hosts receive the parent watchdog;
a portable startup reaper needs a separate identity/ancestry adapter because
POSIX reparents orphans instead of retaining Windows' historical parent PID.

A healthy marked orphan present before startup is automatically reaped and its
cleanup can finish before any notice appears. Therefore the rail remediation
test must introduce an orphan after startup, or exercise an orphan the startup
reaper could not terminate. Expecting both successful automatic reaping and a
persistent holder row for that same process is contradictory.

The five-second check is the first coordinator observation, not a strict
worst-case deadline: death immediately after a poll can consume the entire
5,000 ms cadence before Windows tree termination starts. Native taskkill
latency and an unresponsive utility event loop remain platform limits. The
startup reaper covers a host whose event loop cannot run its watchdog.
