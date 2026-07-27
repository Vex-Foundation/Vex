# DexScreener live response captures

Real, unedited responses from the public DexScreener REST API, used by
`../../dexscreener-live-shape.test.ts` so the validators are proven against
bytes the provider actually sent — never a hand-rolled object that would merely
re-assert the test's own assumptions.

These exist because two tools (`dexscreener.orders`, `dexscreener.boosts.top`)
failed on 100% of calls for months while the suite stayed green: every
DexScreener fixture in the tree was hand-invented, and each one encoded the
shape the code expected instead of the shape the API sends.

## Envelope

Each file is `{ endpoint, capturedAt, response }`. `response` is the response
body verbatim — field values are never edited, reordered, or trimmed. The
wrapper carries the provenance a future reader needs: which URL produced it and
when it was true.

These endpoints are keyless public GETs and return public promotional listings
only (token addresses, boost counts, order status). There is nothing to
sanitise: no wallet of ours, no personal data, no credential.

## Files

| file | endpoint | pins |
|---|---|---|
| `token-boosts-top-v1.json` | `GET /token-boosts/top/v1` | 30 rows, `totalAmount` 30/30, **`amount` 0/30** — the omission that made `boosts.top` throw on every call |
| `token-boosts-latest-v1.json` | `GET /token-boosts/latest/v1` | 30 rows, `amount` **and** `totalAmount` 30/30 — the sibling path that must keep working |
| `orders-v1-solana-boosted-token.json` | `GET /orders/v1/solana/3pRSpPyE6EYeapDm2Ui2GHnU2d1dYUQxzfaQaJTWfHZP` | object root `{orders,boosts}` with a **non-empty** boost-payment ledger (3 rows) |
| `orders-v1-solana-empty-boost-ledger.json` | `GET /orders/v1/solana/A55XjvzRU4KtR3Lrys8PpLZQvPojPqvnv5bJVHMYy3Jv` | same object root, 7 orders, **empty** ledger — the collection-empty case, kept alongside a non-empty one on purpose |

## What these captures established

- `/orders/v1/...` returns an **object** `{orders, boosts}`, not an array. Each
  `orders[]` row also carries `chainId` and `tokenAddress`; each `boosts[]` row
  is `{chainId, tokenAddress, id, amount, paymentTimestamp}`.
- `paymentTimestamp` is Unix epoch **MILLISECONDS** (13 digits, e.g.
  `1785076668204` → 2026-07-26). Read as seconds it lands in the year ~58,000.
- `top/v1` and `latest/v1` disagree about `amount`. Both amounts are
  display-only promotional credits, so the schema treats both as nullable
  rather than encoding either endpoint's current field set as a requirement.
- Every one of these feeds also sends `openGraph`, which no validator in the
  tree reads. Dropped silently, not a failure — recorded here so the next
  reader knows it was seen and not simply missed.

## Regenerating

```
curl -s <endpoint> | node -e 'const b=JSON.parse(require("fs").readFileSync(0,"utf8"));\
  console.log(JSON.stringify({endpoint:"<endpoint>",capturedAt:new Date().toISOString(),response:b},null,2))'
```

Refresh only with a reason. These are dated evidence, and a capture that no
longer shows `amount` missing from `top/v1` is itself a finding worth reading
before it is overwritten. The `orders` captures target specific tokens whose
promotional history is fixed in the past; the boost feeds are live rankings and
will differ on every capture, which is fine — the tests assert on shape and on
field presence, never on which token happens to be ranked first.
