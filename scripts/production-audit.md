# Production dependency audit

`pnpm run audit:deps` refuses any advisory in a workspace's PRODUCTION
dependency graph that its reviewed exception allowlist does not carry verbatim.
CI runs it once per lockfile: the root workspace in `root-build-and-test`, the
desktop workspace in `vex-app-build-and-test`.

Files:

- `scripts/audit-production-dependencies.mjs` - the runner: spawns the pinned
  `pnpm audit --prod --json`, loads the allowlist, runs the reachability
  verifiers, chooses the exit code.
- `scripts/production-audit-decision.mjs` - the pure decision. Exact match in
  both directions (an unlisted finding fails, and a listed exception the audit
  no longer reports fails), plus the hard `reviewBy` expiry.
- `scripts/verify-stream-json-exception.mjs`,
  `scripts/verify-uuid-exception.mjs` - reachability verifiers. An exception
  whose package has a verifier is never accepted on its rationale text alone:
  the verifier reads the INSTALLED module graph and fails when the claim stops
  holding.
- `scripts/production-audit-allowlist.json` (root),
  `vex-app/scripts/production-audit-allowlist.json` (desktop).

## Current exceptions

Every exception below was proposed by the Lighter integration author on
2026-09-06 and is PENDING the repository owner's decision in PR review. None of
them is owner-approved. All expire on 2026-09-18: after that date the gate
fails regardless of the findings, so an unrenewed exception cannot survive by
inattention.

| Package | Version | Advisory | Workspaces | Why it is tolerated | Removal condition |
| --- | --- | --- | --- | --- | --- |
| bigint-buffer | 1.1.5 | GHSA-3gc7-fjrx-p6mg (high) | root | No patched release upstream. Reached only through fixed-width Solana SPL layouts (8 to 32 bytes), which slice input to the declared span before `toBigIntLE` and reject short data. Argued only: no mechanical reachability check. | Solana removes or patches bigint-buffer. |
| uuid | 8.3.2 | GHSA-w5hq-g745-h8pq (moderate) | root, vex-app | The advisory covers v3, v5 and v6 with a caller-provided output buffer. Jayson binds `require("uuid").v4` and calls it with no arguments. Verified mechanically. | Jayson or Solana accepts uuid 11.1.1 or newer. |
| stream-json | 1.9.1 | GHSA-528h-pc64-c93x (moderate) | root, vex-app | The advisory covers the pick/ignore/filter/replace path filters and excludes StreamValues. Jayson 4.3.0 imports StreamValues and Verifier only. Verified mechanically, including that no filter module is loaded. 3.5.0 changes module exports and is not a compatible replacement. | Jayson accepts a patched release, or its reachable imports change. |

## Overrides and bumps

Every row below was MEASURED on 2026-09-07 by installing the pre-change
lockfile (`c01f1a4eb`) with `--frozen-lockfile` and running
`pnpm audit --prod --json` in each workspace. "Advisory cleared" is what that
run reported at the old version; it is evidence, not intent. Removal condition
is what makes the pin unnecessary.

Root workspace (`package.json`), advisories cleared: axios, follow-redirects,
form-data, ip-address, socket.io-parser, uuid 11.1.0, and three ws paths.

