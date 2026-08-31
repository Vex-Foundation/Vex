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

Probed live 2026-08-31 (sequential, read-only, no signature and no broadcast):
ONE `api.jup.ag/swap/v2/build` call and SIX Solana RPC reads against
`api.mainnet-beta.solana.com`. The `/build` request was SOL to USDC for
10,000,000 lamports, `platformFeeBps=25`, `tipAmount=1000000`,
`wrapAndUnwrapSol=true`, with a public exchange wallet as the taker. Total
elapsed for the six RPC reads: 428 ms.

### Installed packages, read from the worktree

| Package | Version |
| --- | --- |
| `@solana/web3.js` | 1.98.4 |
| `@solana/spl-token` | 0.4.14 |

Probed, not assumed: `SystemInstruction.decodeInstructionType` THROWS
(`Instruction type incorrect; not a SystemInstruction`) on an unknown
discriminant rather than returning a fallback, which is what makes the
fail-closed attribution branch reachable. `unpackMint`, `getAccountLenForMint`,
`ACCOUNT_SIZE` (165) and `ASSOCIATED_TOKEN_PROGRAM_ID`
(`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`) are all exported by
spl-token 0.4.14.

### What the `/build` response actually contained

| Fact | Measured value |
| --- | --- |
| Top-level keys | `inAmount`, `outAmount`, `otherAmountThreshold`, `swapMode`, `slippageBps`, `priceImpactPct`, `routePlan`, `computeBudgetInstructions`, `setupInstructions`, `swapInstruction`, `cleanupInstruction`, `otherInstructions`, `tipInstruction`, `addressesByLookupTableAddress`, `blockhashWithMetadata` |
| `setupInstructions` programs | ATA program, System program, SPL Token program, ATA program |
| Wrap instruction | System `Transfer` of EXACTLY `inAmount` (10,000,000) with the taker as the funding account |
| Tip instruction | System `Transfer` of EXACTLY `tipAmount` (1,000,000) from the taker, program id `11111111111111111111111111111111` (the System program, not a Jito program) |
| ATA creations | TWO, both `CreateIdempotent` (1-byte data `[1]`), both with the TAKER as payer: the wSOL account and the output account |
| Compiled message | 1 required signature, 11 static keys, 1 address-table lookup, 8 instructions, 577 serialized bytes |

The two taker-paid ATA creations are the load-bearing measurement of this
package. They are IN ADDITION to the treasury fee ATA `fee-swap.ts` splices in
itself, so the `ataRentLamports` field that quote already disclosed accounts for
at most one of up to three wallet-funded accounts. A guard built on that field
alone understates the debit by two account rents.

### Solana RPC facts

| Read | Result | What it settles |
| --- | --- | --- |
| `getFeeForMessage` on the EXACT compiled v0 message | 7,321 lamports | The unit is LAMPORTS, and the answer already contains the priority fee: the base fee for this message's single signature is 5,000, so 2,321 of it is priority. Adding `priorityFeeLamportsEstimate` on top would double-count. |
| `getFeeForMessage` on a one-signature, zero-lamport self transfer | 5,000 lamports | The measured absolute follow-up reserve (owner decision 2026-08-31), priced under the same fee schedule as the swap. |
| `getParsedTokenAccountsByOwner` filtered by MINT, `jsonParsed`, commitment `processed` | 23 accounts for one mint on one owner | A wallet can hold MANY accounts for one mint, so a spendability read must fold all of them, not just the associated one. |
| Parsed account shape | `parsed.type: "account"`; `parsed.info` keys `closeAuthority`, `isNative`, `mint`, `owner`, `state`, `tokenAmount`; `state` is the STRING `"initialized"`; `tokenAmount.amount` is a decimal STRING; `account.data.program` is `"spl-token"`, `account.owner` is the token program id | The frozen flag lives at `parsed.info.state`, as a state NAME, not a boolean: `initialized` versus `frozen`. Any other name is unknown state and fails closed. |
| `getMinimumBalanceForRentExemption(165)` | 2,039,280 lamports | The rent one classic SPL token account costs the wallet that funds it. |
| `getBalance(owner, "processed")` | answered, integer lamports | `processed` is reachable and is the commitment this lane reads at: it is the only one that reflects the wallet's newest, not-yet-confirmed activity, which is what contract C2.4 requires of a spend-time read. Solana has no `pending` block tag; `processed` is what the observation reports as `pending`. |

