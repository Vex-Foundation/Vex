# Dependency Audit — vex-app

**Audit run**: 2026-05-07
**Scope**: Pre-M0 dependency lock audit (Milestone -1 per plan)
**Verdict**: Clean — proceed with M0

This audit verifies every direct dependency against npm registry on 2026-05-07 against the policy declared in plan §J:

> Top-level deps: stable releases only. ZERO `-beta`/`-rc`/`-nightly`/`-alpha`/`-canary` w direct dependencies. Transitive prereleases dopuszczone gdy upstream stable nie dostępny — udokumentowane poniżej z reason + tracking.

## Top-level dependency tuple (verified 2026-05-07)

All top-level packages: stable releases, no prereleases, no deprecated, license MIT/Apache-2.0/MPL-2.0 compatible.

| Package | Plan target | Verified latest | Pinned in package.json | Published | License | Notes |
|---|---|---|---|---|---|---|
| `electron` | 42.0.0 | 42.0.0 | `42.0.0` exact | 2026-05-06 | MIT | Hard target per skill §2 |
| `electron-builder` | ~26.0 | 26.8.1 | `~26.8.1` | 2026-05-07 | MIT | |
| `electron-updater` | ~6.6 | 6.8.3 | `~6.8.3` | 2026-05-07 | MIT | autoDownload/autoInstall disabled per plan |
| `@electron/fuses` | ~1.8 | **2.1.1** | `~2.1.1` | 2026-03-27 | MIT | **Major bump 1→2**; Node ≥22.12 satisfied; afterPack pattern unchanged |
| `vite` | ~8.0.10 | 8.0.11 | `~8.0.11` | 2026-05-07 | MIT | |
| `@vitejs/plugin-react` | ~6.0.1 | 6.0.1 | `~6.0.1` | 2026-05-07 | MIT | Drops Babel, uses SWC |
| `react` | ~19.2.5 | 19.2.6 | `~19.2.6` | 2026-05-06 | MIT | |
| `react-dom` | ~19.2.5 | 19.2.6 | `~19.2.6` | 2026-05-06 | MIT | |
| `typescript` | 6.0.3 | 6.0.3 | `6.0.3` exact | 2026-04-16 | Apache-2.0 | New defaults: types:[], target:es2025, alwaysStrict |
| `vitest` | ~4.1.5 | 4.1.5 | `~4.1.5` | 2026-05-05 | MIT | |
| `@playwright/test` | 1.59.1 | 1.59.1 | `1.59.1` exact | 2026-05-07 | Apache-2.0 | Skill §2 exact pin |
| `playwright` | 1.59.1 | 1.59.1 | `1.59.1` exact | 2026-05-07 | Apache-2.0 | |
| `tailwindcss` | ~4.2.0 | 4.2.4 | `~4.2.4` | 2026-05-06 | MIT | |
| `@tailwindcss/vite` | ~4.2.0 | 4.2.4 | `~4.2.4` | 2026-05-06 | MIT | Lightning CSS pipeline |
| `motion` | ~12.38 | 12.38.0 | `~12.38.0` | 2026-03-17 | MIT | Migrated from `framer-motion`; uses `motion/react` |
| `@hugeicons/react` | ~1.1.6 | 1.1.6 | *(removed)* | 2026-03-10 | MIT | **REMOVED 2026-07** — icons migrated to `lucide-react` behind the `renderer/components/icons/` adapter; no longer a dependency |
| `@hugeicons/core-free-icons` | ~1.0.0 | **4.1.1** | *(removed)* | 2026-03-30 | MIT | **REMOVED 2026-07** — see the row above |
| `@tanstack/react-query` | ~5.100 | 5.100.9 | `~5.100.9` | 2026-05-03 | MIT | |
| `zustand` | ~5.0 | 5.0.13 | `~5.0.13` | 2026-05-05 | MIT | |
| `zod` | ~4.4.3 | 4.4.3 | `~4.4.3` | 2026-05-04 | MIT | |
| `react-hook-form` | ~7.75 | 7.75.0 | `~7.75.0` | 2026-05-02 | MIT | |
| `@hookform/resolvers` | ~5.2 | 5.2.2 | `~5.2.2` | 2025-09-14 | MIT | |
| `marked` | ~18.0.3 | 18.0.3 | `~18.0.3` | 2026-05-01 | MIT | Phase 2 |
| `pg` | ~8.20 | 8.20.0 | `~8.20.0` | 2026-03-04 | MIT | Pure-JS bindings; no `pg-native` |
| `@sentry/electron` | ~5.0 | **7.13.0** | `~7.13.0` | 2026-04-30 | MIT | **Major bump 5→7**; opt-in only init per plan §L; `@sentry/node-native` is optional peer (skip) |
| `electron-log` | ~5.4 | 5.4.3 | `~5.4.3` | 2025-08-18 | MIT | File rotation 5MB/archive |
| `sharp` | ~0.33 | 0.34.5 | `~0.34.5` | 2026-04-25 | Apache-2.0 | Pre-build icon generation only |