| Override | Was | Pin | Advisory cleared | Removal condition |
| --- | --- | --- | --- | --- |
| `axios` | 1.14.0 | 1.18.0 | high, moderate and low on `.>@tavily/core>axios` | @tavily/core's axios range floors at 1.18.0. |
| `follow-redirects` | 1.15.11 | 1.16.0 | moderate on `.>@tavily/core>axios>follow-redirects` | axios floors its follow-redirects range at 1.16.0. |
| `form-data` | 4.0.5 | 4.0.6 | high on `.>@tavily/core>axios>form-data` | axios floors its form-data range at 4.0.6. |
| `ip-address` | 10.2.0 | 10.3.1 | high and moderate on `.>rettiwt-api>socks-proxy-agent>socks>ip-address` | socks floors its ip-address range at 10.3.1. |
| `socket.io-parser` | 4.2.6 | 4.2.7 | high on `.>socket.io-client>socket.io-parser` | socket.io-client floors its parser range at 4.2.7. |
| `uuid@>=11.0.0 <12` | 11.1.0 | 11.1.1 | moderate on `.>@solana/web3.js>rpc-websockets>uuid` | rpc-websockets floors its uuid range at 11.1.1. Scoped to the 11.x range on purpose so Jayson's uuid 8 (see the allowlist) is not swapped for an incompatible major. |
| `jayson>ws` | 7.5.10 | 7.5.11 | high on `.>@solana/web3.js>jayson>ws` | Jayson floors its ws range at 7.5.11. |
| `ethers>ws` | 8.17.1 | 8.21.0 | high and moderate on `.>ethers>ws` | ethers floors its ws range above 8.18.3. |
| `engine.io-client>ws` | 8.18.3 | 8.21.0 | high and moderate on `.>socket.io-client>engine.io-client>ws` | engine.io-client floors its ws range above 8.18.3. |
| `rpc-websockets>ws` | 8.20.1 in the desktop graph, not reported in the root graph | 8.21.0 | Nothing in the root workspace: preventive, and it keeps both lockfiles on one ws line. | rpc-websockets floors its ws range at 8.21.0. |

Desktop workspace (`vex-app/package.json`):

| Override | Was | Pin | Advisory cleared | Removal condition |
| --- | --- | --- | --- | --- |
| `electron-updater>js-yaml` | 4.1.1 | 4.3.1 | high and moderate on `.>electron-updater>js-yaml`. This parser reads release metadata on the update-integrity path. | electron-updater floors its js-yaml range at 4.3.1. |
| `jayson>ws` | 7.5.10 | 7.5.13 | high on `.>@solana/web3.js>jayson>ws` | Jayson floors its ws range at 7.5.13. |
| `rpc-websockets>ws` | 8.20.1 | 8.21.3 | high on `.>@solana/web3.js>rpc-websockets>ws` | rpc-websockets floors its ws range at 8.21.3. |

Three direct dependencies were BUMPED rather than overridden or allowlisted,
because upstream already ships the fix:

| Dependency | Workspace | Was | Now | Advisory cleared |
| --- | --- | --- | --- | --- |
| `undici` | root | 7.25.0 | 7.29.0 | high, moderate and low on `.>undici` |
| `@sentry/electron` | vex-app | ~7.13.0 | ~7.16.0 | high and moderate `brace-expansion` and two moderate `@opentelemetry/core` findings under `@sentry/node` |
| `electron-updater` | vex-app | ~6.8.3 | ~6.8.9 | high on `.>electron-updater>builder-util-runtime` |

Without those three bumps the desktop gate fails, which is the gate working as
intended: a fixable advisory is fixed, never excused.

`pnpm.onlyBuiltDependencies` and `pnpm.ignoredBuiltDependencies` record which
packages may run install scripts. Nothing is added to `onlyBuiltDependencies`
without a reason to execute code from that package at install time. Note that
under pnpm 10.32.1 the desktop install still prints its "Ignored build scripts"
notice for `bufferutil`, `cpu-features`, `protobufjs`, `ssh2` and
`utf-8-validate`; listing those packages in `ignoredBuiltDependencies` was
measured and does not silence it. The notice is informational, and no build
script runs either way.

## Changing an exception

1. Try to remove it first: bump the direct dependency, or add an override.
   An exception is the last resort, not the first.
2. If it must stay, write the rationale as a reachability argument about THIS
   repository's code path, and say plainly who decided and when.
3. If the claim is mechanical, add a verifier next to the existing two and
   register it in `REACHABILITY_VERIFIERS`. A claim nobody can check is worth
   less than a red gate.
4. Move `reviewBy` only with a stated reason. It is the gate's only automatic
   expiry.
