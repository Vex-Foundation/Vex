# Superboard share-token contract

Settings generates one 32-byte random token encoded as 43 base64url characters.
The reporting singleton stores it write-once. There is no rotation or regenerate
IPC. Copy is enabled whenever a token exists, pending or registered, including
while a status refresh is in flight. A pending token is valid locally and can be
pasted into Superboard, but its AgentScan binding still needs to succeed. Settings
keeps the pending message and human-readable last error after copying.

## AgentScan request

`POST /v1/agents/share-token` authenticates with `Authorization: Bearer <ingestToken>`
and sends `Content-Type: application/json` with this body:

```json
{ "shareToken": "<43 base64url characters>" }
```

The plaintext crosses TLS once per registration attempt to AgentScan, the party
that verifies it. AgentScan computes SHA-256 over the UTF-8 bytes of the complete
token without decoding it and stores only that hash. The local plaintext copy
stays in this install's database. The share token appears only in the request
body, never the URL, request headers, logs, or returned error details. Requests
use the configured base URL and reject redirects. Production uses HTTPS; explicit
local HTTP base URLs remain supported. A successful response must contain
`{ "status": "registered" }`. Retries send the same plaintext token again.

The deployed first-party contract was read on 2026-09-09 from the AgentScan
checkout's `origin/dev` at `67fa173ad9ad22c0f1cee97abafdfc49eedc95ac`:

- `apps/server/src/routes/agents.ts`: bearer ingest authentication, revoked and
  quarantined guards, rate limiting, body validation, server hashing, and status mapping.
- `packages/contract/src/share-token.ts`: strict `{ shareToken }` object with
  `/^[A-Za-z0-9_-]{43}$/` validation.
- `apps/server/src/repos/share-token-repo.ts`: same hash is idempotent; a
  different hash or another agent's existing hash is a conflict.
- `apps/server/src/__tests__/integration/share-token-mint.int.test.ts`: plaintext
  request payload, hash-only storage, repeat success, and conflicting-token rejection.

The coordinator measured the production body mismatch on 2026-09-09. This client
adapts to that deployed contract; the coordinator runs the authenticated live
proof with the owner's install after the local checks.

Outcomes remain: 200 registered, 401 auth lost, 403 quarantined, 410 consent
revoked, 409 conflict, and 429 or 5xx retryable with Retry-After when present.
Other errors return invalid with sanitized detail. Sanitized details longer than
120 characters are replaced by an explicit omission notice retaining the HTTP
status when available, rather than silently returning a cut-off message.

## State authority and recovery

| Field | Owner | Invariant |
| --- | --- | --- |
| `share_token` | Reporting singleton | First persisted token wins; retries reuse it. |
| `registration_generation` | Reporting recovery transactions | Increments when identity or server registration resets. |
| `share_token_registered_at` | Reporting repo | Written only if the accepted token and generation still match. |
| `ingest_token` | AgentScan identity lifecycle | Authenticates the request; never exposed by Settings status. |
| Retry/refusal hold | Settings main IPC | Applies only to the generation that produced the outcome. |

Registration reads the token, credentials, and generation together. After a
write-once insert, it reads the winning snapshot again. A late successful
response cannot mark a different token or a newer generation registered.

Server-reset recovery clears the registration timestamp and preserves the token.
The next Settings read retries the same token and shows the pending linking
message until accepted; Copy remains available.
Existing identity-recovery behavior clears the abandoned identity's token and
registration timestamp; its in-flight requests cannot publish into the new
identity. This is recovery, not a user-visible rotation operation.

## Migration and verification

`153_agentscan_share_token.sql` adds the nullable token and registration timestamp
to `agentscan_reporting_state`. It follows main's migration 152; main's 107 is
reserved for launchpad family roles. Older code ignores the additive columns.
The applied migration remains unchanged. Its historical comment that plaintext
stays only on the install is superseded by the request and storage contract above.

Client tests pin the exact plaintext body, configured destination, rejected
redirects, status mapping, and absence of credentials from logs and details.
Settings section tests copy pending tokens while retaining pending/error copy.
Registration tests use
controlled promises to cover recovery while a request is pending. The reporting
repository suite exercises write-once storage, conditional registration, and
reset invalidation against real Postgres through `vitest/studio-postgres.config.ts`.
The upgrade matrix verifies fresh installs and supported upgrade paths.
