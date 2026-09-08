# Superboard share-token contract

Settings generates one 32-byte random token encoded as 43 base64url characters.
The reporting singleton stores it write-once. There is no rotation or regenerate
IPC. Copy is enabled only for a token whose registration has succeeded.

## AgentScan request

`POST /v1/agents/share-token` authenticates with `Authorization: Bearer <ingestToken>`
and sends `Content-Type: application/json` with this body:

```json
{ "shareTokenHash": "<64 lowercase hexadecimal characters>" }
```

The hash is SHA-256 of the UTF-8 bytes of the complete 43-character base64url
token, without decoding the token. The plaintext share token never appears in
request headers or body. A successful response must contain
`{ "status": "registered" }`.

On 2026-09-08, searches for `share-token`, `share_token`, and `shareToken` found
no route in the AgentScan checkout's `origin/dev` (`9eb29f4069e4925e98f556782c1bd7e14ab0e5e2`)
or its `feat/lighter-activity` working tree. `shareTokenHash` is therefore the
client contract chosen to implement the PR's stated SHA-256-only requirement;
the AgentScan side must implement this field and a write-once, idempotent bind.
Live endpoint compatibility has not been verified. Until the endpoint accepts
the hash, the locally stored token remains pending and Copy remains disabled.

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
The next Settings read retries the same hash and shows Linking until accepted.
Existing identity-recovery behavior clears the abandoned identity's token and
registration timestamp; its in-flight requests cannot publish into the new
identity. This is recovery, not a user-visible rotation operation.

## Migration and verification

`153_agentscan_share_token.sql` adds the nullable token and registration timestamp
to `agentscan_reporting_state`. It follows main's migration 152; main's 107 is
reserved for launchpad family roles. Older code ignores the additive columns.

Client tests pin the exact hash and absence of plaintext. Registration tests use
controlled promises to cover recovery while a request is pending. The reporting
repository suite exercises write-once storage, conditional registration, and
reset invalidation against real Postgres through `vitest/studio-postgres.config.ts`.
The upgrade matrix verifies fresh installs and supported upgrade paths.