### Decisions these measurements forced

1. The native debit is read OFF THE MESSAGE, not assembled from quote fields.
   The principal, the tip and every account rent are message-level
   instructions, so decoding them is the only derivation that cannot drift
   from what the wallet is charged, and it removes both double-count risks at
   the source.
2. `CreateIdempotent` is emitted whether or not the account exists (the probed
   taker already held both), so the guard READS the target account: charging
   rent for an account that exists would refuse solvent wallets on every swap.
3. `getAccount().isFrozen` from `shared/solana-account.ts` was NOT used. It
   reads ONE account and decodes raw bytes; the measured reality is many
   accounts per mint and a `jsonParsed` state name, and the spendability
   question needs the spendable/frozen/unreadable SPLIT across all of them.
   `balances/read-wallet-balances.ts`'s `projectTokenAccounts` was not reused
   either: it answers what a wallet HOLDS and deliberately counts frozen atoms
   as held, which is the opposite policy from spendability.
4. A Token-2022 associated account is sized from its own mint
   (`unpackMint` plus `getAccountLenForMint`), never from the classic 165
   bytes, and a mint that cannot be decoded is unattributable rather than
   guessed.

### Declared limit

Attribution sees MESSAGE-LEVEL instructions. A program invoked by the message
can move lamports out of the signer through a System CPI that never appears as
its own instruction, so the attributed figure is a lower bound on the debit and
the guard's job is to make every visible debit explicit and REFUSE what it
cannot decode. The measured follow-up reserve is the margin that keeps the
wallet able to act after an under-observed swap. Proving the CPI-level debit
would require simulating the transaction, which an owner decision removed from
this signing path on 2026-07-25.

---

## WP2-E0: shared EVM spendability substrate

Everything below was measured from this machine on 2026-08-31, sequentially,
read-only: no transaction was signed and none was broadcast. The wallet used
for the balance reads is the owner's live address, referred to here as "the
live address"; the probe scripts took it from an environment variable so it is
not written into the repository.

### 1. viem 2.54.3, probed in `node_modules`

**1.1 `signTransaction` (wallet action) ALWAYS asks the node for the chain id.**
`viem/_esm/actions/wallet/signTransaction.js` calls
`getAction(client, getChainId)` unconditionally, before it reaches the local
account's signer, and `getChainId` issues a real `eth_chainId`
(`actions/public/getChainId.js`). Consequence for the pre-sign fence: on the
EAGER arm exactly one provider round trip sits between the last pre-sign
callback and the signature, and it belongs to viem. The DEFERRED arm signs
offline and has none.

**1.2 `prepareTransactionRequest` does NOT verify the node's chain id when a
`chain` is supplied.** Its inner `getChainId` returns `chain.id` directly
(`viem/_esm/actions/wallet/prepareTransactionRequest.js`, the `if (chain)
return chain.id` branch) and only falls through to `eth_chainId` when no chain
is given. Consequence: the eager arm's post-gate `eth_chainId` is also the ONLY
place the node's identity is checked against the chain the request was prepared
for. Removing that call (by signing offline on the eager arm too) would close
the fence and drop that check in the same move, so it is a decision for the
coordinator, not a builder - recorded as a residual risk in the E0 report.

**1.3 `getBalance` has no per-request cancellation seam.**
`viem/_esm/actions/public/getBalance.js` calls `client.request` with no options
argument, and `GetBalanceParameters` carries only `address` plus one of
`blockNumber` / `blockTag` / `blockHash`. `readNativeBalance` therefore accepts
a block tag and NO `AbortSignal`: a signal passed there would be silently
ignored, and the read is bounded by the transport timeout instead.

