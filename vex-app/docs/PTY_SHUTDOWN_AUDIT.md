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
