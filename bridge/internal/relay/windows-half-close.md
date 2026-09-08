# Windows AF_UNIX half-close investigation

Evidence collected on 2026-09-08 against `c8ebc5cb2`, Go 1.27.0.

The evidence supports a Windows test-fixture ordering correction. It does
not establish a production relay defect or conclusively identify the stalled
operation in the old Windows failures. Native confirmation is still required.

## CI evidence

Job metadata was obtained with `gh run view <run> --repo
Vex-Foundation/Vex --json jobs` and the run-attempt jobs API. Full logs were
read with `gh api repos/Vex-Foundation/Vex/actions/jobs/<job>/logs`.

| Run / revision | Attempt | Windows job | Relay result |
| --- | --- | --- | --- |
| 34217907473 / main 279a3f393 | 1 | [102034038969](https://github.com/Vex-Foundation/Vex/actions/runs/34217907473/job/102034038969) | PASS, 1.975s |
| 34239025030 / main b3ff96641 | 1 | [102104107441](https://github.com/Vex-Foundation/Vex/actions/runs/34239025030/job/102104107441) | PASS, 1.989s |
| 34242115590 / main c8ebc5cb2 | 1 | [102114875658](https://github.com/Vex-Foundation/Vex/actions/runs/34242115590/job/102114875658) | PASS, 1.995s |
| 34250957989 / PTY PR 1ac055aad | 1 | [102144954059](https://github.com/Vex-Foundation/Vex/actions/runs/34250957989/job/102144954059) | PASS, 1.995s; job failed in front/control |
| 34250957989 / PTY PR 1ac055aad | 2 | [102158657854](https://github.com/Vex-Foundation/Vex/actions/runs/34250957989/job/102158657854) | Half-close test FAIL at 3.00s |
| 34250957989 / PTY PR 1ac055aad | 3 | [102160088140](https://github.com/Vex-Foundation/Vex/actions/runs/34250957989/job/102160088140) | PASS, 1.999s |
| 34251145331 / macOS PR 106cdde5f | 1 | [102145590091](https://github.com/Vex-Foundation/Vex/actions/runs/34251145331/job/102145590091) | Half-close test FAIL at 3.00s |
| 34251145331 / macOS PR 106cdde5f | 2 | [102158647643](https://github.com/Vex-Foundation/Vex/actions/runs/34251145331/job/102158647643) | PASS, 2.012s |

The PTY PR's first failure was `TestLockDuringPausedReadAndPendingWrite`
timing out after ten minutes. It was not a half-close failure. Main c8's
attempt 2 job 102129349036 has identical log bytes and timestamps to attempt
1; it is a carried-forward result, not another independent execution.

Every inspected job reports Windows Server 2025 `10.0.26100`, image
`windows-2025-vs2026` version `20260824.214.3`, runner `2.337.0`, and
`go1.27.0 windows/amd64`. There is no observed image or toolchain change.
All five revisions have bridge tree object
`4411fd0833e1f392ba84f8706a11fc1d7d36bc89` and identical `bridge-windows`
workflow blocks. The workflow uses `windows-latest`, pinned setup-go
`b7ad1dad31e06c5925ef5d2fc7ad053ef454303e`, exact version `1.27.0`,
`check-latest: false`, `cache: false`, and `GOTOOLCHAIN=local`.

The command is `go test -race ./...`, with empty `GOFLAGS` and no package
parallelism override. Go defaults `-p` to `GOMAXPROCS`, so package processes
can compete for CPU. GitHub documents four CPUs for this public repository's
[standard Windows runner](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job).
The logs do not measure actual CPU count, GOMAXPROCS, or utilization. They
establish intermittent package failure, not load causation. Old passing
package output also cannot exclude a hidden `socketPair` listen skip.

## Owner and platform contract

The installed Go source traces `net.UnixConn.CloseWrite` through
`netFD.closeWrite`, `poll.FD.Shutdown`, and `syscall.Shutdown` to Winsock
`shutdown(SHUT_WR)`. See `net/unixsock.go`, `net/fd_posix.go`,
`internal/poll/fd_posix.go`, and `syscall/syscall_windows.go`.
Shutdown takes an FD reference, not a read/write lock. Network reads and
writes in `internal/poll/fd_windows.go` use separate locks and overlapped
Winsock operations. No Go-level locking cycle was found in this path.

[Go issue 73140](https://github.com/golang/go/issues/73140) records Windows
`TestCloseWrite/unix` hangs. The merged
[Go change 671457](https://go-review.googlesource.com/c/go/+/671457)
adds a test-only delay before the peer read. The installed Go 1.27
`net/net_test.go:100` retains that workaround for concurrent peer read and
shutdown. This is direct evidence of a fixture hazard matching this test,
but it is not a trace of the Vex failures.

`relay.Run` copies stdin, calls `CloseWrite`, then starts its five-second
drain timer. The fixture's three-second EOF wait is a test liveness bound,
not the production drain contract. Old logs do not say whether stdin copy,
shutdown, or peer read stalled. Source alone cannot prove that this Windows
image delivered peer EOF or reached the half-close arm within three seconds.

Production Windows endpoint derivation and override validation select named
pipes exclusively (`internal/endpoint/endpoint.go`). The bridge dial returns
`*os.File`, without `CloseWrite`; stdin EOF therefore starts the bounded drain
with `HalfClosed=false`. Its native silent-host test is
`TestPipeDrainDeadlineFiresOnASilentHost` in `cmd/vex-mcp/dial_windows_test.go`.
The separate pipe front requires go-winio message-mode connections and tests
their emulated half-close in
`TestMessageModeHalfCloseGivesEOFAndKeepsTheOtherDirectionOpen`.
Neither path relies on Winsock AF_UNIX shutdown. A generic caller supplying
a Windows UnixConn still depends on that OS behavior. If CloseWrite returns
but EOF is not observable, the existing drain deadline bounds the wait;
a blocked CloseWrite would precede that timer and needs native evidence.

## Change and reference decisions

Both real-socket half-close tests now observe the actual delegating
`CloseWrite` call. Windows waits for that call to return before the peer
reads the small request. Linux retains the concurrent read. Neither the
three-second EOF bound nor the five-second drain/result bounds changed.
The tests require exact request bytes and clean EOF, successful half-close,
and response draining. The focused unix-arm test now checks the exact reply.
Windows listen failure is fatal, so a green package cannot hide unavailable
AF_UNIX behind the old sandbox skip. Diagnostics identify whether CloseWrite
was never entered, is still running, or returned, and log CPU/toolchain data.

Read before designing: the local Microsoft go-winio reference `pipe.go` and
`pipe_test.go`, the bridge dial, listener and front relay modules, and their
native transport tests. Adopted patterns: explicit transport capability,
real peer EOF checks, and preserving the opposite direction after half-close.
Rejected patterns: message-pipe Flush/zero-byte-message signaling for AF_UNIX,
replacing the bridge's client transport, an arbitrary sleep, a platform skip,
and a longer timeout. The Windows ordering follows Go's test workaround with
an explicit synchronization event instead of a scheduling guess.

## Verification and remaining proof

All local Go commands used `/tmp/vex-go-1.27.0/go/bin` first in PATH and
`GOCACHE=/tmp/vex-bridge-halfclose-cache`; full checks used `GOTOOLCHAIN=local`.
The initial default-cache command could not start because the default cache
is read-only.

| Check | Result |
| --- | --- |
| Original `go test -race ./internal/relay/ -run TestUnixArmStillReportsARealHalfClose -count=20` | PASS, 1.056s |
| Both modified half-close tests, `-race -count=20` | PASS, 4.152s |
| Windows ordering forced in a temporary copy on Linux, both tests `-race -count=20` | PASS, 4.149s; synchronization check only |
| `go vet ./...` | PASS |
| Three consecutive full race runs | FAIL only in the same two read-only runtime-directory binds; all other packages passed |
| `pnpm run test:bridge` | Same two filesystem failures |
| `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/bridge-halfclose-verification/relay.test.exe ./internal/relay` | PASS; compile only |
| `pnpm run check:em-dash` | PASS |

Full race run 1 used `go test -race ./...`; runs 2 and 3 used
`go test -race -count=1 ./...` to prevent cache reuse. The failing tests were
`TestScrubbedEnvironmentDialsTheEndpointTheAppBinds` and
`TestScrubbedEnvironmentMeetsTheAppUnderACustomXDGRuntimeDir`. Both attempt
to bind under the sandbox's read-only `/run/user/1000`. No assertion,
platform branch, race check, or timeout was weakened to bypass that failure.
There is no bridge Makefile; `test:bridge` is the root test wrapper.

In a temporary copy, removing the relay's actual CloseWrite call while
retaining its successful return made the focused test fail after 3.01s:
`the peer never saw the half-close; relay has not entered CloseWrite`.
This proves detection of missing half-close. It is not red-on-revert proof
of the Windows fixture correction. The original Linux test passed all 20
runs, and this environment has no native Windows executor, so that specific
reproducer and the exact historical root cause remain unproven.

Native validation must run the focused tests with `-race -count=20 -v`,
then the normal full `bridge-windows` job. Compare original and corrected
fixtures on the same image, retaining phase diagnostics on the original
ordering to establish which operation stalls. Only those runs can prove
Windows EOF delivery, the three-second half-close trace, and whether this
ordering removes the intermittent failure. Load dependence requires a
controlled comparison of default package concurrency and `-p=1`; current
logs do not settle it. Linux full-suite readiness additionally needs a
writable private runtime directory in the test environment.
