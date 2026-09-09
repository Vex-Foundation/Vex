# Runtime sync and logging verification

Implemented in place on `fix/runtime-sync-and-logging`, based on `4e4f131e3`.
No commits, branch changes, stashes, resets, staging or history changes were made.

The final code and regression gates pass. Solana's repaired default works live here.
Robinhood's public inventory provider still refuses this machine with HTTP
403. Known holdings now refresh and publish despite incomplete discovery, and a
user-configured Blockscout proxy can replace that public route.
Windows Recycle Bin behavior still needs the owner-machine checks below.

## 1. Balance refresh, Solana and snapshot certainty

The failure was attempted, not bypassed by a scheduling gate. The Solana sync
catch returned `skipped: true` after an RPC rejection. The bundled read host,
`solana-rpc.publicnode.com`, returned HTTP 403 for native balance and both token
account programs in sequential probes. `api.mainnet-beta.solana.com` answered
all three operations with HTTP 200. The complete public owner address was found
in an existing repository fixture; no address, request URL or payload appears
in this report.

There is one Solana URL per read/broadcast role, not a failover list.
`src/vex-agent/inference/openrouter/endpoint-failover.ts` handles inference and
`src/tools/evm-chains/rpc-endpoints.ts` handles EVM. Neither is on this path.
The repaired bundled read selection and recognition of the former bundled
default live in
`src/tools/solana-ecosystem/shared/solana-transaction/connection.ts:28,46`.
Non-bundled user overrides retain precedence. No unverified alternate was added.

The original sync logger recorded `err.name`. In addition, web3.js `getBalance`
wrapped failures in a plain Error. The deadline-owned fetch seam now captures
HTTP status and runtime error codes before wrapping, and reads native balance
through `getBalanceAndContext` before unwrapping its value:
`src/tools/solana-ecosystem/balances/read-wallet-balances.ts:578,665`.
`balances/rpc-failure.ts:18` maps rate limiting, DNS, TLS, timeout, connection,
HTTP status, invalid response and RPC error codes. An independent review added
the missing local-issuer TLS code. Logs contain the class and endpoint hostname,
never the URL, key, provider body or raw cause. The infrastructure error retains
its original cause internally. Existing deadline cancellation and no-429-retry
behavior remain intact.

The Khalani fallback's scanned-but-empty Solana response cannot prove a complete
inventory. Keeping the last good rows was correct. Losing that uncertainty
before snapshot publication was not: the original `unresolvedCount` counted
in-flight transaction uncertainty only, so it said nothing about failed reads.

The revised vocabulary separates `read_failed` from `inventory_incomplete`.
`src/vex-agent/sync/local-chain-balance-sync.ts:79` previously returned before any
RPC read on a discovery refusal. It now reads seeds, pins, surviving inventory
candidates and every cached holding. On successful known-token reads it calls
`replaceKnownEvmBalancesForChain` in `src/vex-agent/db/repos/balances/write.ts:66`: one transaction
replaces only read identities, clears observed zero holdings, and preserves
unscanned rows and their timestamps. Whole-chain replacement still requires
complete discovery. RPC failure keeps the cached rows and records `read_failed`.
An inventory-only failure records `inventory_incomplete` and never defers a
snapshot, even when its reason is `http_403`.

`src/vex-agent/sync/balance-sync/read-failure-deferral.ts:5` owns
`MAX_CHAIN_READ_DEFERRAL_CYCLES = 3`. The first three consecutive failed-read
cycles defer; the fourth and every continuing failure cycle publish partial.
A durable counter hashes the sorted wallet-family/address scope, not the random
new group ID, so reordering wallets or restarting the process cannot restart
an indefinite wait. Recovery resets the count. Existing activity-generation and
transaction-lock guards still apply; the cap does not bypass those independent
consistency checks. Total Khalani provider failure is now fail-soft, preserving
cached values and recording failed chains so the cycle reaches the bounded
publication decision. Actual database failure still rejects.

