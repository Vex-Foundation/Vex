# WP2 signing-path pin note, 2026-08-31

Every third-party behaviour the WP2 swap-eligibility work depends on, PROBED
against the installed package or the real service, not recalled. A claim
without a probe below is a claim nobody has checked.

Scope of this file: it accumulates across the WP2 packages. WP2-S filled its
own section; WP2-E0, WP2-K, WP2-U and WP2-J append theirs below, in the same
form (what was probed, how, what came back, what the code may therefore rely
on).

Environment: worktree `/home/kubas/Vex-worktrees/balance-reads`, branch
`fix/agent-balance-reads`, base `f76d6cbc`. Node v24.15.0.

---

## WP2-S: shared authority and trusted preview

### PostgreSQL (pgvector/pgvector:pg16, via testcontainers)

Probed with a throwaway script that started the same container image the
`test:studio-postgres` lane uses, ran the real `runMigrations()`, then queried
the catalog. Output is quoted verbatim.

**1. Migrations run one file per transaction.** Read from the runner
(`src/lib/db/migrate-runner.ts`, `applyMigration`): `BEGIN`, the whole file,
the `schema_version` insert, `COMMIT`, with `ROLLBACK` on any throw. A
`statement_timeout` and a `lock_timeout` are set on the connection first, and
an advisory lock serialises concurrent migrators.

**2. A DROP plus a FAILING ADD of the same CHECK leaves the constraint
intact.** This is the property migration 097 rests on: it drops the constraint
by name and recreates it widened, and there must be no window in which the
table is unconstrained. Probed by dropping the constraint and then issuing an
ADD that Postgres rejects, inside one transaction, then rolling back:

```
expected failure: column "nonexistent_column" does not exist
constraint present after rolled-back drop+failed-add: 1
```

So a partially applied 097 cannot exist. Either the widened constraint is
there or the original one is.

**3. After 097 the LIVE constraint is the eight-value list.** Read back with
`pg_get_constraintdef`:

```
constraint count: 1
definition: CHECK ((eligibility_kind = ANY (ARRAY['executable'::text,
  'unpriceable_output'::text, 'excessive_impact'::text,
  'oversize_snapshot'::text, 'provider_usd_invalid'::text,
  'insufficient_balance'::text, 'balance_unavailable'::text,
  'gas_reserve_insufficient'::text])))
schema_version max: 97
```

`constraint count: 1` matters on its own: the drop-and-recreate did not leave a
second constraint of the same name, so there is exactly one predicate deciding
what the column may hold.

**4. The behaviour, not just the text, is pinned by the lane.** Three added
cases in `src/__tests__/integration/repos/swap-prequotes-claim.int.test.ts`
insert each new value against the real database and read it back, one case
inserts a value outside the union and asserts Postgres rejects it, and one
re-checks a pre-097 value. Full lane: 311 passed.

**Not probed, and therefore not claimed.** The lock `ADD CONSTRAINT ... CHECK`
takes on a populated table, and how long its validation scan runs on a large
`swap_prequotes`. The table is per-install and small, and the statement runs
under the runner's `statement_timeout`, so this was left unmeasured rather
than guessed. If a future migration widens a CHECK on a table with real
volume, measure it there.

### zod 4.4.3 (installed version read from `node_modules/zod/package.json`)

The spendability codec (`quote-authority/spendability.ts`) is the boundary
between an in-process handoff and a JSONB column, so every property it leans on
was exercised against the installed build:

```
max rejects over-length:            false   (z.string().max(3) on "abcd")
unknown keys stripped by default:   {"a":"ab"}   (input {a:"ab", b:1})
literal mismatch rejected:          false   (z.literal("v1") on "v0")
z.number().int().min(0).max(36) on Infinity: false
                              on 0:  true
                           on null:  true  (via .nullable())
z.string().regex(/^\d+$/) on "-1":  false
                          on "007":  true
```

What the code may therefore rely on:

- **Bounds reject, they do not cut.** `.max()` fails the parse. That is what
  makes the persisted payload bounded WITHOUT ever shortening an address or a
  symbol, which the no-silent-cutting decree forbids.
- **Unknown keys are stripped on a plain object schema.** The value the
  recorder persists is the parsed object, so a venue cannot smuggle extra
  fields into `safety_detail` through this channel.
- **`z.literal` on `cardVersion` is a real version gate.** A preview written by
  an older build does not restore, and the card loses the line rather than
  rendering one whose meaning changed.
- **`.int()` rejects `Infinity`.** Contract C1.2's decimals guard survives the
  round trip through JSONB, not only the in-process `isTokenDecimals` call.

**Known, accepted, and not a defect:** `"007"` passes the atomic-integer
regex. Every comparison converts through `BigInt`, where `BigInt("007") === 7n`,
so a leading-zero value cannot change a money decision; it would only render
oddly on a card. No producer in this repository emits one.

### viem 2.54.3

`formatUnits` is reached only through `protocols/amount-display.ts`
(`formatRawAmount`), which contract C1.1 names the single owner of raw-to-human
conversion. WP2-S added no new call site and no second converter; the exact
behaviour of `formatUnits` is already pinned by that module's own suite. The
one property WP2-S depends on and re-asserted in its tests is that `0`
decimals is a legal scale and is not treated as missing.

### What WP2-S deliberately did NOT adopt from a reference

MetaMask's `requestBalanceWithFallback`
(`transaction-pay-controller/src/utils/token.ts:381-390`) catches a failing
`pending` balance query and RETURNS the `latest` value as if it were
equivalent. A `latest` balance does not subtract the wallet's own in-flight
transactions, so it can read as funds that are already spent. Contract C2.4
rejects that fallback: Vex retains the `latest` figure as advisory evidence on
the failed read and the verdict is `balance_unavailable`. Pinned by
`spendability.test.ts` ("a retained `latest` value stays advisory") and by the
refusal of an `ok` read whose tag is not `pending`.

---

## WP2-E0: shared EVM spendability substrate

Not yet written. Expected probes: the `blockTag` parameter's real behaviour on
each configured RPC provider (which ones answer `pending` at all), the L1
data-fee oracle's actual response shape per OP-stack chain, and viem's
gas-price field semantics for the 1559 legs.

## WP2-K: KyberSwap adapter

Not yet written. Expected probes: `/route/build` live behaviour with a retained
route and a selected wallet, and the transaction shape it returns.

## WP2-U: Uniswap adapter

Not yet written.

## WP2-J: Jupiter adapter

Not yet written. Expected probes: `getAccount().isFrozen` on a real frozen SPL
account, and the lamport figures the prepared fee-bearing swap already carries.
