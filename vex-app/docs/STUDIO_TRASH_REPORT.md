# Studio trash implementation report

Implemented in `fix/studio-trash-windows`, based on `eeb1f602e`, without commits,
branch changes, stash or reset. Windows verification remains required.

## Behavior

- Main and the pty host carry the same explicit parent identity. Parent loss
  closes admission, kills owned terminals and exits the utility host.
- Windows terminal closure kills the shell tree. Startup reaps positively
  identified orphan host trees before project cleanup runs.
- A Windows aborted trash now probes directory rename capability. Locks,
  non-recyclable items and failed restoration have distinct outcomes.
- Pending cleanup identifies current Vex holders and previous-session Vex
  holders. Close it and retry revalidates ownership, terminates only owned
  holders and retries through the existing tombstone cleanup owner. Attempt
  accounting and the fifth-failure escalation are preserved.
- The notice is a compact, keyboard-accessible disclosure below Projects in
  the rail. It no longer occupies space in StudioCenter. Retry supports
  cancellation; a collapsed rail exposes a named expand control.

The lifecycle contract, authority matrix, compatibility and pattern decisions
are recorded in [PTY_SHUTDOWN_AUDIT.md](PTY_SHUTDOWN_AUDIT.md).

## Reading record

Read first from `/home/kubas/Vex`:

- `.claude/CLAUDE.md`.
- Every Markdown rule: `00-priority-evidence-and-scope`,
  `01-senior-operating-method`, `02-git-worktree-safety`,
  `03-architecture-files-reuse-and-docs`, `04-types-api-errors-and-versioning`,
  `05-async-lifecycle-performance-and-observability`,
  `06-testing-verification-and-readiness`,
  `07-security-privacy-and-dependencies`,
  `08-frontend-state-and-accessibility`,
  `09-ai-tools-prompts-and-approvals`, `10-live-provider-verification`,
  `90-vex-product-delta`, all under `.claude/rules/` with `.md` extensions.
- Root and vex-app package.json, followed by the actual worktree check and
  build scripts. Loaded Electron architecture, IPC and testing SKILL.md files.

Reference checkout reading under `/home/kubas/Vex/agents-colab`:

- `vscode/src/vs/platform/utilityProcess/electron-main/utilityProcess.ts`:
  parent-bound environment and fork; `vscode/src/bootstrap-fork.ts`: parent
  liveness watcher; `vscode/src/vs/base/parts/ipc/node/ipc.cp.ts`: parent PID
  propagation; `vscode/src/vs/base/node/processes.ts`: Windows tree kill.
- `vscode/src/vs/platform/terminal/node/ptyHostMain.ts`, the ownership and
  shutdown sections of sibling `ptyService.ts`, and
  `vscode/src/vs/platform/terminal/test/node/ptyHostService.test.ts`.
- `deepseek-harness/packages/client/ui-primitives/src/ConnectionBanner.tsx`,
  `Pill.tsx`, `DisclosureRow.tsx`, `HoverCard.tsx`, and all four module CSS files.

Adopted the parent poll and dedicated process owner, but rejected immediate
exit without terminal cleanup and treating EPERM as death. Adopted explicit
Windows tree termination instead of relying on a root PTY kill. Adopted the
compact disclosure and semantic status vocabulary, but rejected a banner in
the center and hover-only access to remediation. Vex's existing primitives and
tokens remain the visual owners. Detailed reasons and primary-source links
are in the audit.

Read all requested local lifecycle, deletion, cleanup schema, StudioCenter,
ProjectCleanupNotices and projects-rail modules and their relevant tests.
Followed their callers through the host protocol, terminal domain, tombstone
reader, IPC registration, preload and renderer adapter. Searched every
`vex-app/e2e/*.spec.ts` for `pending cleanup`, cleanup and trash. No existing
spec pinned the old notice placement; added `studio-cleanup.spec.ts` to prove
rail placement and unchanged center, terminal and dialog geometry.

