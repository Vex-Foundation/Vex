# Ansem Z500 — Ranking Feed Client

> Read-only client for `ansem.io/api/coins`, the machine-readable feed behind
> the Z500 allocation-sync workflow (`sync/z500-allocation-sync`,
> spec: `indexiy-ansem.md`). Fetch one document, validate it hard, or name
> exactly why it is unusable.
>
> **Last updated: 2026-08-28 (initial integration)**

## Access posture

The workflow spec forbids bypassing authentication, rate limits, or other
access controls. Measured 2026-08-28: **ansem.io fronts every path with a
Cloudflare bot-management challenge for non-browser clients** (HTTP 403 +
"Just a moment…" HTML, browser-shaped headers included). This client:

- sends ordinary headers plus an OPTIONAL `Authorization: Bearer` from the
  `ANSEM_API_KEY` env (read per call, never cached/logged/echoed);
- classifies a challenge — or ANY HTML answer, whatever the status — as
  `ANSEM_UNAVAILABLE`, which the workflow turns into a fail-closed, no-change
  run;
- never solves a challenge.

Partner-side access is zero-code from here: an allowlist, or a feed token in
`ANSEM_API_KEY`, or a direct feed URL in `services.ansemApiUrl`.

## Unusable-snapshot vocabulary (drives the workflow's fail-closed branches)

| Condition | Error | Examples |
|---|---|---|
| unavailable | `ANSEM_UNAVAILABLE` | challenge page, HTML on 200, 5xx, network refusal |
| timeout | `ANSEM_TIMEOUT` | abort/deadline |
| malformed | `ANSEM_INVALID_RESPONSE` | non-JSON, no collection, non-object row, PRESENT-but-invalid mint, missing/non-numeric market cap |
| incomplete | `ANSEM_INVALID_RESPONSE` | zero rows, no universe markers anywhere, zero curated rows |
| stale | `ANSEM_STALE` | feed-declared timestamp older than 36h |

Two deliberate asymmetries, both documented in `validation.ts`:

- a row with an **absent** mint is reported (`rowsWithoutMint`) but not fatal —
  a mintless row can never be an Indexify candidate; a **present-but-broken**
  mint fails the snapshot, because that is corruption;
- a feed with **no timestamp at all** is not stale-by-absence; freshness is
  then bounded by fetch time, which the run record carries.

## Field-name recognition

The live feed's exact field spellings are UNVERIFIED (access is challenged),
so `validation.ts` recognizes a bounded set of spellings per concept — mint,
market cap, universe, symbol/name, collection key, feed timestamp — with
tolerant recognition and strict values. The first captured fixture after
access is granted either confirms or narrows the set; until then every run
fails closed, which is the spec's own posture.

## Files

```
constants.ts   — env name, endpoint, universe label, staleness bound, mint shape
types.ts       — AnsemCoin / AnsemSnapshot
validation.ts  — the unusable-snapshot gate (documented above)
client.ts      — fetch + classification; singleton getAnsemClient()
```
