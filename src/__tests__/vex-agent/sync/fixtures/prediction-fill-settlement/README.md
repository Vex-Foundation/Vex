# Jupiter Prediction fill-settlement fixtures

Real, non-empty captures of the three-transaction lifecycle a Jupiter
Prediction sell/close actually has on Solana mainnet. They are the evidence
base for `src/vex-agent/sync/solana-prediction-fill-settlement.ts` and its test
`../../solana-prediction-fill-settlement.test.ts`.

## What was captured, and how

Two `agent_activity` rows (internally #42 `predict_sell`, #47 `predict_close`)
sat `pending` after the 2026-07-25 funded live gate: the transaction Vex
broadcast moved zero tokens, so the own-tx payout decoder correctly declined
and could never confirm them. Capturing what actually happened produced these
files.

| File | Source | Capture script |
| --- | --- | --- |
| `wallet-history.json` | `GET https://api.jup.ag/prediction/v1/history?ownerPubkey=…` | `agents_dm/verify/probe-prediction-provider-state.ts` |
| `tx-row4{2,7}-{create,fill,settle}.json` | Solana `getTransaction` (`encoding: jsonParsed`, `commitment: finalized`, `maxSupportedTransactionVersion: 0`) | `agents_dm/verify/capture-prediction-settlement-fixtures.ts` |

Captured 2026-07-26 against the configured mainnet RPC and the live provider.
Both scripts are read-only; neither signs or spends. Re-running either
regenerates these files verbatim.

## The lifecycle they prove

1. **create** — OUR transaction (the row's `tx_hash`). Zero token movement:
   in `tx-row42-create.json` the wallet's JupUSD balance is `271024` both pre
   and post. This is why the row could never self-confirm.
2. **fill** — a keeper moves JupUSD from the vault into an escrow ATA owned by
   the ORDER PDA (`tx-row42-fill.json`: escrow `0 → 4545860`). The wallet is
   not a party. Present in the provider's history as `order_filled`.
3. **settle** — ~2s later a keeper drains the escrow into the wallet's JupUSD
   ATA and closes the escrow (`tx-row42-settle.json`: escrow `4545860 → absent`,
   wallet `271024 → 4816884`). **Not in the provider's history at all** — it is
   reachable only via `getSignaturesForAddress` on the derived escrow ATA.

Escrow ATA = `getAssociatedTokenAddressSync(JUPITER_PREDICTION_PAYOUT_MINT,
orderPubkey, allowOwnerOffCurve = true)` — verified against both captures.

Proven amounts: row 42 `+4,545,860` JupUSD, row 47 `+4,160,120`, each equal to
the escrow debit in the same transaction.

## Why these are NOT sanitized

Every identity in these files is load-bearing evidence, and the cross-links
between files are exactly what the tests assert:

- the history event's `signature` must equal the row's `tx_hash`, which is the
  `create` capture;
- the escrow ATA is DERIVED from `orderPubkey`, so a substituted order key
  makes the derivation — the core proof — untestable;
- the mint must remain the real `JUPITER_PREDICTION_PAYOUT_MINT`, which the
  decoder asserts as a constant.

The content is public Solana mainnet ledger data plus a public provider read.
It contains no keys, no seed phrases, no signing material, and no private
data; the same wallet pubkey already appears in committed tests
(`jupiter-prediction-managed-execution.test.ts`,
`bridge-fee-solana-transfer.test.ts`).

`wallet-history.json` also records a shape worth remembering:
`pagination: {start: 0, end: 7, total: 14, hasNext: true}` — on `/history`,
`start`/`end` are **row offsets, not timestamps**, and one call returns a
single page.

## The DERIVED files

Both carry a `_derivedFixture` header stating their derivation. Everything else
in them is the untouched capture.

### `tx-row42-settle-decoy-escrow.json` — adversarial

The transaction that an owner-only proof accepts and an account-bound proof
must reject. Derived from `tx-row42-settle.json` by appending one account key
(index 14, plus its pre/post lamports so `accountKeys` stays index-aligned with
the balance arrays), removing the REAL escrow's pre-token-balance so the
derived escrow ATA is still *present* in the transaction — and therefore still
returned by `getSignaturesForAddress` — but moves nothing, and re-pointing that
same 4,545,860 JupUSD debit at the new account, which carries the **same
owner** (the order PDA). The wallet legs are untouched, so the credit is still
an equal +4,545,860.

An order PDA may legitimately own more than one token account for a mint, and
anyone may create another one with that owner. So `owner + mint` sums to
−4,545,860 against a +4,545,860 credit and looks like a perfect proof, while
the escrow we derived paid nothing. Pinned by the two adversarial cases in
`../../solana-prediction-fill-settlement.test.ts`.

### `tx-row42-create-with-loaded-addresses.json` — account-key duplication

It is `tx-row42-create.json` with
`meta.loadedAddresses` filled in from the entries its own `accountKeys` already
tags `source: "lookupTable"`, split by their `writable` flag. Every other byte
is the untouched capture, and the file carries a `_derivedFixture` header
saying so.

Why it exists: the capturing RPC returned the ALT-loaded keys inside
`accountKeys` but omitted `meta.loadedAddresses`. Providers that return **both**
are the case `resolveAccountKeys` must not double-count — appending
`loadedAddresses` to a jsonParsed `accountKeys` list that already contains them
put every ALT key at two indices and broke the invariant
`accountKeys.length === preBalances.length` (14 and 14 here). Pinned by
`../../solana-settlement-account-keys.test.ts`.