Read the owner log at
`/tmp/claude-1000/-home-kubas-Vex/0a8d6421-1c2d-45bc-a92c-66fbd16d9c64/scratchpad/owner-log-2026-09-09-trash.txt`
and inspected the screenshot at
`/home/kubas/.claude/image-cache/0a8d6421-1c2d-45bc-a92c-66fbd16d9c64/44.png`.
Verified Electron 42 ParentPort typings against its docs and tagged source,
and Node's documented Windows signal-0 semantics. The additional runtime
probe established that `execArgv`, as well as ordinary fork arguments, is
necessary for an OS-visible identity marker.

## File growth and dead code

Conscious decisions for existing files above 750 lines:

| File | Before | Decision |
| --- | ---: | --- |
| `src/main/studio/terminals.ts` | 1277 | Retain the domain facade; the small folder query delegates to its existing starter and validates the reply |
| `src/pty-host/host-service.ts` | 1505 | Retain the cohesive registry/control kernel; new operations require that registry, and shared port disposal has one private owner |
| `src/pty-host/terminal-process.ts` | 1008 | Keep PID/cwd matching with the terminal; extract OS termination into the platform seam |
| `src/renderer/features/appShell/studio/sidebar/StudioSidebar.tsx` | 814 | Composition-only mount and expand callback; the notice remains a separate component |
| `src/shared/schemas/terminal.ts` | 1540 | Keep the protocol facade; put the new request/reply definitions in terminal-holders.ts |
| `src/main/studio/__tests__/project-delete-e2e.int.test.ts` | 2746 | Keep the platform-specific expected failure beside its existing database/filesystem scenario; splitting would duplicate the fixture |

Repository-wide reference searches preceded removal of the old center mount
and its import, the unused public remediation-constant export, and the manual
optional ParentPort start call. Electron starts the port when its first
message listener is registered. The remediation table remains private because
its copy helper still consumes it. The new privileged platform directory is
also rejected by the renderer/shared process-boundary check.

## Windows verification for the coordinator

Use a disposable project and the same Electron executable as the app under
test. Record the main, host and shell PIDs and their creation times before
termination. Do not select processes by name alone.

### A. Hard main-process death

1. Start the patched app, open a disposable project's terminal, and start a
   long-running child command in that terminal to exercise a descendant.
2. In a separate PowerShell window, run:

```powershell
$mainProcessId = [int](Read-Host 'PID of the Vex main process under test')
$mainProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $mainProcessId"
if ($null -eq $mainProcess) { throw 'Main process not found' }
$electronPath = $mainProcess.ExecutablePath
$before = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -eq $electronPath -and
  $_.CommandLine -match '(?:^|\s)--vex-pty-host(?:\s|$)' -and
  $_.CommandLine -match "(?:^|\s)--vex-parent-pid=$mainProcessId(?:\s|$)"
})
if ($before.Count -ne 1) { throw 'Expected exactly one identified host for this main process' }
$before | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine
& "$env:SystemRoot\System32\taskkill.exe" /PID $mainProcessId /F
Start-Sleep -Seconds 5
$survivors = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -eq $electronPath -and
  $_.CommandLine -match '(?:^|\s)--vex-pty-host(?:\s|$)' -and
  $_.CommandLine -match "(?:^|\s)--vex-parent-pid=$mainProcessId(?:\s|$)"
})
if ($survivors.Count) {
  $survivors | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine
  throw 'A host survived the five-second observation'
}
```

3. Independently confirm that the recorded shell and descendant processes
   disappeared and that the project directory can be renamed and restored.
   Do not use `/T` when killing main: that would mask the watchdog defect.
4. If the five-second observation fails, retain that result and measure when
   termination completes. The poll cadence is itself five seconds, with native
   tree-kill time additional. Do not silently convert this into a looser pass.

### B. Holder-specific rail recovery and startup reaping

