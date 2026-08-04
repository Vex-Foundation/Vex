# Khalani bridge fixtures — provenance

`bridge-execute-filled-unverified.json` is the owner's REAL Khalani
(Hyperstream 1-click) Arbitrum→Base response from the 2026-08-03 live test
(`agents_dm/feedback-wave-2026-08/USER-FEEDBACK.md`), captured at tool-return.

Sanitisation: the wallet address does not appear; the owner's truncated hashes
(`0x8b00…`, `0x2678…`) and the fee recipient (`0xe341…`) are zero-padded to full
width. The order id is a placeholder of the same shape. **Amounts, the `vexFee`
block, the `nativeCost` component breakdown and every leg status are byte-exact.**

What it pins, and why the `nativeCost` block is the point: Khalani states every
wei with a `kind`, a `recipient`, a refund policy, `provenBy` and
`authorized: true`. That is the EVIDENCE that decides whether an executed amount
may be written at return time — a Vex-built transfer with a proven principal may,
opaque provider calldata may not. It is deliberately NOT an empty collection: a
fixture that encoded only empty arrays would prove nothing about the shape the
projection has to read.
