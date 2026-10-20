# OpenRouter `/endpoints` — recorded live response

## Provenance

| | |
|---|---|
| File | `deepseek-deepseek-v4-flash.json` |
| Source | `GET https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints` |
| Captured | 2026-10-20, during the `@openrouter/sdk` `1.1.13 -> 1.4.25` bump (first captured 2026-07-29 for the availability-ranked provider picker) |
| SDK at capture | `@openrouter/sdk@1.4.25` |
| Auth | **None.** The route is public; captured with a single unauthenticated GET, no user key was sent - the same keyless posture as `openrouter-public-catalog-client.ts` uses in production. |
| Cost | Free — a read-only metadata GET. |

The response is recorded **exactly as it came off the wire** (raw bytes:
snake_case, single line, no trailing newline, every field kept, envelope
intact). Nothing is truncated: all 16 endpoints are here, so the file is a
self-consistent response rather than a subset.

Why it was refreshed: SDK 1.4.25 made `native_tools` and
`supports_tool_choice` required on `PublicEndpoint`, and the 2026-07-29
capture predates both fields, so it no longer parsed. The API sends both on
every row of this capture.

## Why this model

`deepseek/deepseek-v4-flash` is the model in the live 429 evidence
(`agents_dm/runtime-harness/fixtures/openrouter-429-shape.json`): the pinned
`deepinfra/fp4` returned 429 on 4/4 concurrent turn-sized requests while
`baidu/fp8` served the identical request in the same minute. This capture is
the catalogue side of that same incident: the original 2026-07-29 capture
(in git history) showed `deepinfra/fp4` with the lowest 5-minute uptime of the
leading group (98.98%) against `baidu/fp8` at 99.93%, and those values are
kept as literals in the consuming test's incident case. The 2026-10-20
capture no longer lists `deepinfra/fp4` (it lists `deepinfra/fp8`), so the
incident comparison is not reproducible from this file.

## What it is non-empty for

`rules/90`: *"Record a real provider response as a fixture the first time you
see one, and make it non-empty."* This response exercises every field the
ranking rule reads, with real variance rather than an author's guess:

| Signal | What the capture proves |
|---|---|
| `uptime_last_5m` / `uptime_last_30m` / `uptime_last_1d` | populated on all 16 rows, unauthenticated - they are public data |
| `status` | takes **both** `0` and `-2` here (`-2` on `open-inference/fp4`), so the derank tier is exercised by real values |
| `latency_last_30m` / `throughput_last_30m` | `null` on all 16 rows, confirming the SDK's "authenticated only" note and why the ranking rule must not use them |
| `perf_last_30m_by_workload` | absent on all 16 rows; the SDK documents it as authenticated-only, so the ranking rule does not use it |
| `supported_parameters` | every row includes `tools`, so the tool filter passes them all through |

Rows whose uptime windows are `null` do **not** appear in this capture (this
model has traffic on every endpoint). That path is real - it was observed live
on `openai/gpt-oss-120b` and `qwen/qwen3-coder` on 2026-07-29 - and is covered
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

Re-run the GET above unauthenticated and overwrite the file whole. Uptime
numbers move constantly, so the consuming test asserts ORDERING RULES and field
presence, not specific percentages — if a *shape* changed (a field renamed,
`status` gaining a member, uptime arriving as a string), update the consuming
test in the same commit and say what moved.