**1.4 `readContract` forwards `blockTag` (and `requestOptions.signal`) to
`call`.** Confirmed by the live reads in section 3, which returned the same
figure at both tags and were rejected by no endpoint.

**1.5 viem's own OP-stack `estimateL1Fee` serializes the transaction UNSIGNED**
with stub fee values (`viem/_esm/op-stack/actions/estimateL1Fee.js`). Vex does
not copy that: `l1-data-fee.ts` serializes with an all-`ff` stub signature, so
the bytes priced are as long as the bytes the chain will post. An unsigned
serialization understates the payload by ~67 bytes, which is a rounding detail
on a display estimate and a shortfall inside a reserve.

### 2. Per-chain measurements, every EVM chain the swap venues serve

The chain set is KyberSwap's aggregator registry (`tools/kyberswap/chains.ts`),
which contains Robinhood 4663 and is a superset of Uniswap's verified
deployments. Endpoints are the repository's own configured RPCs
(`tools/kyberswap/evm/config.ts` `DEFAULT_RPC`; `evm-chains/registry.ts` for
4663). Six calls per chain: `eth_chainId`, `eth_getBalance` at `pending` and
`latest`, `eth_getBlockByNumber` at both tags, `eth_getCode` at the OP-stack
predeploy, `eth_gasPrice`; plus `eth_call` of `balanceOf` at both tags,
`getL1Fee` over a 118-byte payload where the predeploy has code, and two
`eth_estimateGas` calls (empty and 118-byte self-call).

Every chain accepted the `pending` tag on both `eth_getBalance` and `eth_call`.
None rejected it at the method level, so the `pending`-first policy is
reachable everywhere Vex swaps today. The balances matched `latest` because the
live address had nothing in flight; what a `pending` read SUBTRACTS could not
be proven without broadcasting, which this package does not do. The pending
BLOCK column is the honest proxy: a node that exposes a pending block one above
head maintains a distinct pending state, a node whose pending block equals head
does not, and a node returning null exposes none.

| chain | id | `pending` bal | `latest` bal | pending block vs head | `eth_call` @pending | OP oracle code | `getL1Fee` (118B) | `eth_gasPrice` wei | estimateGas empty / 118B |
|---|---|---|---|---|---|---|---|---|---|
| ethereum | 1 | ok | ok | +1 | ok | none | n/a | 125388484 | 21000 / 26062 |
| optimism | 10 | ok | ok | equal | ok | 2055 bytes | 1953607235 | 1004105 | not probed |
| bsc | 56 | ok | ok | null | ok | none | n/a | 50000000 | 21000 / 26062 |
| unichain | 130 | ok | ok | +4 | ok | 2059 bytes | 1044420400 | 1500000 | not probed |
| polygon | 137 | ok | ok | +4 | ok | none | n/a | 274176787041 | 21000 / 26062 |
| monad | 143 | ok | ok | equal | ok | none | n/a | 102000000000 | 21000 / 25873 |
| sonic | 146 | ok | ok | equal | ok | none | n/a | 55100000000 | 21000 / 25720 |
| hyperevm | 999 | ok | ok | null | ok | none | n/a | 165744767 | 21000 / 23224 |
| ronin | 2020 | ok | ok | +2 | ok | 2059 bytes | 847709703 | 21000000000 | not probed |
| megaeth | 4326 | ok | ok | null | ok | 2059 bytes | 404228087 | 1000000 | not probed |
| robinhood | 4663 | ok | ok | +5 | ok | none | empty (`0x`) | 300105264 | 21000 / 23224 |
| mantle | 5000 | ok | ok | +2 | ok | 2055 bytes | 37720124375 | 50034526880 | not probed |
| base | 8453 | ok | ok | +1 | ok | 2055 bytes | 1373207605 | 6000000 | 21000 / 26062 |
| plasma | 9745 | ok | ok | +1 | ok | none | n/a | 190445220 | 21000 / 26062 |
| arbitrum | 42161 | ok | ok | equal | ok | none | empty (`0x`) | 20138000 | 21737 / 24175 |
| avalanche | 43114 | ok | ok | +1 | ok | none | n/a | 91073859 | 21000 / 23224 |
| linea | 59144 | ok | ok | +1 | ok | none | n/a | 127466184 | 21000 / 26062 |
| berachain | 80094 | ok | ok | +1 | ok | none | n/a | 22300000000 | 21000 / 26062 |