Successful startup reaping removes a marked orphan before its cleanup row can
persist. Test the two outcomes separately. A pre-marker leftover cannot safely
be attributed or reaped under the required marker rule; use the already
measured PID-specific cleanup for those old binaries.

For the rail action, first start the patched app. Create a disposable project
and keep the app running. The following isolated fixture simulates an older
marked host without the new watchdog, using the exact app binary. It introduces
its orphan after startup so automatic startup reaping does not consume the
remediation scenario.

```powershell
$electronPath = Read-Host 'Exact ExecutablePath of the running Vex Electron binary'
$env:VEX_TRASH_PROBE_DIRECTORY = Read-Host 'Full folder path of the disposable project'
if (-not (Test-Path -LiteralPath $env:VEX_TRASH_PROBE_DIRECTORY -PathType Container)) {
  throw 'Project folder does not exist'
}
$fixtureDir = Join-Path $env:TEMP ('vex-trash-verification-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $fixtureDir | Out-Null
@'
const { spawn } = require('node:child_process');
const path = require('node:path');
const directory = process.argv[4];
const shell = spawn(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/k'], {
  cwd: directory, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore']
});
shell.once('spawn', () => process.parentPort.postMessage({ pid: shell.pid }));
shell.once('exit', () => process.exit(0));
shell.once('error', () => process.exit(1));
'@ | Set-Content -LiteralPath (Join-Path $fixtureDir 'orphan-child.cjs') -Encoding UTF8
@'
const { app, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const profile = path.join(__dirname, 'profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.whenReady().then(() => {
  const identity = ['--vex-pty-host', `--vex-parent-pid=${process.pid}`];
  const child = utilityProcess.fork(path.join(__dirname, 'orphan-child.cjs'),
    [...identity, process.env.VEX_TRASH_PROBE_DIRECTORY], { execArgv: identity, stdio: 'inherit' });
  child.once('message', message => {
    fs.writeFileSync(path.join(__dirname, 'pids.json'), JSON.stringify({
      main: process.pid, host: child.pid, shell: message.pid
    }));
    app.exit(0);
  });
});
'@ | Set-Content -LiteralPath (Join-Path $fixtureDir 'orphan-main.cjs') -Encoding UTF8
$fixture = Start-Process -FilePath $electronPath -ArgumentList ('"{0}"' -f (Join-Path $fixtureDir 'orphan-main.cjs')) -PassThru
if (-not $fixture.WaitForExit(15000)) { throw 'Fixture main did not exit' }
Get-Content -LiteralPath (Join-Path $fixtureDir 'pids.json')
```

1. Delete the disposable project with moving its folder to trash selected.
   Confirm it is tombstoned and the folder remains. The compact row must be
   under Projects, with no shift in the terminal or editor.
2. Expand the row using Enter or Space. Assert the sentence
   `A Vex terminal from a previous session still uses this folder. Close it and retry.`,
   the fixture shell PID and the complete folder path.
3. Click `Close it and retry`. Assert the recorded shell tree is gone, the
   folder is in the Recycle Bin, and the pending row disappears. Verify the
   tombstone cleanup state is done and the original trash choice was honored.
4. Repeat with a fresh disposable project and fixture, but restart the app
   while cleanup is pending instead of clicking the action. Assert the startup
   reaper logs the fixture host PID, count and age, no marked orphan tree
   remains, and startup cleanup resolves the tombstone without needing a row.
5. Remove the temporary fixture files after its recorded processes have exited.
   Never use a broad electron.exe or cmd.exe kill command.

## Deviations and remaining risks

- Startup reaping is Windows-only; the parent watcher is cross-platform.
  POSIX reparenting needs a separate startup identity/ancestry implementation.
- Unmarked earlier releases cannot be safely selected. Their cleanup remains
  the coordinator's measured one-time operation.
- Normal startup success and a persistent row for the same orphan are mutually
  exclusive; the procedure above exercises both outcomes separately.