| Field or state | Authority and invariant |
| --- | --- |
| Known token quantities/value | RPC plus committed scoped replacement; an inventory failure does not freeze them |
| `read_failed` | Balance reads failed; last good values and successful-read time remain |
| `inventory_incomplete` | Known balances were refreshed; new tokens may be missing |
| `stale_since` | First observation of the current issue kind; repeats preserve it, kind changes start their own interval |
| `last_success_at` | Successful known-balance read, including an inventory-incomplete cycle; initial failed reads do not infer a time from legacy rows |
| Snapshot `partial` / `unresolvedChainCount` | Stored on each wallet snapshot and group, derived from failed balance reads only |
| P&L | Null whenever either adjacent snapshot is partial; never fabricated as zero |
| Portfolio scope | Main-process inventory/session/project address allow-list, bound into every query |

Migration `154_balance_chain_read_status.sql` now records the issue kind.
`src/vex-agent/db/repos/balance-chain-read-status.ts:11` owns its writes: successful
known reads advance their timestamp even during discovery failure; repeated
failures preserve their start; complete recovery clears the issue.
Migration `155_partial_portfolio_snapshots.sql` adds partial/count columns to
snapshot rows and groups plus the durable deferral counter. It also upgrades
existing development databases that already applied the first version of 154.
The reader tolerates legacy 154 writers that know a reason but not the new
status column. Both migrations are additive and idempotent; pre-existing
snapshots default to complete with zero unresolved chains. Both packaged mirrors
were regenerated and compared byte-for-byte. New readers/writers require both
migrations. Downgrading to an old binary that ignores partial metadata would
make its P&L interpretation unsafe; retain the partial-aware reader or forward
fix instead of deleting new data.

`vex-app/src/main/database/portfolio/chain-read-status.ts` reads only the
requested wallet scope and validates the diagnostic vocabulary. The Portfolio
DTO carries `chainReadIssues`, `snapshotPartial` and
`snapshotUnresolvedChainCount`. `ChainReadWarning.tsx` differentiates:

- failed reads: stale balances, stale-since and last successful read beside the total;
- incomplete discovery: new tokens may be missing since the recorded time,
  with the actual reason such as `http_403` and the fresh known-balance timestamp;
- partial snapshot: explicit partial label and explanation that related P&L is unavailable.

An inventory refusal publishes on its first cycle. On the fourth actual read
failure, the row retains the cached amount and carries `partial: true`.
`db/repos/balances/snapshots.ts`, `aggregate.ts`, `mappers.ts`, app
`portfolio/snapshot-basis.ts`, and summary/history tool projections preserve
partial/count metadata. Partial history rows stay visible. Deltas touching a
partial row are null, including the first complete row after recovery; the
next complete pair resumes P&L. A healthy wallet subset does not inherit another
wallet's partial state. Manual refresh distinguishes failed reads as `partial`
and invalidates the data cache; discovery-only failures remain successful
refreshes with their separate warning.

This replaces the rejected unlimited-deferral decision from turn 1. The cost of
retaining explicit partial history is nullable deltas until two adjacent fresh
snapshots exist; the benefit is a portfolio and history that continue advancing.

## 2. Robinhood Chain inventory

The default operation remains `/api/v2/addresses/{address}/token-balances`
on `robinhoodchain.blockscout.com`, chain 4663. Ordinary HTTP, Electron
`net.fetch`, and the actual changed client through the app bridge all returned
HTTP 403. Independent verification reproduced the same result. There is no
measured redirect, moved path or API-key requirement. This is evidence of a
provider refusal from this machine, not proof of a global outage.

`src/tools/blockscout/client.ts:171` previously collapsed typed HTTP metadata to
`unavailable`. It now returns `http_403` or the actual named transport, timeout,
redirect, size or parse failure. `sync/local-chain-balance-sync.ts:108` carries
the provider host and reason into its warning and result. The whole-chain replacement
gate remains, while known holdings now refresh through the scoped transaction. The stronger reason also
reaches the live WalletBalances source verdict. Provider documentation and its
contract test now agree on `http_403`.

The missing user-level override is now implemented. The per-chain
`blockscoutBaseUrls` map lives beside the existing EVM RPC override maps in
`src/config/store.ts`; `src/config/chain-blockscout-overrides.ts:7` validates and
resolves it. `getBlockscoutBaseUrlForChain` in `tools/blockscout/operation.ts`
selects the override before the unchanged default. Both client and Electron
bridge use the operation builder, preserving proxy path prefixes and checking
the exact selected response scheme, host and path. Redirects remain refused.

