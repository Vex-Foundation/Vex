# Vex Studio production probes

Small, self-contained measurement scripts for the questions the Studio
production plan refuses to answer from a Linux developer box.

Every probe here exists because a decision is gated on a MEASUREMENT rather
than on an argument. The Postgres connect probe is the first: the shared
bounded `pg.Pool` gets built only if the numbers say the per-call connect cost
is the mechanism behind the Windows black screen. A probe that comes back
"not implicated" is a successful probe.

Rules every probe in this directory follows:

- runs from a bare `node`, no build step, no tsx, no Electron;
- sequential and bounded traffic, because the default target is the owner's
  own live database;
- read-only against anything it did not create;
- never prints or persists a secret, only the path a secret was read from;
- refuses to report against a target it cannot prove is the intended one.

## 1. `pg-connect-latency.mjs` (run this first)

How long does one cold `pg.Client` connect + auth take on this machine? That
is the exact cost `withClient` pays on EVERY main-process database call
(`src/main/database/sessions/connection.ts`), with a 2000 ms ceiling.

### Running it on Windows

Open PowerShell, with Vex installed and its stack up (the probe reads the
install's own secret, so Vex must have composed at least once):

```powershell
cd <repo>\vex-app
node scripts\probes\pg-connect-latency.mjs --runs 20 --gap-ms 100 `
  --label windows-docker-desktop `
  --json scripts\probes\artifacts\pg-connect-latency-windows.json
```

That is the whole run. It takes about five seconds and writes nothing to the
database.

Flags:

| flag | default | meaning |
| --- | --- | --- |
| `--runs N` | 20 | attempts, 1 to 500. 20 shows a tail without becoming load. |
| `--gap-ms N` | 50 | pause between attempts. Politeness, not measurement. |
| `--port N` | from compose | address a specific Postgres instead of the resolved one. |
| `--label TEXT` | none | what this run is, carried into the artifact. |
| `--json PATH` | none | write the machine artifact. Directories are created. |

What it resolves on its own, the same way main does: the config dir
(`VEX_CONFIG_DIR` when absolute, else `%APPDATA%\vex` on Windows), the password
at `local-infra\secrets\pg_password`, the published host port out of
`compose\docker-compose.yml`, and the fixed `127.0.0.1` / `vex` / `vex` triple.

### Reading the result

The last line is the verdict:

- `confirmed` - at least one connect reached 2000 ms, so a real `withClient`
  call would have FAILED there. The pool is justified with no further argument.
- `implicated` - no timeout, but a connect took 1000 ms or more. Per-call
  connects are a user-visible cost on this machine.
- `not-implicated` - every connect stayed under 1000 ms. Connect latency does
  not explain a black screen HERE. It says nothing about another machine, which
  is exactly why this has to run on the Windows box.

### Where the artifact lands, and where to send it

`--json` writes into `vex-app/scripts/probes/artifacts/`. That directory is
TRACKED on purpose: `agents_dm/` and `audit/` are git-ignored, and a
measurement that decides whether a shared pool ships is a reviewable evidence
artifact, not scratch output. It lives beside the script that produced it so a
future reader can re-run the exact instrument that made the number.

The artifact carries the samples, the summaries, the verdict, the resolved
target, and the environment (kernel, arch, node, docker version, Postgres
server version, UTC timestamp). It carries the password PATH, never the
password.

Hand it back by leaving the JSON file in that directory on the branch and
saying which label is which run.

### Already measured on Linux

Two runs are committed in `artifacts/`, both `not-implicated`:

- `pg-connect-latency-wsl2-to-docker-desktop.json` - the stack on
  `127.0.0.1:27432`, which on this machine is the WINDOWS Docker Desktop
  Postgres seen through WSL2 mirrored networking. connect p50 7.9 ms, p95
  9.9 ms, max 17.3 ms.
- `pg-connect-latency-linux-isolated.json` - a throwaway container on Linux
  Docker Engine, torn down after the run. connect p50 13.9 ms, p95 26.3 ms,
  max 30.0 ms.

Neither is the Windows path a Vex.exe actually takes, which is why the Windows
run above is still required.

### Reproducing the isolated Linux baseline

```bash
CFG=$(mktemp -d /tmp/vex-probe-iso-XXXXXX)
mkdir -p "$CFG/local-infra/secrets"
node -e 'require("fs").writeFileSync(process.argv[1],require("crypto").randomBytes(32).toString("base64url"),{mode:0o600})' \
  "$CFG/local-infra/secrets/pg_password"
NAME="vex-probe-iso-$(node -e 'process.stdout.write(require("crypto").randomBytes(6).toString("hex"))')"
docker run -d --name "$NAME" --label ai.projectvex.probe="$NAME" \
  -e POSTGRES_DB=vex -e POSTGRES_USER=vex \
  -e POSTGRES_PASSWORD="$(cat "$CFG/local-infra/secrets/pg_password")" \
  -p 127.0.0.1:55432:5432 pgvector/pgvector:0.8.2-pg18-trixie

VEX_CONFIG_DIR="$CFG" node scripts/probes/pg-connect-latency.mjs \
  --port 55432 --label linux-isolated --json scripts/probes/artifacts/run.json

docker rm -f "$NAME" && rm -rf "$CFG"
```

The name prefix and the label exist so a leak is identifiable and removable BY
NAME. Never clean up with `docker prune` or any bulk removal: this machine also
hosts the owner's live Vex stack, an eval database and unrelated projects.

The port is deliberately not 27432. The same rule the e2e stack fixture
enforces (`e2e/fixtures/vex-stack.ts`, `assertIsolatedPgPort`) applies here: an
isolated probe must never bind or address the developer's real compose
Postgres.

## The rest of the owner-machine probe pack

Scripts for these belong to later rounds; this section exists so the pack is
one list rather than five scattered decisions.

| probe | question it answers |
| --- | --- |
| `realpath-case` | does a Windows path round-trip through the projects root keep the case the user typed, or does the filesystem hand back a different one that then fails an equality check? |
| `reserved-slug` | which project slugs Windows refuses outright (`CON`, `PRN`, `AUX`, `NUL`, `COM1`..`LPT9`, trailing dot or space), so the slug validator rejects them before a directory claim fails halfway. |
| `rename-busy` | what a rename or delete actually returns while another process holds a handle open (`EBUSY`, `EPERM`, `EACCES`), which decides whether the project rename path can be retried or must fail closed. |
| `trash-on-unc` | whether move-to-trash works on a UNC or mapped network path, or whether the delete path has to refuse those roots by name. |
| `pty via probe:node-pty` | the EXISTING `scripts/probe-node-pty.mjs`: does the packaged native module load and spawn a shell on the owner's machine and architecture. |

## Adding a probe here

Keep the pure parts (config resolution, statistics, thresholds, argument
parsing) exported and free of I/O, put the declarations in a sibling `.d.mts`,
and test them from `src/main/studio/__tests__/`. Vitest's `node` project
collects only under `src/main`, `src/preload`, `src/shared` and `src/pty-host`,
so that is where a suite over a `scripts/*.mjs` module has to live;
`bridge-freshness.test.ts` is the precedent.

If a probe restates a value the product owns, pin it with a drift test that
reads the real owner. `pg-connect-latency.mjs` restates `CONNECT_TIMEOUT_MS`,
the default port, the connection triple and the config-dir rules, and every one
of them is checked against its source in
`src/main/studio/__tests__/pg-connect-latency-probe.test.ts`.
