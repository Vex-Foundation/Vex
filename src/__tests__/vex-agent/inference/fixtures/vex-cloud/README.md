# Vex Cloud `/v1/models` - recorded live response

## Provenance

| | |
|---|---|
| File | `v1-models.live-2026-10-20.json` |
| Source | `GET http://127.0.0.1:8787/v1/models` on a local VexVirtualsCompute gateway (commit `b44ff33`, phase 1a), registry joined with the live OpenRouter public catalogue |
| Captured | 2026-10-20, Vex Cloud phase 1b |
| SDK at use | `@openrouter/sdk@1.4.25` |
| Auth | **None.** The route is public; captured with plain `curl`. |
| Cost | Free - a read-only metadata GET. |

The whole response, unmodified (10 allowlisted models, the envelope
`data` / `total_count` / `links` included), so it replays through the SDK's
own inbound schema. Every row carries the fields the engine and the app read:
`reasoning.mandatory: true`, `supported_efforts` without `none` (Gemini Argon
starts at `medium`, DeepSeek lists `max`, `high`, `low`), a per-model
`default_effort`, `top_provider.max_completion_tokens`, `supported_parameters`
with `reasoning` and `tools`, and Vex Cloud prices (markup included).