Notes the venue adapters must not lose:

- **`pending` is accepted everywhere, but four chains have no pending state to
  speak of.** Arbitrum, Optimism, Sonic and Monad answer `pending` with the
  head block; BSC, HyperEVM and MegaETH expose no pending block at all. On
  those endpoints a `pending` balance IS a `latest` balance, so the protection
  against a wallet's own in-flight spending comes from Vex's own nonce owner
  and durable allocation, not from the tag. The tag policy does not change:
  asking for `pending` costs nothing and is honoured where it exists.
- **The L1 fee is not an OP-stack question, it is a per-chain measurement.**
  Ronin and MegaETH are not usually described as OP-stack chains and both
  answer `getL1Fee` with a real non-zero figure, so both are charged. Arbitrum
  and Robinhood carry code at no such predeploy and their posting cost is
  inside the gas UNITS instead: Arbitrum's EMPTY self-transfer estimate is
  21737 gas, 737 above the EVM intrinsic 21000. That is why the capability
  table has three mechanisms and why an unmeasured chain refuses.

### 3. Live smoke through the real modules

`observeErc20SourceBalance`, `observeNativeSourceBalance`, `estimateL1DataFee`,
`priceFollowUpReserve` and `computeSwapNativeDebit` were driven end to end over
a real viem client against two chains, one per L1-fee mechanism.

**Base (8453), `op_stack_oracle`.** USDC
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) at `pending`:
`balanceRaw "403952"`, `decimals 6`, `balance "0.403952"`, `blockTag "pending"`;
the same at `latest`. Native: `7145154469599355` wei, `0.007145154469599355`.
`eth_gasPrice` 6000000 wei. `getL1Fee` through the module, over the signed-length
serialization of a 210000-gas call: 1799567501 wei. Reserve: estimated 21000 gas
plus its own 1799567501 wei L1 fee. Total for one swap leg plus reserve:
1389599135002 wei, itemized per leg.

**Robinhood (4663), `in_gas_estimate`.** WETH at `pending` and `latest`:
`balanceRaw "0"` both, `decimals 18`. Native: `13599344301992215` wei.
`eth_gasPrice` 306120000 wei. L1: `priced`, mechanism `in_gas_estimate`,
`additionalWei 0` - the oracle is not consulted at all on this mechanism, so a
stray contract at that address could not double-charge. Reserve: estimated
21200 gas (above the 21000 intrinsic, which is why the reserve is measured and
not assumed). Total 70774944000000 wei.

### 4. Declared limits of these measurements

1. **What `pending` subtracts was not proven.** Doing so requires a wallet with
   an unconfirmed transaction, i.e. a broadcast, which this package does not
   perform. What IS proven: the tag is accepted on every chain, and which
   chains maintain a distinct pending state.
2. **`getL1Fee` was probed with a 118-byte payload and, in the live smoke, with
   a real serialization.** The oracle's scalars move with L1 conditions, so the
   figures above are a snapshot; the CODE never caches them and re-reads per
   transaction.
3. **`estimateGas` deltas were not collected for the six oracle chains**
   (marked "not probed"): their mechanism is decided by the oracle answering,
   so the gas-unit comparison would not change any row.
4. **The eager arm's residual `eth_chainId`** (1.1 and 1.2) is measured and
   pinned by a test, not closed. Closing it means signing offline on the eager
   arm too, which also removes viem's only node chain-identity assertion; that
   trade is named in the E0 report for the coordinator.
