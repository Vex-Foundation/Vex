# Jupiter Lend Earn fixtures — provenance

Tracked copies of sanitized, real live-API recordings from
`agents_dm/agentscan-phase3/fixtures/` (git-ignored source location — see the
`.meta.md` sibling of each source file there for the full recording session
log). Copied here byte-for-byte so committed tests never depend on an
ignored path.

Both requests were **keyless** (no `x-api-key` sent) against
`https://api.jup.ag/lend/v1/earn`, recorded 2026-07-24. `ownerAddress` on
every row is the LIVE-GATE FIX 1 disposable ed25519 keypair pubkey
(`9XpKPA8jNZPYFkdhwu5kKDSQneYiwAJiJF3apMK8ZKhF`) — no secret key, no funds, no
personal data; already publicly documented in `deltas/LIVE-FIX-1.md`.

| File | Source | Endpoint | Notes |
|---|---|---|---|
| `positions.json` | `lend-earn-positions.json` | `GET /earn/positions?users=<disposable pubkey>` | 7 rows — one per known Earn market, all `shares: "0"` for this never-funded wallet. **Negative finding**: parses cleanly against the current (LIVE-FIX-1-patched) schema with no changes — disproves the LIVE-GATE FIX 2 dispatch's hypothesis that this endpoint's ROOT shape drifted. Confirms the endpoint always returns the full market catalog for any address, which is why the `/earnings` sub-call (next row) fires on every real `solana.lend.positions` call. |
| `earnings.json` | `lend-earn-earnings.json` | `GET /earn/earnings?user=<disposable pubkey>&positions=<the 7 token addresses from positions.json>` | THE LIVE-GATE FIX 2 finding: `earnings` is a numeric **STRING** (`"0"`) on every row, not a JSON number. This nested sub-call inside the `solana.lend.positions` handler (`handlers/lend.ts`) is the actual root cause of the reported `<root>: Invalid input` schema failure — not `/earn/positions` itself. |

## Regeneration

Re-run the `curl` commands in `deltas/LIVE-FIX-2.md` and re-copy the
sanitized output here. Point-in-time snapshots (rates/positions will drift,
`earnings` may become non-zero for a genuinely used wallet) — treat these as
**shape** ground truth for schema pinning, not values to assert unchanged
indefinitely.