## Major version bumps — review

Three direct deps received major bumps vs planned targets. Each verified safe:

### 1. `@electron/fuses` 1.8 → 2.1.1
- **Why bumped**: latest stable; previous skill target (~1.8) is from 2024 vintage
- **API surface**: `flipFuses()` + `FuseV1Options` enum — same names as 1.x; v2 adds `FuseV2Options` (new fuses) and Node ≥22.12 minimum
- **Impact**: pattern w `build/afterPack.mjs` unchanged; we only use `FuseV1Options.*` flags listed in plan §B
- **Action**: adopt 2.1.1, no migration needed

### 2. `@hugeicons/core-free-icons` 1.0 → 4.1.1 *(package removed 2026-07 — historical)*
- **Why bumped**: package was renumbered (icon library version, not API version)
- **API surface**: bare exports of icon objects (e.g. `SearchIcon`, `Send02Icon`) — consumed by `@hugeicons/react`'s `<HugeiconsIcon icon={X} />` component, no API breaks
- **No peerDeps** declared, no transitive deps (data-only package)
- **Action**: adopt 4.1.1, no migration needed

### 3. `@sentry/electron` 5.0 → 7.13.0
- **Why bumped**: latest stable; covers Sentry SDK 10.x for Node/Browser
- **API surface**: 7.x has refactored init API vs 5.x (`Sentry.init({ dsn, beforeSend, ... })` patterns differ) — significant
- **Impact mitigated**: per plan §L, Sentry SDK is opt-in only and is wired in M1/M11. We adopt the new 7.x API at integration time, no legacy code to migrate.
- **Optional peer**: `@sentry/node-native@10.50.0` declared but `peerDependenciesMeta.optional: true` — not required to install
- **Action**: adopt 7.13.0; reference Sentry 7.x docs at integration time

## Removed from plan
- **`@types/dompurify`** — DOMPurify v3.x ships own types (`@types/dompurify` deprecated as stub). Removed.

## Removed 2026-07-03 — unused dependencies (MVP-readiness audit)

Three production deps had zero imports anywhere in vex-app (`src/`, `scripts/`, `e2e/`, vite configs) and were removed from `dependencies`:

- **`@tanstack/react-virtual`** — the SessionTranscript virtualization it was added for was only speced (`docs/SIGNAL_TAPE_REDESIGN.md`), never wired. Re-add together with the wiring PR if virtualization lands.
- **`dompurify`** — `MarkdownContent.tsx` renders marked tokens as auto-escaped React nodes; there is no HTML sink, so no sanitizer is needed. Keeping it listed misled reviewers into assuming a sanitizer-hardened pipeline.
- **`bs58`** — never imported by vex-app code. The root `src/tools/wallet/solana-keystore.ts` import resolves from `/Vex/node_modules` (root declares its own `bs58 ^6.0.0`), never from vex-app's tree — see `.claude/rules/80-edge-cases.md` §4, which supersedes the 2026-05-14 resolution rationale above. The vex-app copy was an orphan.

## Added 2026-05-14 — root runtime deps bundled into main bundle

The vex-app main process consumes shared root runtime code (`/mnt/x/Vex/src/lib/*`, `/mnt/x/Vex/src/tools/*`) through the `@vex-lib` Vite alias declared in `vite.main.config.ts`. At BUILD time, Rolldown bundles that source into `dist/main/index.js` and must resolve its third-party imports against vex-app's own `node_modules` — pnpm hoisting across workspace boundaries is not honoured during bundling. The fix is to declare these runtime deps directly in `vex-app/package.json` so they are resolvable at build AND copied into the packaged Electron app.

| Package | Version | Verified | License | Why |
|---|---|---|---|---|
| `viem` | `2.45.1` | matches root pin | MIT | Wallet primitives — keystore decryption, `privateKeyToAddress`, chain definitions. Used by `wallet-export`, `wallet-restore`, `wallets-runner`. |
| `@solana/web3.js` | `~1.98.4` | matches root range | Apache-2.0 / MIT | Solana keystore handling, native balances. Used by root `tools/wallet/solana-create.ts`, `solana-keystore.ts`; also imported directly by vex-app `src/main/onboarding/wallet-restore.ts`. |
| `@openrouter/sdk` | `^0.9.11` | matches root range | Apache-2.0 | OpenRouter client used by `openrouter-test-client.ts`. |

All are declared in `dependencies` (not `devDependencies`) because electron-builder must ship them in the packaged app.

This addition does NOT close the root runtime boundary issue — that is a separate refactor (split `src/lib/wallet.ts` so `loadConfig` does not pull `viem/accounts`) tracked in task #13. The build fix unblocks CI; the proper boundary fix follows.