The new override accepts HTTPS, including private hosts, or loopback HTTP only.
URL credentials, malformed URLs, public HTTP, query strings and fragments are
refused with `BLOCKSCOUT_OVERRIDE_INVALID`, without echoing the value. Logs use
only the configured hostname. Clearing the override restores the default; the
next request observes a saved change.

Repository searches found the EVM override maps had no app settings controls.
`Settings > API keys > Chain endpoints` now groups the existing local-chain RPC and new
Blockscout overrides, using strict shared schemas, validated main handlers,
typed preload methods and the existing settings layout. Other chain entries
are preserved. URL fields are masked, failed reads cannot submit empty defaults,
and validation failures are shown by name. Existing EVM override validation
semantics remain unchanged.

A real loopback HTTP server test verifies the configured prefix through the
actual client and HTTP bridge, returning HTTP 200. The public host still
returns 403. The owner's private reverse proxy has not been supplied or probed;
no claim is made that this machine verified its TLS/authentication setup.

## 3. Windows project deletion

The original dialog did show `cleanup_pending` and Retry while open. The cause
was discarded, and closing the dialog removed the only recovery surface because
ordinary project lists omit tombstones. Startup repair attempted at most three
projects per launch; its claimed sticky notice was only a log escalation.

[Electron 42 Windows source](https://raw.githubusercontent.com/electron/electron/v42.0.0/shell/common/platform_util_win.cc)
aborts when `TSF_DELETE_RECYCLE_IF_POSSIBLE` is absent (lines 100-105) and emits
the owner's exact aborted message when `GetAnyOperationsAborted` is true
(388-390). That message does not identify a busy handle versus an unsupported
Recycle Bin location. The
[shell contract](https://www.electronjs.org/docs/latest/api/shell) confirms that
trash failure rejects. The local VS Code reference's actual trash owner is
`src/vs/platform/files/electron-main/diskFileSystemProviderServer.ts:40-54`;
the cited node provider does not implement the Electron trash call.

`vex-app/src/main/studio/trash-failure.ts:4` now classifies busy, permission,
path, ambiguous aborted and observed nonlocal-volume failures without passing
native payloads or absolute paths to logs or IPC. `trash-project-folder.ts:24`
owns the existing realpath confinement and recoverable trash attempt.
`project-delete.ts:212,490,581` preserves the reason as `trash:<reason>` in the
existing cleanup error column, returns it, and reruns close hooks on explicit
cleanup resume. Retry honors the tombstone's original folder choice. There is
no permanent-delete fallback and no new automatic trash loop.

The strict, paginated `projects.pendingCleanups` read uses existing main sender
validation and the typed preload bridge. Its reader filters tombstones with
unfinished cleanup, reports pages of 50 with `nextOffset`, and refuses to relay
legacy native error text. `ProjectCleanupNotices.tsx:8`, mounted in StudioCenter,
shows durable pending cleanup after dialog close or restart, including the
relative folder label, reason, remediation and explicit Retry. The delete
dialog also shows immediate cause-specific guidance.

Vex already closes its resource hooks. Terminal shutdown has a bounded deadline,
so an outstanding OS handle is possible, as are externally owned programs.
The historical log cannot determine which applied to the owner's directory.

## 4. Logging quality

`vex-app/src/main/logger/redact.ts:19` replaces the substring heuristic with
explicit sensitive names and value-shape scrubbing. Exact numeric counters
`seeded`, `tokens`, `wallets`, `droppedAddresses`, and
`walletsWithMoneyInFlight` survive. Numeric credentials remain redacted.
Tests also cover sensitive arrays, objects, addresses, key material, auth values
and credential-bearing URLs. Safe URLs retain scheme, host and path with queries
and fragments stripped; URL credentials or credential-bearing queries redact
the entire URL before the other value-shape scrubbers run.

The engine had a stderr transport while the embedding bridge forwarded the
same event to Electron's console. `src/utils/logger.ts:8` and
`vex-app/src/main/agent/engine-log-bridge.ts:98` now give the app ownership of
forwarded error/warn/info console and file emissions. Standalone engine stderr
and unforwarded debug output remain. Bridge teardown restores stderr.
Existing packaged warn-and-above file retention is unchanged.

`src/utils/transition-log.ts:17` owns a timer-free, bounded 256-entry LRU with
first/change emission and reminders no more frequently than five minutes.
Each emission carries the number suppressed since the previous one. Recovery
emits its accumulated count and rearms recurrence. The two chain warning owners
and `sync/pools-attribution.ts:206` use it. A twelve-hour simulated incident at
30-second observation intervals produces 145 lines, with all 1,441 occurrences
accounted for by emitted plus suppressed counts.

`sync/agentscan-report/lighter-capability.ts:137,208` also fixes the actual
cadence defect: repeated source configuration reset the refresh timestamp every
reporting tick. Same-server rewiring now preserves cadence; server or
registration-generation changes still trigger immediate refresh.

## Verification and regression proof

No test assertions, time limits, compiler settings or baselines were weakened.
Snapshot tests that previously used failed-reader no-op mocks now arrange
successful reads for their publication scenarios; explicit outage cases prove
the opposite outcome. New database I/O is mocked only in existing orchestration
unit suites, and is exercised against real PostgreSQL separately.

| Check | Result |
| --- | --- |
| `pnpm exec tsc --noEmit -p tsconfig.json` | Passed, including final source |
| Root sync, Solana, balance reader, Blockscout, balances repositories, config and consumer suites, command below | 132 files passed, 1 existing gated file skipped; 1,856 tests passed, 1 skipped |
| `vex-app/`: `pnpm run lint` | Passed: strict projects, type ratchet (312 known errors within unchanged baseline), and process boundaries |
| App Studio/logger, Portfolio and endpoint settings/bridge suites, command below | 90 files passed, 2 existing gated files skipped; 1,510 tests passed, 30 skipped |
| PostgreSQL read-health integration | 4 tests passed |
| PostgreSQL partial-snapshot integration | 2 tests passed |
| PostgreSQL/filesystem project-delete integration | 27 tests passed |
| `pnpm run check:em-dash` | Passed |
| `pnpm run test:unsafe-escapes` | Passed |
| `node vex-app/scripts/copy-migrations.mjs` and migration 154/155 `cmp` | Passed |
| `git diff --check` | Passed |

Exact broad commands from the final runs:

```sh
pnpm exec vitest run src/__tests__/vex-agent/sync src/__tests__/solana src/__tests__/tools/solana-ecosystem/balances src/__tests__/blockscout src/__tests__/utils/transition-log.test.ts src/__tests__/vex-agent/tools/internal/wallet/read-blockscout-inventory.test.ts src/__tests__/vex-agent/tools/internal/wallet/read-solana.test.ts src/__tests__/vex-agent/db/repos/balances src/__tests__/vex-agent/tools/internal/portfolio-inspect.test.ts src/__tests__/config --maxWorkers=4

# In vex-app/
pnpm exec vitest run src/main/studio src/main/logger src/main/agent/__tests__/engine-log-bridge.test.ts src/main/database/__tests__/portfolio-db.test.ts src/main/database/__tests__/portfolio-snapshot-basis.test.ts src/main/ipc/__tests__/portfolio-refresh-redaction.test.ts src/shared/schemas/__tests__/portfolio.test.ts src/shared/schemas/__tests__/agent-scan-feed.test.ts src/renderer/features/appShell/book/portfolio src/renderer/features/appShell/studio/projects src/main/database/projects/__tests__/pending-cleanups.test.ts src/main/ipc/__tests__/projects-ipc.test.ts src/preload/__tests__/bridge-surface.test.ts src/main/ipc/__tests__/ipc-channel-registration-reconciliation.test.ts src/shared/__tests__/bridge-tracking.test.ts src/main/ipc/__tests__/settings-chain-endpoints.test.ts src/renderer/features/appShell/screens/SettingsScreen/__tests__/ChainEndpointsSection.test.tsx src/main/blockscout-bridge --maxWorkers=4

# In the repository root
pnpm exec vitest run --config vitest/studio-postgres.config.ts src/__tests__/integration/repos/balance-chain-read-status.int.test.ts src/__tests__/integration/repos/partial-portfolio-snapshots.int.test.ts vex-app/src/main/studio/__tests__/project-delete-e2e.int.test.ts
```

The turn-1 verification had initial concurrent-run failures, then passed with
four workers. The Studio connection-slot test failed on both the modified tree
and an untouched HEAD archive, then passed without test or timeout changes.
That evidence remains a baseline flake record, not a repaired defect. The first
revision app run repeated that failure (1,509 passed, one failed); an isolated
rerun passed all eight lifecycle tests and the final full app run passed all
1,510 tests, without changing lifecycle code, assertions or timeouts. The first
root revision run found two exact assertions missing the new status field; those
now assert the full updated vocabulary. The first app lint run caught optional
row/counter guards and a test sender type. All were corrected without baseline
changes before the final results above.

Red-on-old-behavior experiments restored exact edited bytes in finally blocks,
or used the isolated HEAD archive. No Git mutation was involved:

| Item | Regression evidence |
| --- | --- |
| Solana and Blockscout adapters/diagnostics | Restoring five original production modules produced 28 failures across all five changed suites |
| Snapshot honesty | Original orchestration produced four failures in unchanged new tests: failed Solana/empty fallback, unresolved propagation, fallback recovery and incomplete local inventory |
| Portfolio UI/manual refresh | Two tests copied to the original HEAD export failed: missing stale warning/timestamps and `refreshed` instead of `partial` |
| Studio deletion | Removing the classified trash result failed the real-filesystem reproducer; removing remediation failed the renderer reproducer |
| Logging | Original implementations produced three root failures and nine app failures for cadence, suppression, duplicate stderr and redaction |

New revision tests were also run against saved turn-1 implementation bytes,
then restored in finally blocks:

| Revised behavior | Red-on-turn-1 evidence |
| --- | --- |
| Known holdings refresh during discovery failure | 6 local-chain tests failed, including cached tokens outside seeds/pins and actual RPC failure distinction |
| Inventory and partial UI | 2 tests failed: missing-token warning versus stale balances, and explicit partial snapshot/P&L label |
| Three-cycle bound and partial storage/history | 9 new root tests failed; 3 app partial-basis tests failed |
| Partial metadata in public tool output | Removing the metadata projection made 2 new summary/history tests fail |
| Blockscout override/default/named rejection | 8 new tests failed against the saved turn-1 operation owner |

Additional real PostgreSQL checks cover inventory timestamps/recovery, scoped
replacement of known tokens, observed zeros, preservation of unscanned rows,
rollback on a duplicate-row insert, durable failure counts across connections
and reordered wallet sets, partial publication on cycles four/five, reset, and
P&L/history handling for both partial and healthy wallet subsets.

An independent review found no blocking defects and passed 140 targeted tests,
including a real loopback HTTP override and a separate public-host 403 probe.

Detailed temporary evidence: `/tmp/runtime-providers-report.md`,
`/tmp/runtime-studio-report.md`, `/tmp/runtime-logging-report.md`,
`/tmp/runtime-verify-solana.md`, `/tmp/runtime-verify-blockscout.md`,
`/tmp/runtime-balance-red.log`, `/tmp/runtime-portfolio-red.log`,
`/tmp/runtime-root-tests-final.log`, `/tmp/runtime-app-tests-final.log`,
`/tmp/runtime-app-lint.log`, `/tmp/runtime-health-integration-final.log`, and
`/tmp/studio-postgres-green.txt`.
Revision evidence: `/tmp/runtime-override-v2-report.md`,
`/tmp/runtime-snapshot-v2-report.md`, `/tmp/runtime-v2-independent-review.md`,
`/tmp/runtime-v2-local-red.log`, `/tmp/runtime-v2-portfolio-red.log`,
`/tmp/runtime-v2-root-tests-final.log`, `/tmp/runtime-v2-app-tests-final.log`,
`/tmp/runtime-v2-app-lint-final.log`, and `/tmp/runtime-v2-postgres.log`.

## Live probes and remaining proof

All provider probes were sequential, bounded and read-only. Independent passes
used the actual changed adapters, not fixtures alone.

| Host | Read | HTTP result |
| --- | --- | --- |
| solana-rpc.publicnode.com | getBalance | 403 |
| solana-rpc.publicnode.com | getTokenAccountsByOwner, SPL | 403 |
| solana-rpc.publicnode.com | getTokenAccountsByOwner, Token-2022 | 403 |
| api.mainnet-beta.solana.com | getBalance, ordinary HTTP and changed adapter | 200 |
| api.mainnet-beta.solana.com | SPL inventory, ordinary HTTP and changed adapter | 200, 7 rows |
| api.mainnet-beta.solana.com | Token-2022 inventory, ordinary HTTP and changed adapter | 200, 5 rows |
| robinhoodchain.blockscout.com | ERC-20 inventory, ordinary HTTP, Electron and changed adapter | 403, explicitly incomplete |
| 127.0.0.1 | Configured proxy prefix through real HTTP server, client and bridge | 200, complete |

Only the owner can verify the historical Windows network conditions and the
current configured override, proxy, DNS and TLS trust. The old class-only log
cannot reconstruct that historical cause. On the new build, refresh both
wallet families, verify live Solana changes, and verify Robinhood known balances and snapshots continue updating during public
inventory refusal. Its warning must say new tokens may be missing, not that
known balances failed. Save the owner's proxy in Chain endpoints for 4663 and
verify its inventory read, actual host-only diagnostic, clear-to-default behavior
and Windows TLS policy. For an actual balance-read outage, verify three deferrals
then partial snapshots; stale timestamps survive restart, recovery clears the
warning, and P&L resumes after two adjacent complete snapshots.

For deletion, identify whether the actual folder is on local NTFS, a mapped
share or a WSL UNC path. Test an OS trash attempt with and without programs
holding the directory. Verify refusal retains files and a durable notice;
closing a busy holder plus explicit Retry completes cleanup. An unrecyclable
volume must retain manual remediation and must never trigger permanent deletion.
Verify the notice after closing the dialog and restarting the app.

Reference decisions: error mapping and cancellation were compared with VS Code
request service and tests; sink ownership with its log service and BufferLogger;
trash ownership with its Electron filesystem provider and real filesystem
tests; accessible error lifetime with the local interaction reference's toast
implementation/tests. Retained Vex's own typed boundaries, privacy rules and
durable recovery, rather than copying transient notifications or raw errors.

File-growth decisions: the already-large Solana reader keeps its cohesive
deadline operation, with diagnostic classification extracted separately.
`balance-sync.ts` is over 750 lines; durable deferral policy was extracted into
its own module, while the remaining code stays orchestration of the
same per-chain scan and snapshot decision, while persistence and presentation
have separate owners. Splitting that control flow during this bugfix would add
handoffs without separating a lifecycle. The large IPC channel table remains
a single cohesive registry. The existing deletion integration suite retains
its real lifecycle assertions. Moved private trash helpers were removed after
repository-wide reference checks; no compatibility shim or dead owner remains.


## CI contract repairs, 2026-09-09

Work began on the clean coordinator tree at `872cba392`. No commits or history
changes were made in this repair pass.

The [PR 179 CI run](https://github.com/Vex-Foundation/Vex/actions/runs/34283027894)
shows the same two telemetry failures and Settings failure on every platform:
Linux job `102252377235`, Windows `102252377367`, and macOS `102252377187`.
Their respective test summaries were 3 failed / 12,000 passed / 28 skipped,
3 failed / 11,930 passed / 98 skipped, and 3 failed / 11,897 passed / 48 skipped.
The preceding branch run `34282994145` was cancelled 21 seconds earlier;
no passing Linux run exists in the retrieved branch history. Both symptoms
also reproduced in isolated Linux tests. No OS-dependent branch or line-ending
cause exists here, and the Settings failure was deterministic.

- JSONB: the unchanged architecture test identified
  `src/vex-agent/db/repos/balance-chain-read-status.ts:31` as its sole offender.
  The writer now uses `db/params.jsonb`, as do the snapshot publisher's ledger
  and wallet-row JSONB parameters. JSON used as the deferral counter's hash
  preimage remains ordinary serialization because it is not a JSONB parameter.
- URL handling: `main/logger/redact.ts` parses original URLs first. Benign
  queries/fragments are removed while the diagnostic scheme/host/path remain.
  Userinfo or credential query keys, including encoded keys, redact the URL
  whole. `main/telemetry/before-send.ts` applies that same policy to original
  request URLs, exception values, messages, nested extra/context values and tags.
  Redundant private URL helpers were removed after checking their consumers.
  The original failing fixtures used credential queries; their values remain
  explicitly tested for whole redaction under the latest requested policy.
  Keep-path cases use benign pagination queries and retain exact assertions.
  LF and CRLF cases prove matching behavior without altering line endings.
- Settings: the endpoint feature added a ninth register row with a second
  `Open` status. That broke the existing singular-text and eight-row assertions
  before any endpoint query ran. Endpoint controls now live inside the existing
  API keys section. All original register assertions remain; new tests cover
  navigation, the API keys deep-link and no endpoint query on the landing page.
  The unused private `chainEndpoints` route was deleted after a reference search
  confirmed no callers and no persisted shell route.
- Cloudflare: the fresh bounded public probe and the changed real Electron
  client both returned host `robinhoodchain.blockscout.com`, HTTP 403,
  `cloudflare_challenge`, incomplete inventory and zero candidates. A separate
  verification repeated that result. A narrow header fact or the measured
  HTML title/platform markers distinguish it from ordinary `http_403`.
  The Portfolio reason allow-list preserves the new class and explains that
  the public explorer refuses automated reads, with the Blockscout override at
  Settings > API keys > Chain endpoints as remediation. No raw HTML, challenge
  token, URL credentials or request URL is included in the diagnostic.

Regression evidence:

| Experiment against the previous implementation | Observed result |
| --- | --- |
| Unchanged JSONB architecture gate | 1 failure, named the read-status writer |
| Updated/new URL contract tests before implementation | 17 failed, 47 passed |
| Original isolated Settings screen suite | 1 failed, 15 passed, duplicate `Open` |
| Restore old Settings register/view with final tests | 3 failed, 15 passed |
| Restore old Blockscout client with challenge tests | 2 failed, 1 passed; unrelated cases excluded by test-name filter |
| Restore old header bridge and Portfolio warning | 2 failed; unrelated cases excluded by test-name filter |

Every temporary red-on-revert mutation restored the exact edited bytes in a
finally block. No tests, compiler settings or CI baselines were weakened.
The strict JSONB helper also exposed a pre-existing incomplete pending-bridge
fixture in the sync suite. It now includes the wallet address and entry kind
that the real SQL returns, preserving every publication assertion.

Current repair verification:

| Command | Result |
| --- | --- |
| Root command below: JSONB boundary, sync suites and Blockscout | 96 files, 1,382 tests passed |
| App command below: telemetry/logger/Settings and affected consumers | 10 files, 162 tests passed |
| Root `pnpm exec tsc --noEmit -p tsconfig.json` | Passed |
| App `pnpm run lint` | Passed; 312 existing errors remain within the unchanged type baseline, process boundaries passed |
| Root `pnpm run check:em-dash` | Passed |
| Root `pnpm run test:unsafe-escapes` | Passed |
| `git diff --check` | Passed |

```sh
# Root
pnpm exec vitest run src/__tests__/vex-agent/db/jsonb-boundary.test.ts src/__tests__/vex-agent/sync src/__tests__/blockscout --maxWorkers=4

# vex-app/
pnpm exec vitest run src/main/telemetry src/main/logger src/renderer/features/appShell/screens/__tests__/SettingsScreen.test.tsx src/renderer/features/appShell/screens/SettingsScreen/__tests__/ChainEndpointsSection.test.tsx src/main/blockscout-bridge src/renderer/features/appShell/book/portfolio/__tests__/portfolio-scope-cards.test.tsx src/main/database/__tests__/portfolio-db.test.ts --maxWorkers=4
```

Evidence files: `/tmp/runtime-v3-ci-linux.log`, `runtime-v3-ci-windows.log`,
`runtime-v3-ci-macos.log`, `runtime-v3-jsonb-red.log`,
`runtime-v3-telemetry-report.md`, `runtime-v3-settings-report.md`,
`runtime-v3-review.md`, `runtime-v3-blockscout-probe.json`,
`runtime-v3-blockscout-live.log`, `runtime-v3-root-tests-final.log`,
`runtime-v3-app-tests.log` and `runtime-v3-app-lint.log`, all under `/tmp`.
The local checks and deterministic platform-independent fixes do not substitute
for a new Windows CI execution. The owner's private proxy and native Windows
Recycle Bin checks retain the previously stated limitations.


## Explorer request headers, 2026-09-09 (turn 4)

Started from the clean accepted tree at `2349d4d39`. Runtime changes are limited
to `vex-app/src/main/blockscout-bridge/http.ts`. The other changed files are its
`__tests__/http.test.ts`, `src/tools/blockscout/BLOCKSCOUT.md`, and this report.
No package manifest, lockfile or scripts directory was modified. No commits
or history changes were made.

The owner-provided header matrix is recorded in the dated request-context
section of `BLOCKSCOUT.md`. Our two pre-edit curl probes confirmed the key
contrast: Accept alone -> HTTP 403 challenge; Accept + same-origin Referer +
Sec-Fetch trio -> HTTP 200 JSON with 37 rows. They ran sequentially, 1.5 seconds
apart. The operation and API remained unchanged; the user agent was irrelevant
in the supplied ablation.

Final explicit headers:

| Header | Value and justification |
| --- | --- |
| Accept | `application/json`, preserving the JSON operation |
| Referer | selected operation origin plus `/`; measured same-site context releases the request |
| Sec-Fetch-Dest | `empty`, matching the explorer's fetch context |
| Sec-Fetch-Mode | `cors`, matching that context |
| Sec-Fetch-Site | `same-origin`, matching that context |
| Origin | selected operation origin; required by Electron 42 to send cors mode |

Origin is the necessary addition to the initially proposed five headers. The
real Electron bridge rejected five headers with `net::ERR_INVALID_ARGUMENT`
before receiving an HTTP response. Local loopback tests and Electron's
[net-fetch source](https://github.com/electron/electron/blob/v42.0.0/lib/browser/api/net-fetch.ts)
show why: its request origin comes from the Origin header, and cors mode
requires that origin. With Origin, the actual local wire carries the required
cors/same-origin values. This avoids adding a session hook or extra lifecycle
owner. The owner's Referer-plus-Origin probe also passed. No custom Chrome UA,
client hints or language header is added.

The final real app bridge call returned HTTP 200, complete inventory and
37 candidates. Independent verification repeated 200 / complete / 37. Logs
record only host/status/class/completeness/count. The header tests assert the
exact application-owned set for the default and for HTTPS and loopback HTTP
proxies, preserving their ports and request path prefixes. The existing
challenge classification and conditional Portfolio refusal/remedy sentence
remain truthful and unchanged.

Verification:

| Command or measurement | Result |
| --- | --- |
| Root `pnpm exec vitest run src/__tests__/blockscout --maxWorkers=4` | 2 files, 48 tests passed |
| App `pnpm exec vitest run src/main/blockscout-bridge src/renderer/features/appShell/book/portfolio --maxWorkers=4` | 5 files, 34 tests passed |
| App `pnpm run lint` | Passed: strict projects, unchanged type baseline with 312 existing errors, process boundaries |
| Root `pnpm run check:em-dash` | Passed |
| Root `pnpm run test:unsafe-escapes` | Passed |
| `git diff --check` | Passed |
| New captured-header tests against the original bridge | 3 failed, 6 passed; original code omitted required page/proxy context |
| Local Electron five-header experiment | ERR_INVALID_ARGUMENT before network delivery |
| Local Electron final six-header experiment | HTTP 200 with cors/same-origin received |
| Real app bridge, fixture wallet | HTTP 200, complete, 37 candidates |
| Independent real app bridge | HTTP 200, complete, 37 candidates |

The pre-existing live harness covers the adapter and Electron transport only.
The optional complete local-chain database sync was not run: its default path
adds three endpoint identity probes, metadata/balance/native RPC calls and
pricing, with possible parallel multicalls and up to twelve rescue requests.
That exceeds the requested handful of sequential public requests. The existing
real-Postgres recovery test separately covers production
`recordChainReadObservations` and `readChainReadIssues` clearing
`inventory_incomplete` and its timestamp after an `ok` observation; that is not
reported as a live full-sync recovery. No user's database was modified here.

Evidence: `/tmp/runtime-v4-prewrite-probes.json`,
`/tmp/runtime-v4-headers-red.log`, `/tmp/runtime-v4-origin-local.log`,
`/tmp/runtime-v4-blockscout-live-final.log`,
`/tmp/runtime-v4-independent-final.log`, `/tmp/runtime-v4-final-review.md`,
`/tmp/runtime-v4-root-tests.log`, `/tmp/runtime-v4-app-tests-final.log`, and
`/tmp/runtime-v4-app-lint-final.log`.
