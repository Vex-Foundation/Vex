# Relay bridge fixtures — provenance

`bridge-execute-pending.json` is the owner's REAL `relay.bridge` response from the
2026-08-03 live test (`agents_dm/feedback-wave-2026-08/USER-FEEDBACK.md`), captured
at tool-return time.

Sanitisation: the wallet address is not present in the captured excerpt, and the
transaction hashes are the owner's own truncated `0x77dd…`/`0x5a57…`/`0xd6cc…`
zero-padded to 32 bytes so they parse as real hashes. **Every amount, the
`vexFee` block and every leg status are byte-exact** — they are the evidence
under test and must never be rounded, shortened or replaced with an empty
collection.

What it pins: at t+0 the deposit AND the Vex-fee leg are `confirmed` with exact
amounts, while the fill is only `reported_success` — the provider's word. That
asymmetry is the whole reason the fee must reach the feed row immediately while
the fill's executed amounts must NOT be written from this response.
