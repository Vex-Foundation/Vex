# Z500 Allocation-Sync Workflow

## Objective

Build an automated allocation-synchronization workflow on top of **PR #117**.

The workflow must keep the existing Indexify **Vex Agent Index** synchronized with the investable top 10 tokens from the **Ansem Z500**.

## Target Configuration

| Field | Value |
|---|---|
| Indexify Stack ID | `28440` |
| Stack slug | `vex-agent-index` |
| Source | [Ansem Z500](https://ansem.io/z500) |
| Source universe | `Z500 Curated` |
| Schedule | Every day at `00:00 UTC` |
| Target token count | `10` |
| Weight per token | `10%` |

## Allocation Methodology

For each scheduled evaluation:

1. Load the latest machine-readable data for the **Z500 Curated** universe.
2. Rank tokens by market capitalization in descending order.
3. Identify every token exclusively by its **Solana mint address**.
4. Starting from the highest-ranked token, select the first 10 tokens that are both:
   - supported by Indexify; and
   - tradable on Indexify.
5. Skip unsupported or untradable tokens and continue down the ranking until 10 eligible tokens have been selected.
6. Assign each selected token an equal weight of `10%`.
7. If fewer than 10 eligible tokens are available, leave the existing Stack allocation unchanged.

## Source Data Requirements

- Use a machine-readable Ansem data feed.
- The current Ansem frontend uses the `/api/coins` endpoint.
- Do not scrape rendered HTML.
- Do not bypass authentication, authorization, rate limits, or other access controls.
- Treat the source snapshot as unusable when it is unavailable, stale, incomplete, malformed, or otherwise invalid.

## Indexify Provider Changes

Extend the Indexify provider introduced in **PR #117** so it can:

- read the current allocation for Stack `28440`;
- read the Stack's allocation version history;
- verify token support and tradability by exact Solana mint address; and
- update Stack `28440` through:

```text
stack_info.php?action=edit_allocation
```

### Provider Constraints

- Do not create a new Stack.
- Do not execute trades.
- Do not call:

```text
txn.php?action=rebalance
```

- Do not add scheduling or timer logic inside the Indexify provider.
- Never log, persist in plaintext, or expose the Indexify API key.

## Allocation Comparison and Mutation Rules

Before sending an allocation update:

1. Read the current Stack allocation.
2. Normalize both the current and desired allocations by exact mint address and weight.
3. Compare the normalized allocations without relying on token symbols, names, or ordering.
4. If the allocations are identical, do not send an update request.
5. If the allocations differ, update the existing Stack through `stack_info.php?action=edit_allocation`.
6. After a successful mutation, read the resulting allocation and version information needed to confirm the applied state.

## Recurring Automation Requirements

Use Vex's existing recurring automation layer rather than introducing a timer inside the Indexify provider.

The automation must:

- run every day at `00:00 UTC`;
- persist its schedule across application restarts;
- persist execution state across application restarts;
- detect a missed schedule window after restart or downtime;
- perform exactly one catch-up evaluation using the latest valid source data when a scheduled run was missed;
- prevent concurrent execution for the same schedule window; and
- prevent duplicate evaluation or mutation for the same schedule window.

## Failure-Safety Requirements

The workflow must fail without changing the Stack when:

- the source is unavailable;
- the source snapshot is stale;
- the source data is incomplete;
- the source data is malformed or invalid;
- token mint identity cannot be established reliably;
- Indexify support or tradability cannot be verified by exact mint; or
- fewer than 10 eligible tokens are available.

A failed evaluation must not partially update the allocation.

## Uncertain Mutation Reconciliation

Never blindly retry an allocation update whose outcome is uncertain.

An outcome is uncertain when, for example, the update request times out, the connection closes before a definitive response is received, or the response cannot be interpreted reliably.

When an update outcome is uncertain:

1. Do not immediately retry the mutation.
2. Read the current Stack allocation.
3. Read the allocation version history.
4. Determine whether the desired allocation was already applied.
5. Mark the run successful if the desired allocation and corresponding version are confirmed.
6. Retry only when the read-back evidence proves that the mutation did not take effect and retrying is safe.
7. If the outcome still cannot be established, fail the run without sending another update.

## Concurrency and Idempotency

Use a persistent idempotency identity for each schedule window, such as the scheduled UTC timestamp.

The workflow must ensure that:

- only one execution can own a given schedule window;
- multiple workers cannot update the Stack concurrently for the same window;
- a restart does not cause a completed window to run again;
- catch-up processing cannot duplicate an already completed run; and
- repeated evaluation of the same desired state does not produce another Indexify mutation.

## Run Records and Audit Trail

Persist a record for every scheduled or catch-up run.

Each run record must include:

- schedule-window identity;
- scheduled time and actual start time;
- completion time;
- trigger type: `scheduled` or `catch-up`;
- source snapshot metadata;
- source snapshot or an immutable reference to it;
- source freshness and validation result;
- ranked candidate mints;
- selected mints;
- excluded mints;
- exclusion reason for each excluded mint;
- previous allocation;
- desired allocation;
- whether a mutation request was sent;
- mutation reconciliation details, when applicable;
- previous allocation version;
- resulting allocation version;
- final status; and
- sanitized error details, when applicable.

The Indexify API key must never appear in logs, run records, error messages, fixtures, or test snapshots.

## Required Tests

Add focused tests covering the following behavior.

### Ranking and Selection

- Tokens are ranked by market cap in descending order.
- Mint addresses, not symbols or names, are used as token identity.
- Unsupported tokens are skipped.
- Untradable tokens are skipped.
- Lower-ranked eligible tokens backfill excluded higher-ranked tokens.
- Exactly 10 eligible tokens receive equal `10%` weights.
- Fewer than 10 eligible tokens leave the existing Stack unchanged.

### Allocation Synchronization

- Identical current and desired allocations produce no mutation request.
- Allocation comparison is insensitive to entry ordering.
- An allocation change updates Stack `28440` through `stack_info.php?action=edit_allocation`.
- The workflow never creates a new Stack.
- The workflow never calls `txn.php?action=rebalance`.
- The workflow never invokes any wallet-rebalance or trading endpoint.

### Scheduling and Persistence

- The workflow is scheduled daily at `00:00 UTC`.
- The schedule persists across application restarts.
- Execution state persists across application restarts.
- One missed run produces exactly one catch-up evaluation.
- A completed window is not rerun after restart.
- Concurrent workers cannot execute the same schedule window.
- Duplicate triggers do not produce duplicate updates.

### Failure Handling

- Unavailable source data causes a no-change failure.
- Stale source data causes a no-change failure.
- Incomplete source data causes a no-change failure.
- Invalid source data causes a no-change failure.
- Ambiguous or invalid mint identity causes a no-change failure.
- An uncertain mutation response triggers allocation and version-history reconciliation before any retry decision.
- A confirmed already-applied mutation is not repeated.
- An unresolved uncertain mutation is not blindly retried.
- The Indexify API key is never written to logs or persisted run data.

## Acceptance Criteria

The implementation is complete when all of the following are true:

- [ ] The existing Stack `28440` is the only Stack affected.
- [ ] The workflow uses the `Z500 Curated` universe from a machine-readable Ansem feed.
- [ ] Tokens are ranked by descending market cap and identified only by Solana mint address.
- [ ] Unsupported or untradable tokens are skipped and backfilled from lower rankings.
- [ ] Ten eligible tokens are assigned equal `10%` weights.
- [ ] The Stack remains unchanged when fewer than 10 eligible tokens are available.
- [ ] Identical allocations produce no Indexify mutation request.
- [ ] Allocation changes use only `stack_info.php?action=edit_allocation`.
- [ ] No trading, wallet-rebalance, or `txn.php?action=rebalance` call is possible from this workflow.
- [ ] The job runs daily at `00:00 UTC` through Vex's recurring automation layer.
- [ ] Schedule and execution state survive restarts.
- [ ] Missed runs receive exactly one catch-up evaluation.
- [ ] Concurrent and duplicate processing for the same schedule window is prevented.
- [ ] Uncertain mutations are reconciled through allocation and version-history reads before any retry.
- [ ] Every run has a complete, sanitized audit record.
- [ ] All focused tests pass.

## Non-Goals

This workflow is strictly for allocation synchronization.

It must never:

- create an Indexify Stack;
- execute a token trade;
- rebalance an Indexify wallet;
- call `txn.php?action=rebalance`; or
- invoke any other trading or wallet-rebalance endpoint.
