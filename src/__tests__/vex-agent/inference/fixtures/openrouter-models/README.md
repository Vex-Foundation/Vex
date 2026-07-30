# OpenRouter `models.list` — recorded live response (row subset)

## Provenance

| | |
|---|---|
| File | `models-subset.json` |
| Source | `GET https://openrouter.ai/api/v1/models` |
| Captured | 2026-07-29, for the effective-context-limit clamp (P1.4) |
| SDK at capture | `@openrouter/sdk@1.1.13` |
| Auth | **None.** The route is public; captured with plain `curl`, no user key was sent. |
| Cost | Free — a read-only metadata GET. |

Rows are recorded **exactly as they came off the wire** (snake_case,
unmodified, every field kept), so they can be replayed through the SDK's own
inbound schema rather than through a hand-written approximation of it.

Unlike the sibling `openrouter-endpoints` fixture this is a **row subset**: the
live response carried 367 models / ~600 KB, which is noise in a repo. Four rows
were kept, chosen to span the range the clamp has to reason about:

| Model | `context_length` | Why it is here |
|---|---|---|
| `anthropic/claude-sonnet-4.5` | 1_000_000 | window far ABOVE the 256k configured default |
| `deepseek/deepseek-chat-v3.1` | 163_840 | window just below the default |
| `aion-labs/aion-3.0` | 131_072 | the 128k case P1.4 exists for |
| `openai/gpt-3.5-turbo-0613` | 4_095 | a genuinely tiny real-world window |

The envelope (`total_count`, `links`) is kept and `total_count` reflects the
subset, so the file stays a self-consistent response rather than a truncated one.

## Sanitisation

Nothing was redacted, because nothing identifying is present: this is
OpenRouter's public model catalogue (names, descriptions, list pricing, context
limits, supported parameters). It carries no account, key, user or transaction
data.

## Why it exists

`rules/90`: *"Record a real provider response as a fixture the first time you
see one, and make it non-empty."* The clamp reads ONE field — `context_length`
— out of an untrusted provider response, and every row above is a real value
that field actually takes today. A hand-written double would have encoded
whatever the author assumed the field looked like; this one fails loudly if the
API stops sending it, renames it, or starts sending it as a string.

## Consumers

- `../../openrouter-context-limit-clamp.test.ts` — replays these rows through
  the real `fetchModelInferenceConfig` and asserts the effective limit.

## Refreshing

Re-run `curl -sS https://openrouter.ai/api/v1/models` and re-cut the same four
model ids, keeping each row raw and unauthenticated. If a row's shape changed,
update the consuming test in the same commit and say what moved.
