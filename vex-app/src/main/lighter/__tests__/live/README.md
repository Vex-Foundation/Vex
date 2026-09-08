# Lighter live handler-chain harness

Four environment-gated tests that drive the REAL chain the desktop app runs for
a Lighter onboarding or trading action, against the owner's Robinhood Chain
account. Nothing here is a fixture: every step is the production function.

    prepare tool  ->  prepared-action follow-up  ->  approval enqueue
                  ->  the approval decision      ->  the resume tool
                  ->  reconciliation read

| step | file | flag |
| --- | --- | --- |
| 1 | `key-registration.test.ts` | `VEX_LIGHTER_LIVE_KEY_REGISTRATION=1` |
| 2 | `fee-authorization.test.ts` | `VEX_LIGHTER_LIVE_FEE_AUTHORIZATION=1` |
| 3 | `ioc-order.test.ts` | `VEX_LIGHTER_LIVE_IOC_ORDER=1` |
| 4 | `cancel.test.ts` | `VEX_LIGHTER_LIVE_CANCEL=1` |

With every flag unset the four files skip and the suite is green. Run the steps
ONE AT A TIME, in the order above: step 2 signs with the key step 1 registers,
and steps 3 and 4 trade under the fee authorization step 2 installs.

## Which production functions this drives

- `dispatchTool` (`@vex-agent/tools/dispatcher.js`) under the context the live
  turn loop builds (`buildToolContext`), so the prepare call is
  `modelOriginated` exactly as a model-emitted call is.
- `resolvePreparedActionFollowUp` + `dispatchPreparedActionFollowUp`
  (`engine/core/turn-loop-tool-batch/prepared-follow-up.ts`): the turn loop's
  own trusted hop, which synthesizes the confirm call and writes the approval
  through the shared enqueue transaction.
- `prepareApprove` (`engine/core/approval-runtime.js`): THE SAME FUNCTION the
  IPC approve handler calls (`main/ipc/approvals/decision.ts`,
  `registerApproveHandler`). The approved tool context is built inside it by
  `approval-runtime/post-tx/dispatch-approved/resumed-tool-context.ts` from the
  durable row. Nothing in this directory forges an approved context, writes an
  approval row by hand, or sets `approved` on a tool context.
- `discardContinuation`: the continuation `prepareApprove` returns is the
  AGENT'S OBSERVATION TURN (a model request). The IPC handler fires it in the
  background; the harness discards it, because it is not part of the money path.

`runTool` is never imported: it dispatches with `approved: true` and would skip
the approval gate this harness exists to prove.

## Environment

Every step needs all of these:

| variable | meaning |
| --- | --- |
| `VEX_DB_URL` | the Vex Postgres the app uses. The rows this harness writes ARE the evidence and are never deleted. |
| `VEX_LIGHTER_LIVE_ACCOUNT_INDEX` | must be `24226`. Any other value is refused before anything is prepared. |
| `VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE` | path to a file (mode 600) containing the Vex master password. A FILE, not a value, so the password never reaches a command line, a process listing or a shell history. |
| `VEX_LIGHTER_LIVE_EVIDENCE_DIR` | directory the run writes its JSON evidence into. |
| the step's own flag | see the table above. |

Optional:

| variable | meaning |
| --- | --- |
| `VEX_CONFIG_DIR` | absolute override for `~/.config/vex`. Required for the dry run; leave unset for a live run so the real vault, keystore and `config.json` are used. |
| `VEX_LIGHTER_SIGNER_BINARY_PATH` | signer-helper override, honoured because the harness runs unpackaged. Leave unset to use `vex-app/resources/lighter-signer/`. |
| `VEX_LIGHTER_LIVE_DRY_RUN` | `1` stops each test one step before the approval decision. See below. |

Two REAL side effects of the production unlock apply, and are not suppressed:
`adoptUnlockedPassword` strips managed secrets from the install's `.env` file
and reopens Studio MCP admission if a host is configured. That is what an
ordinary unlock does on this machine.

## The gates, in the order they fire

1. `VEX_LIGHTER_LIVE_EVIDENCE_DIR` must be set.
2. `VEX_LIGHTER_LIVE_ACCOUNT_INDEX` must be exactly `24226`.
3. `VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE` must name a readable, non-empty file,
   and the password in it must decrypt the vault.
