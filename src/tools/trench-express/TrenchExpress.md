# Trench Express — P1 read client

Read-only REST client for the Trench Express bonding-curve token launchpad on
RBC (chainId 4663). This is the data/provider layer that the P1 agent read tools
and the P2/P3 phases import. It performs **no on-chain execution, no DB writes,
and no migrations** — those are later phases.

## What this module is

| File | Responsibility |
|------|----------------|
| `client.ts` | `TrenchExpressClient` + `getTrenchExpressClient()` singleton (keyed on config base URL). URL building, empty-body/not-found handling, page-walk. |
| `types.ts` | `TrenchToken` (bonding vs graduated discriminated union), `TrenchTrade`, `TrenchWalletStats`, request param types. |
| `validation.ts` + `validation/` | Zod validators (tolerant reader) over raw `unknown`. |
| `errors.ts` | `mapTrenchExpressError` / `mapTransportError` → `ErrorCodes.TRENCH_*`. |
| `constants.ts` | API bases, Diamond address, chainId, R2 image base, limit cap, endpoints. |
| `abi.ts` | Verified Diamond trading ABI fragments (shared infra for P2/P3). |
| `image-serving.ts` | `imageCid` → R2 webp URL (read-only; CID is never computed locally). |

## Endpoints (all keyless public GET; params are ONE url-encoded JSON blob)

| Method | Endpoint | Notes |
|--------|----------|-------|
| `getTokens({page,limit,status,sort})` | `/api/tokens` | `status`: `curve`\|`launched`\|`all` → API boolean `launched`. `sort`: `time`\|`price`\|`bump`. `limit` clamped to 30. |
| `getToken({token}\|{symbol})` | `/api/token` | by address OR symbol. Returns `null` on not-found. |
| `search({search,limit})` | `/api/search` | rows carry an extra `_id` (first 12 bytes of the address). |
| `getTrades({token,page,limit})` | `/api/trades` | `page` REQUIRED (500 without). Items have NO `token` field; `type` 1=buy/-1=sell; `vol` is USD. |
| `getWalletStats(address)` | `/api/stats` | undocumented XP/faction layer. |
| `walkTokens(params, maxPages?)` | — | page-walk with dedupe-by-token-address, stops on a short page. |

`buildUrl` serializes params with **stable key order** so any future cache/dedupe
key over the URL is stable.

## Provider quirks (proven by the funded live probe + REST probe, 2026-07-31)

- **`launched` in a RESPONSE is a ms TIMESTAMP (number), present only on
  graduated tokens.** The request PARAM of the same name is a boolean. The types
  keep these strictly separate; a naive shared type is fatal.
- **Not found = HTTP 200 with an EMPTY body** (content-length 0), not `null`,
  `{}`, or 404. `res.json()` throws on it; the client reads the body as text and
  special-cases empty → typed not-found (`getToken`/`getWalletStats` → `null`).
- **Input mistakes = HTTP 500 `text/plain` with a leaked runtime exception**
  (Bun/JSC). `errors.ts` maps these to a safe `VexError` and never surfaces raw
  provider text beyond a bounded, single-line, ≤100-char snippet.
- **`links` is a 0-4 element string array** (empty strings when unset; our own
  create sent `[]`).
- **`price`/`supply` are JS floats in human units with NO decimals metadata and
  NO quote-asset identifier pre-graduation → DISPLAY-GRADE only.** Financial
  truth is on-chain (deferred to P2). See rule 90 (thousandfold-error trap).
- **There is NO `priceUsd`, NO `verified`, NO `reserveAsset`.** They do not
  exist on any endpoint. `vol` on `/api/trades` is the only USD figure available.
- **`holders`/`stats24h` are 0 on every token observed**, including actively
  traded ones — treat as unpopulated telemetry, never a decision input.
- **Server caches ~2s; `limit` is capped at 30.**

## Tolerant reader (rule 90)

Strict (a bad value throws): `token`, `price`, `supply`, `time`, and the whole
graduated block (`launched`/`pair`/`currency0`/`currency1`/`poolId`), plus a
trade's `type`/`tx`/`time`/amounts. Display-tolerant (missing/null → default):
`description`, `links`, `imageCid`, `holders`, `stats24h`, `ruggedFlagged`,
`creator`, `_id`, `maker`, and the entire wallet-stats object.

## The launch image is ON-CHAIN, and that is the whole reason for the 20 KB budget

Trench writes the image bytes INLINE in `create()` calldata (verified: a foreign
launch carries a 1.7 KB WebP in its calldata; the Diamond ABI types the
parameter as `bytes`). Every byte is gas the user pays, forever, on an
irreversible transaction. **20,480 bytes** is the hard ceiling
(`TOKEN_METADATA_IMAGE_ONCHAIN_MAX_BYTES` in `src/lib/token-metadata-limits.ts`);
the desktop ladder targets 20,000 so no `>` / `>=` disagreement between modules
can turn a landing into a failure.

**This budget binds Trench only** (owner decision 2026-08-19). pools.fun hosts
images off-chain and accepted a 2,104,822-byte PNG, measured. One locker now
serves both launchpads, so it stores the user's ORIGINAL bytes verbatim and
DERIVES a Trench copy:

| locker state | what Trench does |
|---|---|
| original already ≤ the budget | it IS the on-chain copy; `onchain_digest = digest`, no second file |
| ladder re-encoded it | the square ≤20 KB copy lives beside the original and carries its own digest |
| ladder exhausted | `onchain_* IS NULL`; every Trench entry point refuses `image_over_onchain_budget` BY NAME and says pools.fun can still launch it |

Consequences worth stating once:

- the Trench handlers consume `resolveLaunchImageOnchainBytes`, a seam separate
  from the pools lane's `resolveLaunchImageBytes`. Both fail closed, and the
  throw names which one is unmounted;
- **the C0 digest binding did not move.** It binds the digest of the bytes that
  go on-chain, which is what it always bound - migration 083 backfilled every
  pre-existing row with `onchain_* = byte_length/digest`, because those images
  already fit and their stored bytes ARE the on-chain bytes;
- the database no longer bounds the locker at 20,480, so
  `trench/handlers/launch/plan.ts` asserts the ceiling itself before composing
  calldata. That assertion is now the last gate, not a formality;
- `trench.launch_preview` REFUSES a copy-less image instead of degrading to the
  labelled empty-image estimate. A price for a launch that cannot happen answers
  a question nobody asked.

## Deferred (NOT in P1)

- **No throttle module.** DexScreener carries a token-bucket throttle; Trench
  Express has no documented rate limit and a ~2s server cache, so P1 ships
  without one. Add a copied/extracted throttle only if a rate limit is observed.
- **No WebSocket client.** REST-only in P1.
- **`imageCid` derivation is unknown** (not sha256/keccak of the raw bytes), so
  `image-serving.ts` only turns a provider-supplied CID into a URL — it is never
  computed locally.
- **`TokenLaunched` event** was named in the brief but is absent from the
  verified probe ABI bundle, so it is intentionally omitted from `abi.ts` rather
  than hand-written (an unverified event fragment must not enter a money path).
- Agent handlers, registry wiring, and on-chain execution (P2/P3).

## Fixtures

`src/__tests__/trench-express/fixtures/live-captures/` holds real captured bytes
under a `{endpoint, capturedAt, response}` envelope; the validators and client
are tested against them. See that folder's `README.md` for the naming law and
sanitization reasoning.
