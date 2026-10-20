# OpenRouter `endpoints.list` — recorded live response

## Provenance

| | |
|---|---|
| File | `anthropic-claude-sonnet-4.5.json` |
| Source | `GET https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-4.5/endpoints` |
| Captured | 2026-10-20, during the `@openrouter/sdk` `1.1.13 -> 1.4.25` bump (first captured 2026-07-28 for the `0.12.79 → 1.1.13` bump, W2) |
| SDK at capture | `@openrouter/sdk@1.4.25` |
| Auth | **None.** The route is public; captured with a single unauthenticated GET, so no user key was sent. |
| Cost | Free — a read-only metadata GET. |

Recorded exactly as it came off the wire (raw bytes: snake_case, single line,
no trailing newline, unmodified), so it can be replayed through the SDK's own
inbound schema rather than through a hand-written approximation of it.

Why it was refreshed: SDK 1.4.25 made `native_tools` and `supports_tool_choice`
required on `PublicEndpoint`, and the 2026-07-28 capture predates both fields,
so it no longer parsed. The API sends both on every row of this capture.

## Sanitisation

Nothing was redacted, because nothing identifying is present: the payload is
OpenRouter's public model/endpoint catalogue (provider names, routing tags,
list pricing, context limits, uptime percentages). It carries no account, key,
user or transaction data. `latency_last_30m` / `throughput_last_30m` are `null`
here precisely BECAUSE the capture was unauthenticated — the API only returns
those to an authenticated caller. Do not "fix" those nulls by re-capturing with
a key; sending the user's key to a metadata endpoint is a separate, explicit
decision (`rules/06`).

## Why it exists

`rules/90`: *"Record a real provider response as a fixture the first time you
see one, and make it non-empty."* The bump moved us to schemas strict enough
that a missing field is a runtime rejection, not a typing nicety — during this
very change, absent `links` / `total_count` / `reasoning.mandatory` /
`system_fingerprint` each broke a test double that had encoded a subset the
older SDK tolerated. A recorded live payload is the guard against repeating
that: it fails loudly when a future SDK bump stops accepting what the API
actually sends.

This fixture is deliberately **non-empty** (7 endpoints) - an empty collection
would validate nothing about per-endpoint fields.

What the 2026-10-20 capture does NOT contain: every row reports
`uptime_last_1d = 100` (four rows have null 5m/30m windows), so there is no
unmeasured endpoint and no uptime variance on the 1-day window the runtime
ranks on. The real-data ranking assertion therefore pins the tag tiebreak;
uptime ordering and unknown-sorts-last are pinned by row-level tests.

## Consumers

- `../../openrouter-endpoints-fixture.test.ts` — replays it through a real SDK
  client and asserts the fields W3's provider selector depends on.
- `../../openrouter/endpoint-candidates.test.ts` - replays it through
  `loadEndpointCandidates` and pins the ranked order on the recorded data.

## Refreshing

Re-run the capture against the same URL and overwrite the file, keeping it raw
and unauthenticated. If the shape changed, update the consuming test in the
same commit and say what moved.