- Windows PEB cwd inspection is a read-only diagnostic over an internal native
  structure. WOW64/unreadable processes stay unknown. A failed inspection does
  not offer termination from stale stored PIDs.
- Cancellation cannot undo a tree kill already issued. Before that boundary it
  prevents termination; the tombstone remains pending if cleanup was cancelled.
- Native Windows behavior is not proven by Linux tests. The exact Windows
  verification above is the remaining release gate.
- An extra full prebuild attempt copied migrations successfully, then stopped
  because the signer build requires Go 1.27.0 and Go was absent from PATH.
  No signer, dependency, package or baseline files were changed for this task.

## Files changed

- `vex-app/docs/PTY_SHUTDOWN_AUDIT.md`
- `vex-app/docs/STUDIO_TRASH_REPORT.md`
- `vex-app/e2e/studio-cleanup.spec.ts`
- `vex-app/scripts/check-process-boundaries.mjs`
- `vex-app/src/main/database/projects/pending-cleanups.ts`
- `vex-app/src/main/index.ts`
- `vex-app/src/main/ipc/__tests__/projects-ipc.test.ts`
- `vex-app/src/main/ipc/projects/pending-cleanups.ts`
- `vex-app/src/main/studio/__tests__/close-cleanup.test.ts`
- `vex-app/src/main/studio/__tests__/pending-cleanup-holders.test.ts`
- `vex-app/src/main/studio/__tests__/project-delete-e2e.int.test.ts`
- `vex-app/src/main/studio/__tests__/project-trash-holders.test.ts`
- `vex-app/src/main/studio/__tests__/pty-host-reaper.test.ts`
- `vex-app/src/main/studio/__tests__/pty-host-starter.test.ts`
- `vex-app/src/main/studio/__tests__/trash-failure.test.ts`
- `vex-app/src/main/studio/__tests__/trash-project-folder.test.ts`
- `vex-app/src/main/studio/pending-cleanup-holders.ts`
- `vex-app/src/main/studio/project-delete-runtime.ts`
- `vex-app/src/main/studio/project-delete.ts`
- `vex-app/src/main/studio/project-trash-holders.ts`
- `vex-app/src/main/studio/pty-host-reaper.ts`
- `vex-app/src/main/studio/pty-host-starter.ts`
- `vex-app/src/main/studio/terminals.ts`
- `vex-app/src/main/studio/trash-failure.ts`
- `vex-app/src/main/studio/trash-project-folder.ts`
- `vex-app/src/main/studio/windows-processes.ts`
- `vex-app/src/platform/process-lifetime.ts`
- `vex-app/src/preload/__tests__/project-cleanup-bridge.test.ts`
- `vex-app/src/preload/agent/projects.ts`
- `vex-app/src/pty-host/__tests__/parent-lifetime.test.ts`
- `vex-app/src/pty-host/__tests__/shutdown-settlement.test.ts`
- `vex-app/src/pty-host/host-service.ts`
- `vex-app/src/pty-host/index.ts`
- `vex-app/src/pty-host/parent-lifetime.ts`
- `vex-app/src/pty-host/terminal-process.ts`
- `vex-app/src/renderer/features/appShell/studio/StudioCenter.tsx`
- `vex-app/src/renderer/features/appShell/studio/projects/ProjectCleanupNotices.tsx`
- `vex-app/src/renderer/features/appShell/studio/projects/ProjectDeleteDialog.tsx`
- `vex-app/src/renderer/features/appShell/studio/projects/__tests__/ProjectCleanupNotices.test.tsx`
- `vex-app/src/renderer/features/appShell/studio/projects/__tests__/ProjectDeleteDialog.test.tsx`
- `vex-app/src/renderer/features/appShell/studio/sidebar/StudioSidebar.tsx`
- `vex-app/src/renderer/features/appShell/studio/sidebar/__tests__/StudioSidebar.test.tsx`
- `vex-app/src/renderer/lib/api/projects.ts`
- `vex-app/src/shared/schemas/project-cleanup.test.ts`
- `vex-app/src/shared/schemas/project-cleanup.ts`
- `vex-app/src/shared/schemas/projects.ts`
- `vex-app/src/shared/schemas/pty-lifetime.ts`
- `vex-app/src/shared/schemas/terminal-holders.ts`
- `vex-app/src/shared/schemas/terminal.ts`
- `vex-app/src/shared/types/bridge/agent/projects.ts`

