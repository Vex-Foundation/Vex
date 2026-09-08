# Security Policy

Vex is self-custodial software that holds users' own keys and can move real
funds. We take security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Do not open a public issue for security bugs.**

Email **security@projectvex.ai** with:

- a description of the issue and its impact;
- steps to reproduce (proof-of-concept if possible);
- affected version or commit and platform;
- any suggested remediation.

If you need to share sensitive details, ask for our PGP key in your first
message.

We aim to acknowledge reports within 3 business days and to keep you updated as
we investigate. Please give us reasonable time to ship a fix before any public
disclosure.

## In scope

- Key generation, storage, and at-rest encryption (vault, keystores, backups).
- Approval gating and any path that could move funds without explicit consent.
- The Electron trust boundary (renderer to privileged process, IPC, preload).
- The auto-updater and release or signing integrity.
- Leakage of keys, seeds, or secrets through logs, telemetry, or crash reports.

## Production dependency policy

Use the exact Node minimum and pnpm version declared in the root `package.json`.
`pnpm run verify:toolchain` fails when either requirement is not met, and both
CI and release jobs run it before installation. Both dependency trees must be
installed with `--frozen-lockfile`.

Run `pnpm run audit:deps` for the root production graph. The audit fails on any
finding that is not an exact match for the package, version, severity, advisory
URL, and dependency path in `scripts/production-audit-allowlist.json`. Reviewed
exceptions have a mandatory expiry date; a resolved, changed, or expired
exception also fails the audit so it cannot silently become permanent.
Run the same command from `vex-app/` for its independently locked production
graph; it uses its own exact-path exception file and the same fail-closed audit
implementation.

pnpm dependency build scripts are default-denied. The root package explicitly
allows only build-critical scripts and records packages whose optional or
nonessential scripts are intentionally disabled. Do not add a package to the
allowlist without reviewing the script and documenting why installation needs
to execute it.

## Out of scope

- Loss of funds due to a user-chosen weak master password, lost password, or
  approving a malicious transaction.
- Phishing, impersonation, or software obtained from unofficial sources (see the
  official channels in the README).
- Issues in third-party dependencies already tracked upstream, unless Vex uses
  them in a uniquely unsafe way.

## Safe harbor

We will not pursue or support legal action against good-faith security research
that respects this policy, avoids privacy violations and data destruction, and
does not degrade the service for others.

Official sources: https://www.projectvex.ai/ and https://x.com/ProjectVEXai