### Accepted transitive debt

- **`uuid@8.3.2`** (deprecated upstream) — pulled in via `@solana/web3.js` → `jayson` chain. Non-blocking; upstream has not yet migrated to a non-deprecated UUID library. We accept this as transitive debt and revisit whenever the Solana SDK ships an upgrade.

## Transitive prereleases (post-install scan — 2026-05-07)

`pnpm install` resolved 504 packages (431 added). Transitive prereleases identified, all pulled by stable top-level deps:

| Package | Version | Pulled by | Status |
|---|---|---|---|
| `rolldown` | `1.0.0-rc.18` | `vite@8.0.11` | Vite-internal compiler. Tracked: [rolldown/rolldown#stable](https://github.com/rolldown/rolldown) — Rolldown 1.0 stable target ~Q3 2026. Re-pin Vite when stable Rolldown lands. |
| `@rolldown/binding-*` (16× per arch) | `1.0.0-rc.18` | `rolldown@1.0.0-rc.18` | Native bindings, same provenance |
| `@rolldown/pluginutils` | `1.0.0-rc.7` and `1.0.0-rc.18` | `@vitejs/plugin-react@6.0.1` (rc.7), `vite@8.0.11` (rc.18) | Two versions deduped by pnpm — acceptable until Rolldown stable |
| `app-builder-bin` | `5.0.0-alpha.12` | `builder-util@26.8.1` (electron-builder) | Official electron-builder native helper. Alpha qualifier inherited from electron-builder's pinning policy; package itself is production-stable per electron-builder@26 release notes. |
| `postject` | `1.0.0-alpha.6` | `@electron/windows-sign@1.2.2` (via `electron-winstaller`) | Official `@electron/postject` for ASAR integrity / Windows signing. Alpha qualifier conventional in postject's release line; widely used in production by Electron core. |

**Policy**: all 5 transitive prereleases are pulled by stable top-level packages we control directly (Vite 8 and electron-builder 26). They are NOT consumed by our code as direct API surface — they are bundler / signing internals. Acceptable per plan §J transitive policy.

**`@vitest/browser-preview`** appears in some scans as "preview" — this is the package name itself (`vitest browser` mode is experimental as a feature, but package version `4.1.5` is current latest stable per dist-tags).

## Security advisories
- **`pnpm audit --prod`**: `No known vulnerabilities found` ✓
- **`pnpm audit` (full incl. dev)**: `No known vulnerabilities found` ✓
- **DOMPurify CVEs**: addressed via `~3.4.2` pin (≥3.4.0 mandatory for CVE-2026-0540 / 41238 / 41239)

## License compatibility (post-install)

**Production tree (deduped, top-level pruning to `--prod`)**:
- MIT
- Apache-2.0
- ISC
- BlueOak-1.0.0
- 0BSD
- Python-2.0
- (MPL-2.0 OR Apache-2.0) — DOMPurify

**Dev tree adds**: BSD-2-Clause, BSD-3-Clause, MPL-2.0, WTFPL, WTFPL OR ISC, LGPL-3.0-or-later (only `@img/sharp-libvips-*` — used build-time by `sharp`, **NOT shipped in production bundle**, dynamic-linked via N-API)

**GPL/AGPL/SSPL/CC-BY-NC/UNLICENSED scan**:
- Production tree: ZERO ✓
- Dev tree: ZERO viral copyleft (LGPL build-time use is permissive for our case)

## Node engine requirement
- `@electron/fuses 2.1.1` requires Node ≥22.12.0 ✓
- `electron@42.0.0` bundles Node 24.14.x — runtime fine ✓
- Root `vex-app/package.json`: `"engines": { "node": ">=22.21.0" }` ✓ satisfied
- pnpm warning re: current node 22.12.0 vs required 22.21.0 — **non-blocking** for CI/dev (engineStrict not enforced); production builds use bundled Node 24

## Build script approvals (pnpm@10 strict)

Two packages requested build scripts during install:
- `electron-winstaller@5.4.0` (Windows installer generator) — needed for `pnpm vex:make` on Windows
- `sharp@0.34.5` (libvips bindings) — needed for icon generation

**Action in M0**: run `pnpm approve-builds` and pin allowed-scripts whitelist in `package.json` `pnpm.onlyBuiltDependencies` field for reproducible CI builds.

## Verdict — M-1 GATE: PASS

- ✅ Top-level deps: 30 packages, all stable releases, zero prereleases, zero deprecated, all license-compatible
- ✅ Transitive prereleases: 5 documented (Vite 8/electron-builder ecosystem internals)
- ✅ Security audit: 0 high/critical (prod + dev)
- ✅ License: zero GPL viral; LGPL only build-time dev (libvips for sharp)
- ✅ Node engine satisfied
- ✅ Lockfile committed: `pnpm-lock.yaml`

**Proceed to M0 (Security baseline + scaffold)**.
