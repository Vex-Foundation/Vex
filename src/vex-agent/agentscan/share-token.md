# Superboard share token (client)

One code identifies this install to AgentScan. The user pastes it into
Superboard; AgentScan verifies it and stores only its SHA-256 hash. The
plaintext crosses TLS once per registration attempt, inside the POST body,
never in a URL or a log line. This document states the client-side truths:
the frozen wire contract, the measured transport shapes, the state machine,
both procedures, rotation, the caches, the attempt memory, and the copy.

## 1. Deploy contract (frozen)

`POST {agentscan}/v1/agents/share-token`, `Authorization: Bearer
<ingest-token>`, JSON body, `redirect: "error"`, 15 s timeout. Response
bodies are JSON, except the 5xx HTML page some edges substitute (the client
treats any unparseable body as no code):

| outcome | HTTP | body shape | client reads |
|---|---|---|---|
| registered | 200 | `{ "status": "registered" }` | linked |
| unauthorized | 401 | `{ "error": { "code": "unauthorized" } }` | identity lost |
| quarantined | 403 | `{ "error": { "code": "quarantined" } }` | install paused |
| consent_revoked | 410 | `{ "error": { "code": "consent_revoked" } }` | access revoked |
| share_token_conflict | 409 | `{ "error": { "code": "share_token_conflict" } }` | slot holds a different key |
| rate_limited | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` | wait, then retry |

Replacements for this release:

- 404 `not_found` is gone: the route exists, so the client maps any other
  4xx to its `http` outcome instead of a dedicated case.
- 400 `share_token_conflict` is gone: a taken slot answers 409, and a body
  that fails validation answers 400 with a validation code.
- `replaces` is the rotation field: `{ "shareToken": "<new>",
  "replaces": "<old>" }`. A server that predates rotation answers 400; the
  client never sends the field until `GET /capabilities` advertises
  `share_token_rotation_v1`.

The deployed first-party contract was read on 2026-09-17 from the AgentScan
checkout's branch `feat/share-token-rotation` at `2ca2e6f` (PR #85):

- `apps/server/src/routes/agents.ts`: bearer ingest authentication, revoked and
  quarantined guards, rate limiting, body validation, server hashing, status
  mapping, and the bind log line.
- `packages/contract/src/share-token.ts`: strict `{ shareToken, replaces? }`
  object, `/^[A-Za-z0-9_-]{43}$/` on both fields, `replaces` must differ from
  `shareToken`.
- `apps/server/src/repos/share-token-repo.ts`: without `replaces` the slot must
  be empty or already equal to the new hash; with it the slot must be empty,
  equal to the old hash, or already equal to the new one (a completed rotation
  retried); anything else, or a hash another agent owns, is a conflict.
- `apps/server/src/__tests__/integration/share-token-mint.int.test.ts`: plaintext
  request payload, hash-only storage, repeat success, and conflicting-token
  rejection.
- `apps/server/src/__tests__/integration/share-token-rotation.int.test.ts`:
  the old key 404s the moment the new one reads, a retried completed rotation
  is success without changing the slot, a stale `replaces` is refused, a
  rotation onto an empty slot succeeds, `replaces` equal to `shareToken` is
  `validation_failed`, and `GET /capabilities` advertises
  `share_token_rotation_v1`.

## 2. Transport classification (measured)

`fetchWithTimeout` wraps a rejected fetch in a `VexError` and preserves the
original rejection as the standard `cause` (attached non-enumerably, as
`new Error(msg, { cause })` does, so a serialized wrapper never carries the
undici error), so classification reads the cause chain, never the wrapper
message. Measured against a real `node:http`
server (Node 24.15.0, loopback, proxy bypassed):

| case | raw rejection | wrapped error | reason |
|---|---|---|---|
| closed port | `TypeError: fetch failed`, cause `Error: connect ECONNREFUSED 127.0.0.1:<port>` with `code: ECONNREFUSED` | `VexError` / `HTTP_REQUEST_FAILED` / `fetch failed`, cause chain intact | `network` (errno in the named set) |
| 302 with `redirect: "error"` | `TypeError: fetch failed`, cause `Error: unexpected redirect` (no code) | same wrapper shape as the closed port | `redirect` (pinned cause message) |
| hung response, 200 ms deadline | - | `VexError` / `HTTP_TIMEOUT` / `Request timed out after 200ms`, cause `AbortError` | `timeout` (wrapper code) |

The wrapped network and redirect shapes are byte-identical
(`VexError`/`HTTP_REQUEST_FAILED`/`fetch failed`); only the preserved
cause tells them apart. Anything else - no errno, no redirect marker, no
timeout code - is `unknown`. The `detail` string is the sanitized
`<name>: <message>` plus ` (<cause.code>)`, or ` (unexpected redirect)`
for the redirect case.

## 3. State machine

`share_token` is write-once; the candidate is write-once while a rotation
is in flight. Every row names its trigger, what leaves the process, and the
status-row sentence the user reads.

| row | state | trigger | sends | on success | on unknown | on refused | status row |
|---|---|---|---|---|---|---|---|
| A | missing | Generate | `{shareToken}` (freshly minted) | registered | B | C | `Linking to AgentScan...` while in flight |
| B | pending, quiet | open Settings (no hold) | `{shareToken}` | registered | B | C | `Linking to AgentScan...` |
| C | pending, failed | Retry | `{shareToken}` (same token) | registered | C | C | the failure's primary sentence |
| D | registered + candidate | Retry / rotate | `{candidate, replaces}` | commit, new key | D (candidate kept) | D | failure primary, or `Linking the new key...` when quiet |
| E | candidate, `registered_at` cleared | Retry / rotate | `{candidate, replaces}` | commit, new key | E | E | same as D |
| F | registered, rotated | - | - | - | - | - | `New key linked. Paste it in Superboard.` once, then `Linked to AgentScan · new key since <time>` |
| G | registered, rotation available | Generate new key (dialog) | `{candidate, replaces}` | commit, new key | D | D | `Linking the new key...` while in flight |

## 4. Procedures (13 named steps)

`registerPersistedShareToken` (bind or rotation retry):

- R1: read state. No ingest token or no base URL returns `not_ready`
  without sending.
- R2: no token yet: mint one, `persistShareToken`, re-read so the
  write-once winner (mine or a racer's) is what gets sent.
- R3: a candidate is present: send `{shareToken: candidate, replaces:
  shareToken}`; on `registered`, `commitShareTokenRotation` fenced on the
  generation read in R1; a refused fence returns `not_ready`.
- R4: otherwise send `{shareToken}`; on `registered`,
  `markShareTokenRegistered` fenced on generation and token; a refused
  fence returns `not_ready`.

`rotatePersistedShareToken` (rotation start or retry):

- T1: no ingest token or no base URL returns `rotation_not_allowed /
  not_ready` without sending.
- T2: a candidate is present: retry it exactly like R3, never minting a
  second one.
- T3: no token, or the token never registered, returns
  `rotation_not_allowed / not_registered` without sending.
- T4: otherwise mint a candidate, `persistRotationCandidate`, re-read so a
  racer's persisted winner is what gets sent, then send like R3.

Shared, after any attempt that ran:

- S1: commit under the fence (generation + previous token + candidate).
- S2: record the attempt: `not_ready` and `registered` clear the record,
  `rotation_not_allowed` leaves it untouched, every other outcome stores
  its structured failure.
- S3: only `get` installs a hold; explicit calls record with none.
- S4: log exactly one line (section 7).
- S5: build the status the resulting state describes.

## 5. Rotation

A rotation mints a NEW key (the candidate), persists it before the first
request, and re-sends it verbatim on every retry until the server
acknowledges it. It starts only when the current key is registered and the
capability gate (section 9) has seen `share_token_rotation_v1`, rechecked
in the privileged handler - the renderer's hidden button is not
enforcement. The candidate is never abandoned by the user: an unknown
outcome may already have applied it server-side, and the server answers a
re-sent candidate for a completed rotation with success. The commit is
fenced on generation, previous token and candidate, so a late success for
a superseded rotation publishes nothing; `rotated_at` is stamped by the
commit transaction only. On success the section celebrates once: `New key
linked. Paste it in Superboard.` The celebration needs `rotatedAt` to have
moved from the value on screen when the dialog was confirmed: a refused or
fenced rotate answers `registered` with the same value and reads as plain
linked. Afterwards the linked row carries the rotation time: `Linked to
AgentScan · new key since <time>`, with the time from
`superboardAttemptTime(rotatedAt)` (section 10).

## 6. Caches

`readShareTokenRotationAvailability` caches per server fingerprint
(scheme, host, port, path - never credentials): a positive answer stands 6
hours, a negative or unknown answer 10 minutes, reusing the Lighter
cadence constants so both gates share one refresh rhythm. The unanswered
question (no base URL at all) is `unknown` and uncached. `GET
/capabilities` stays unauthenticated and unversioned.

## 7. Attempt memory

The main process keeps the last attempt in memory only: ISO time, outcome
kind, the structured failure, hold expiry, and whether the attempt
concerned a rotation. A record whose generation differs from the current
state is discarded on read. Holds apply to `get` only; explicit calls
always attempt:

| class | hold |
|---|---|
| `http` below 500 | until an explicit call or a generation change |
| `conflict`, `auth_lost`, `stopped`, `malformed_response` | until an explicit call or a generation change |
| `rate_limited` | `Retry-After`, else 30 s |
| `http` 500 and above | `Retry-After`, else 30 s |
| `transport` | 30 s |

One log line per attempt, through the module log:

`[agentscan:share-token] attempt action=<get|ensure|rotate>
outcome=<kind> status=<n|-> code=<code|-> transport=<reason|->
rotation=<true|false> generation=<n> durationMs=<n>
[reason=<not_registered|not_ready>] correlationId=<requestId>`

`rotation` states what went on the wire: every `rotate` action past the
refusal branch sent `replaces`, and so did any attempt with a candidate
before or after it (a successful fresh rotation clears the candidate on
both sides, which is why the action counts). A refused rotation
(`rotation_not_allowed`) is still logged, with its `reason`, because a user
pressed the button. The line never contains the token, the candidate, the
ingest token, or the base URL.

## 8. Rotation recovery

`resetForReRegistration` (the server forgot the install) clears only
`share_token_registered_at`: the token AND its rotation candidate survive,
because the in-flight rotation is still the rotation to finish - every
server slot it can meet answers success. `resetIdentityForRecovery` (this
install forgot itself) clears the token, both timestamps and the
candidate: the identity the candidate belonged to is gone.

## 9. Rotation capability advertisement

`GET /capabilities` returns `{ "capabilities": [...] }`, `{}` for an old
server, 404 for no route. The list containing the literal
`share_token_rotation_v1` is `available`; a list without it, or `{}`, is
`unavailable / server`; no response is `unknown / transport`, a
non-capability status is `unknown / refused`, no ingest token is `unknown /
no_ingest_token`. Only a real negative hides the button; every failed
lookup renders as `Checking whether AgentScan supports key rotation...`,
never as a verdict about the server.

## 10. Copy resolution

`superboardFailureCopy(failure, context)` resolves the status-row sentence
and the reassurance from the structured failure, never by parsing the
detail string. The context is `link` (first bind) or `rotation`.

The section renders exactly ONE `role="status"` live region, mounted
persistently; it holds the state dot and the primary sentence only, so a
screen reader hears one sentence per change. The reassurance (when the row
has one) and the mono detail line render once, directly under the live
region, outside it. No `useLiveAnnouncer` call exists in the section.

What the user sees, per failure kind:

| failure | primary (link) | primary (rotation) |
|---|---|---|
| `http` below 500 | AgentScan refused this key. | AgentScan refused the new key. |
| `http` 500 and above | AgentScan had a problem. | AgentScan had a problem. |
| `transport` timeout | AgentScan didn't answer in time. | AgentScan didn't answer in time. |
| `transport` network, unknown | Couldn't reach AgentScan. | Couldn't reach AgentScan. |
| `transport` redirect | The connection was redirected. | The connection was redirected. |
| `malformed_response` | AgentScan answered unexpectedly. | AgentScan answered unexpectedly. |
| `rate_limited` | Too many attempts. Wait a moment and try again. | Too many attempts. Wait a moment and try again. |
| `conflict` | This key couldn't be linked. | The new key couldn't be linked. |
| `auth_lost` | AgentScan isn't connected. Try again after it's linked. | AgentScan isn't connected. The new key waits until it's linked. |
| `stopped` consent_revoked | AgentScan access was revoked. | AgentScan access was revoked. |
| `stopped` quarantined | AgentScan paused this install. | AgentScan paused this install. |

Reassurance: in the `link` context, `Your key is valid; only the link to
AgentScan is missing.` for the rows where the key itself was never judged
(`http` 500 and above, every `transport`, `malformed_response`,
`rate_limited`); none for a refused key (`http` below 500). In the
`rotation` context those same rows, and a refused key, read `Your current
key still works.`, except the two unknown-outcome rows (`transport`
timeout and `transport` unknown), which read `Your current key may already
be replaced. Retry sends the same new key again.`: the server may have
applied the rotation before the answer was lost, and the old key would
then be dead for Superboard. The `conflict`, `auth_lost` and `stopped` rows carry
their own reassurance in both contexts (the conflict one differs by
context, and the rotation variant opens with `Your current key still
works.`); each names the ref to share when asking for help, or the
self-healing link for `auth_lost`. None names a control that does not
exist, and none makes a claim about anything beyond the link itself.

The mono detail line under the row reads `<Detail> · <time> · ref
<correlationId>`, with the time from `superboardAttemptTime`: `just now`
under a minute, `N min ago` under an hour, `N h ago` under a day, otherwise
the local wall-clock time as zero-padded 24-hour `HH:MM`.

While a Retry (or the rotation dialog's confirm) is in flight, the row
shows the flight instead of the failed sentence - `Linking to AgentScan...`
for a pending link, `Linking the new key...` once the key is registered -
and the reassurance and detail line step aside; the failed row and its
block return when the request settles with a failure. The mount fetch is
not such a flight. The row is the only in-flight indicator: the Retry
button reads `Retrying...`, the `Generate new key` trigger keeps its label
and is disabled, and the dialog's confirm label is static (the dialog
closes on click).

## 11. Migration and verification

Migration `163_agentscan_share_token_rotation.sql` (follows 162) adds
`share_token_rotation_candidate` and `share_token_rotated_at` to
`agentscan_reporting_state`. It is additive: older code ignores the
columns, so no reader-before-writer order applies. The packaged mirror
under `vex-app/resources/migrations/` is produced by
`vex-app/scripts/copy-migrations.mjs` (`build:assets` / `dev:assets`),
never edited by hand.

Verification for a change on this path:

- the client unit suites: `src/__tests__/vex-agent/agentscan/` and
  `src/__tests__/utils/http-signal.test.ts`;
- the real-Postgres reporting-repo suite:
  `src/__tests__/integration/agentscan/reporting-repo.int.test.ts`
  (`pnpm test:integration`);
- the upgrade matrix:
  `src/__tests__/integration/migrations/upgrade-matrix.int.test.ts`;
- the vex-app suites: `vex-app/src/main/ipc/__tests__/settings-superboard-key.test.ts`,
  `vex-app/src/renderer/features/appShell/screens/SettingsScreen/`,
  `vex-app/src/renderer/lib/api/`, `vex-app/src/shared/`;
- `pnpm --dir vex-app lint`;
- `pnpm check:em-dash`.
