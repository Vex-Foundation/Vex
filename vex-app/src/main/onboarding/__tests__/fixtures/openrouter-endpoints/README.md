# OpenRouter `/endpoints` — recorded live response

## Provenance

| | |
|---|---|
| File | `deepseek-deepseek-v4-flash.json` |
| Source | `GET https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints` |
| Captured | 2026-07-29, for the availability-ranked provider picker |
| SDK at capture | `@openrouter/sdk@1.1.13` |
| Auth | **None.** The route is public; captured with plain `curl`, no user key was sent — the same keyless posture as `openrouter-public-catalog-client.ts` uses in production. |
| Cost | Free — a read-only metadata GET. |

The response is recorded **exactly as it came off the wire** (snake_case, every
field kept, envelope intact). Nothing is truncated: all 21 endpoints are here,
so the file is a self-consistent response rather than a subset.

## Why this model

`deepseek/deepseek-v4-flash` is the model in the live 429 evidence
(`agents_dm/runtime-harness/fixtures/openrouter-429-shape.json`): the pinned
`deepinfra/fp4` returned 429 on 4/4 concurrent turn-sized requests while
`baidu/fp8` served the identical request in the same minute. This capture is
the catalogue side of that same incident, and it shows the signal the picker
now ranks on — at capture time `deepinfra/fp4` reported the lowest 5-minute
uptime of the leading group (98.98%) against `baidu/fp8` at 99.93%.

## What it is non-empty for

`rules/90`: *"Record a real provider response as a fixture the first time you
see one, and make it non-empty."* This response exercises every field the
ranking rule reads, with real variance rather than an author's guess:

| Signal | What the capture proves |
|---|---|
| `uptime_last_5m` / `uptime_last_30m` / `uptime_last_1d` | populated on all 21 rows, unauthenticated — they are public data |
| `status` | takes **both** `0` and `-2` here, so the derank tier is exercised by real values |
| `latency_last_30m` / `throughput_last_30m` | `null` on all 21 rows, confirming the SDK's "authenticated only" note and why the ranking rule must not use them |
| `supported_parameters` | every row includes `tools`, so the tool filter passes them all through |

Rows whose uptime windows are `null` do **not** appear in this capture (this
model has traffic on every endpoint). That path is real — it was observed live
on `openai/gpt-oss-120b` and `qwen/qwen3-coder` the same day — and is covered
by unit tests that delete the field from a row of this shape.

## Sanitisation

Nothing was redacted, because nothing identifying is present: this is
OpenRouter's public endpoint catalogue (provider names, list pricing, context
limits, supported parameters, aggregate uptime). It carries no account, key,
user or transaction data.

## Consumers

- `../provider-endpoint-catalog-availability.test.ts` — replays this response
  through the real `loadProviderEndpointCatalog` and asserts the ranking,
  the suggestion, and the carried availability fields.

## Refreshing

Re-run the `curl` above unauthenticated and overwrite the file whole. Uptime
numbers move constantly, so the consuming test asserts ORDERING RULES and field
presence, not specific percentages — if a *shape* changed (a field renamed,
`status` gaining a member, uptime arriving as a string), update the consuming
test in the same commit and say what moved.