## Verification results

From `vex-app/`:

```text
pnpm exec vitest run src/pty-host src/main/studio src/renderer/features/appShell/studio src/shared/schemas/project-cleanup.test.ts src/main/database/projects/__tests__/pending-cleanups.test.ts src/main/ipc/__tests__/projects-ipc.test.ts src/preload/__tests__
```

Passed: 164 test files, 3,133 tests. Two files and 35 tests were skipped by
existing suite gates. This includes the requested three directory scopes plus
schema, persistence-reader, IPC and preload coverage. After making the
existing trash assertion portable to Windows' richer failure shape, its focused
suite also passed all 11 tests. The dedicated Postgres `.int.test.ts` lane was
not run; its existing aborted-refusal expectation was updated for Windows.

Two earlier expanded runs encountered unchanged filesystem-watcher timing
assertions in `files-domain-races.test.ts`. An isolated rerun encountered a
sibling timing assertion. Those files and assertions were not changed or
weakened. The final complete expanded run passed them.

`pnpm run lint` passed, including shared, pty-host, worker and e2e typechecks,
the existing main/preload/renderer type ratchet and process-boundary checks.
The ratchet reported 312 known errors at or below its baseline. No baseline
or compiler configuration was modified.

```text
xvfb-run -a pnpm exec playwright test e2e/studio-cleanup.spec.ts
```

Passed the one Studio cleanup browser scenario against the built Electron app
and isolated database. It verifies the rail location, keyboard disclosure,
readable cause, Tab focus on Retry, and exact unchanged bounding boxes for the
center, terminal and open dialog. The baseline measurement waits for the
existing dialog entrance animation instead of weakening the geometry check.
The final screenshot waits for the disclosure's existing reveal animation.
A screenshot is written to the test's `cleanup-rail.png` artifact.

The first browser attempt ran before the renderer bundle existed and failed
at the shell-window prerequisite. A later attempt exposed the 8-pixel dialog
entrance transform in the baseline measurement. After building the renderer
and awaiting that animation, the scenario passed. The independent Docker CLI
probe failed in its systemd wrapper, but the repository's isolated-stack fixture
was able to start the database and run this browser test.

Direct production bundles passed:

```text
pnpm run build:main
pnpm run build:preload
pnpm run build:pty-host
VITE_VEX_SETUP_TOUR=1 pnpm run build:renderer
```

The renderer build used the repository's diagnostic tour required by the Studio
E2E fixture. Existing dynamic-import/chunk-size warnings remain. The optional
full prebuild limitation is recorded above.

Two additional installed-Electron probes ran under xvfb:

- Fork identity: child argv, execArgv and the Linux OS process command line
  all contained the exact host marker and parent PID.
- Hard-death smoke: the built production pty host created a real `/bin/sh`,
  then its Electron main was killed with SIGKILL. An independent observer found
  neither host nor shell running at 5,000 ms. The final observation recorded
  host PID 103, shell PID 156 and an empty survivor list. These are Linux
  observations, not claims about Windows ConPTY or taskkill.

From the repository root:

```text
pnpm run check:em-dash
pnpm run test:unsafe-escapes
git diff --check
```

All passed. No commits were created and HEAD remains `eeb1f602e` on
`fix/studio-trash-windows`. Readiness is conditional on the coordinator's
Windows verification, particularly native tree termination and PEB cwd lookup.