4. The wallet resolved from that unlocked install must be
   `0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA`.

All four refuse with a `LiveHarnessRefusal` naming the exact mismatch, before any
tool runs, before the database is touched and before anything is signed.

## The exact commands

Run each from `vex-app/`. Replace the two paths; keep the password file at mode
600 and delete it when the run is finished.

Step 1 - register the trading key:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_KEY_REGISTRATION=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/key-registration.test.ts

Step 2 - authorize Vex trading fees:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_FEE_AUTHORIZATION=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/fee-authorization.test.ts

Step 3 - one IOC ETH-perp buy (the round-2 unit measurement):

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_IOC_ORDER=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/ioc-order.test.ts

Step 4 - place one resting GTT limit order and cancel it:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_CANCEL=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/cancel.test.ts

Everything skipped (the ordinary state, and what CI sees):

    cd vex-app && pnpm exec vitest run src/main/lighter/__tests__/live

## Dry-run mode, and its one honest limit

`VEX_LIGHTER_LIVE_DRY_RUN=1` runs the four gates, the prepare tool, the trusted
follow-up hop and the approval ENQUEUE, asserts the durable rows and the card
content, and then stops.

It stops BEFORE the decision, not after it, and that is a limitation of the
production design rather than a choice: `prepareApprove` commits the decision
and dispatches the approved resume tool in ONE call, so there is no supported
way to record an approval without also signing. A dry run that "decided" would
have signed. The row a dry run leaves behind is a real, undecided approval card;
it expires on its own (`APPROVAL_TTL_MS`, one hour) and nothing was signed.

Run a dry run ONLY against a throwaway install and a throwaway database:

    cd vex-app && \
    VEX_CONFIG_DIR=/tmp/vex-live-dryrun/config \
    VEX_DB_URL=postgres://.../throwaway \
    VEX_LIGHTER_LIVE_DRY_RUN=1 \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/tmp/vex-live-dryrun/password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/tmp/vex-live-dryrun/evidence \
    VEX_LIGHTER_LIVE_KEY_REGISTRATION=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/key-registration.test.ts

A dry run applies migrations (`runMigrations`) because a throwaway database has
none; a live run never does, because the app's own database is already migrated.

## Evidence

Each run creates `"$VEX_LIGHTER_LIVE_EVIDENCE_DIR"/<test>-<timestamp>/` and
writes one numbered JSON file per step as the step completes, so a run that dies
after a signature still leaves the transaction identity on disk. The same record
is printed to stdout as one JSON line.

Recorded per step: the resolved target (environment, account, wallet, session
id); the prepare output and the durable approval card; the approval decision and
the resume tool's own output; every reconciliation attempt, not only the last,
because on a money path the SEQUENCE of provider answers is the evidence; and
the provider's own read-back (Lighter `apiKeys` for step 1, `fees_status` for
step 2, the authenticated trades and positions for step 3, the inactive-order
read for step 4).

Never recorded: the master password, any private key, any signed payload, any
auth token.

## The database rows are the evidence

Nothing is deleted, and each run prints the SQL to read its rows back:
`approval_queue`, `approval_intents` and `messages` for the run's session, plus
the full intent rows by approval id.

## Two provider-depth gaps this harness has to work around

Both are in `protocols/lighter/projectors.ts`, which this lane does not own.

1. `projectMarketDetail` drops every margin field Lighter returns on
   `/api/v1/orderBookDetails`: `default_initial_margin_fraction`,
   `min_initial_margin_fraction`, `maintenance_margin_fraction`,
   `closeout_margin_fraction`, and also `mark_price` and `index_price`. Without
   them neither an agent nor this harness can decide whether a given collateral
   can carry a given notional, so the sizing gate reads the raw response through
   the production client instead.
2. `projectTrade` drops every ACCOUNT-RELATIVE field on a fill:
   `taker_position_size_before`, `taker_position_sign_changed`,
   `ask_account_pnl`, `bid_account_pnl`, `taker_fee`, `integrator_taker_fee`.
   Those are exactly the round-2 unit measurement, so step 3 records the
   authenticated response verbatim and the projected tool output beside it.
