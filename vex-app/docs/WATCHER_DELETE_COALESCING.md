# Directory deletion coalescing

The watcher reports a completed directory deletion as the highest ancestor
already missing on disk below the watched root. It suppresses child changes
and duplicate delete notifications across drained aggregation windows.

## Evidence

The manifest permits `@parcel/watcher ~2.6.0`; the installed package is 2.6.0.
Its shipped `src/macos/FSEventsBackend.cc` requests file events with 1 ms
latency, handles only reported paths and uses current filesystem state to
disambiguate combined flags. It explicitly cannot reconstruct exact
create/delete history. `src/Debounce.cc` delivers the first event after idle
separately from subsequent events. `src/Event.hh` also annihilates combined
create/delete entries. These mechanisms provide neither a complete recursive
operation batch nor parent-first delivery across callbacks.

The logs show incomplete application output, not raw native callbacks:

- [Job 102086216647](https://github.com/Vex-Foundation/Vex/actions/runs/34233738105/job/102086216647)
  times out waiting for `tree` after receiving only `tree/inner/leaf.txt`.
- [Main job 102129347081](https://github.com/Vex-Foundation/Vex/actions/runs/34242115590/job/102129347081),
  at `c8ebc5cb23ac5445af68ff6d5970fc1aa9bf660d`, fails with the same leaf-only output.
- Supplied job 102114876097 fails downloading Electron with HTTP 500 before
  the tests run. It is not evidence of a watcher failure.

The logs cannot distinguish omitted events, delayed events or prior
create/delete annihilation. The owner defect is relying on the parent delete
being present in the pending map. Once that map drains, its suppression also
forgets previously reported deletions.

## Reference decisions

Read the local VS Code checkout's `src/vs/platform/files/common/watcher.ts`
(`coalesceEvents`), `node/watcher/parcel/parcelWatcher.ts`, and the relevant
deletion, recreation and lifecycle tests in `test/node/parcelWatcher.test.ts`
and `test/node/nodejsWatcher.test.ts` under the same files-platform directory.

Adopted: suppression based on path ancestry independent of arrival order,
normalization in the watcher pipeline, exact directory-delete assertions,
and owned watcher cleanup.

Rejected as a remedy: relying only on a larger aggregation window or the
reference's batch-local shortest-path-first suppression. Neither supplies an
absent parent or remembers a deletion after emission. Vex retains exact path
case and Unicode spelling, preserving its existing case-only rename contract;
the reference's platform-specific case folding and macOS NFC normalization
are not appropriate for Vex's path identity. No code was copied verbatim.

## Ownership and limits

The watcher supplies an ENOENT-only `lstat` probe; the coalescer walks parent
segments without reaching the root. Other probe failures use watcher recovery.
Synchronous probes preserve the existing bounded, ordered callback pipeline;
an asynchronous alternative would require serialization and fencing pending
state against concurrent native callbacks. The accepted cost is synchronous
metadata I/O on directory-delete paths. Results are cached only within one
aggregation call: a 30,000-child deletion sharing `tree/inner` requires two
probes. Slow filesystems can still delay the main process.

Deletion history belongs to one watcher generation and is cleared on restart,
generation change and disposal. Observed recreation invalidates relevant
history and reconciles a still-pending ancestor deletion. History is bounded
by `FILES_PENDING_CHANGES_MAX`; exhausting it requests an overflow re-list
with zero raw events dropped, then starts fresh history. Indefinite duplicate
suppression is not promised after that explicit loss of history.

The disk walk cannot predict an ancestor that still exists but will be removed
later, reconstruct unobserved delete/recreate cycles, or recover a deletion
when no usable event arrives. macOS CI must establish the native FSEvents
integration result; Linux and scripted callbacks cannot prove it.

The existing large real-FS test file gains only an exact-once assertion in its
existing deletion test. Its wait still targets `tree`, and its timeout and
settle interval are unchanged. The watcher remains one cohesive lifecycle
owner despite crossing 750 lines; extracting its new probe/state wiring would
split that ownership for little benefit. New scripted watcher tests live in a
separate file.
