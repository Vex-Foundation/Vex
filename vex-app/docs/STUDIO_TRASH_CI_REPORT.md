# Studio trash CI follow-up

Started from clean commit `55d0f5b5a` on `fix/studio-trash-windows` for PR #183.
This follow-up addresses CI run `34347112097`. No commits, branch changes,
stash or reset were performed.

## Changes and platform reasoning

| File | Change and reason |
| --- | --- |
| `src/main/studio/__tests__/trash-project-folder.test.ts` | Resolve the existing fixture folder before asserting Windows' detailed aborted result, and assert the trash capability receives that exact resolved path. Windows alone performs the aborted rename probe, so the existing `process.platform === "win32"` result-shape branch remains explicit. |
| Same file, recovery case | The original folder is absent, so derive its name from `await realpath(root)`. Resolve the existing recovery directory with `await realpath(recovery)` and compare the complete result exactly. This models the resolved directory supplied by the cleanup owner without trying to resolve a nonexistent original. |
| `src/main/studio/__tests__/close-cleanup.test.ts` | Capture the folder's realpath before successful cleanup removes it, then require exactly `[resolvedDirectory, true, undefined]` for the holder-closing call. The true flag and cancellation argument remain pinned. |
| `src/renderer/features/appShell/studio/projects/ProjectCleanupNotices.tsx` | Add an error-visibility prop. The query stays mounted, but its error is suppressed while the projects read is pending or has failed. Successful pending-cleanup data is unaffected. |
| `src/renderer/features/appShell/studio/sidebar/StudioSidebar.tsx` | Derive error visibility from the projects state. The existing projects Retry refetches projects and invalidates every pending-cleanup page key, which refetches the active cleanup query. |
| `src/renderer/features/appShell/studio/projects/__tests__/ProjectCleanupNotices.test.tsx` | Pin suppression for Result failures and transport rejections. When projects recover, the same still-failed cleanup query shows its own error without remounting or fetching again. |
| `src/renderer/features/appShell/studio/sidebar/__tests__/StudioSidebar.test.tsx` | Pin exactly one status and one Retry for shared failure, prove that retry reaches both reads, and prove that a cleanup-only failure retains its own retry without refetching projects. |
| `docs/STUDIO_TRASH_CI_REPORT.md` | This report. |

Windows CI uses a short `%TEMP%` path containing `RUNNER~1`; filesystem
resolution returns `runneradmin`. macOS resolves `/var/folders` through
`/private/var/folders`. Linux's ordinary `/tmp` does not expose either mismatch.
The expectations now follow the filesystem's canonical identity on every
platform. Lexical normalization, including `path.win32.normalize`, cannot
replace this filesystem resolution. No production trash or holder-path code
was changed, and no assertion was weakened or platform case skipped.

The focused rail test also caught an initial ordering case: cleanup can fail
before the projects query settles. Error visibility waits for successful
projects loading, preventing a brief cleanup error from appearing before the
shared projects failure surface.

`e2e/studio.spec.ts` is unchanged. Its non-exact Retry locator remains intact.
No query, IPC or cleanup schemas changed. Repository-wide searches confirmed
that the notice is mounted only by the sidebar and its tests. No existing code
became dead.

File-growth decision: StudioSidebar was 817 lines and its test was 1461 lines.
The production change is three net composition lines; the additional test cases
use the existing query/rail integration harness. Retained both owners rather
than splitting a shared fixture or extracting this small composition callback.

## Pre-existing watchFile warnings

The supplied macOS log at lines 2238-2253 attributes the warning to
`StudioCenter.test.tsx`, through `StudioCenter` -> `ExplorerRegistry.switchTo`
-> `ExplorerSession.activate` -> `watchProjectFiles`. Windows logs contain the
same route. It is not a cleanup-notice activation path.

At main's baseline `eeb1f602e` and the accepted commit `55d0f5b5a`, these files
have identical Git blob IDs:

| File | Blob |
| --- | --- |
| `StudioCenter.test.tsx` | `27be2c85474e6ea52512bf45b37fe0c5fc669e27` |
| `explorer/explorer-session.ts` | `fa3b898a832f9d2cc794c6a6bce4176b94ca13ad` |
| `src/renderer/lib/api/files.ts` | `003f13e47611d02dae48cfc06c7a9ea42fc900f2` |

The fixture supplies `files.list` and `files.watch`, but the API adapter calls
`files.watchFile`. The only StudioCenter change in the accepted commit removed
the cleanup notice's import and mount; its explorer activation effect did not
change.

A temporary source snapshot was made with `git archive eeb1f602e`, outside this
worktree. Its unchanged StudioCenter suite passed 28 tests locally. A separate
temporary probe using that baseline's real ExplorerRegistry and the same
fixture shape asserted the exact warning and TypeError:
`window.vex.files.watchFile is not a function`. That probe passed. This proves
the mismatch predates the rail change; the ordinary local suite need not print
the same timing-dependent console output as CI. Explorer code and those
pre-existing fixtures were left unchanged.

## Verification

From `vex-app/`:

| Command | Result |
| --- | --- |
| `pnpm exec vitest run src/main/studio src/renderer/features/appShell/studio` | Passed: 139 files, 2791 tests; 2 files and 34 tests skipped by existing gates |
| `pnpm exec vitest run src/main/studio/__tests__/trash-project-folder.test.ts src/main/studio/__tests__/close-cleanup.test.ts` with `TMPDIR` set to a symlink to a separate temporary directory | Passed: 2 files, 13 tests; exercises real temp-path indirection on Linux |
| `pnpm exec vitest run src/renderer/features/appShell/studio/projects/__tests__/ProjectCleanupNotices.test.tsx src/renderer/features/appShell/studio/sidebar/__tests__/StudioSidebar.test.tsx` | Passed: 2 files, 67 tests |
| `xvfb-run -a pnpm exec playwright test e2e/studio.spec.ts e2e/studio-cleanup.spec.ts` | Passed: both specs, 2 tests; neither spec was modified |
| `VITE_VEX_SETUP_TOUR=1 pnpm run build:renderer` | Passed; rebuilt the renderer for the browser tests |

The first focused rail run exposed the initial-query ordering case described
above. After the error-visibility correction, the focused and full suites
passed. No test assertions, timeouts or locators were loosened.

The Windows-path classification table remains active on Linux by explicitly
passing `win32`; it covers drive, extended drive, UNC and extended UNC paths.
Actual Windows 8.3 expansion and macOS `/private/var` resolution were not run
on this machine. Native CI reruns remain their confirmation; the Linux
symlink-temp run exercises the same need to derive canonical fixture identity.

`pnpm run lint` passed, including the typechecks, type ratchet and process
boundaries. The ratchet reported 312 known errors at or below the unchanged
baseline.

From the repository root, `pnpm run check:em-dash`,
`pnpm run test:unsafe-escapes`, and `git diff --check` all passed.
HEAD remains `55d0f5b5a`; the worktree contains only the six implementation/test
files listed above and this report. Ready for Windows and macOS CI reruns.
