# Wallet-reference audit: A4b vs MetaMask core + Rabby (2026-08-24)

References: `agents-colab/metamask-core` (transaction-controller,
approval-controller), `agents-colab/rabby`. Full table in the audit
transcript; this file records the DECISIONS.

## Where Vex is deliberately stronger (recorded as explicit REJECTIONS
of the reference behavior, with evidence)

- MetaMask binds an approval to `{txId}` only and `#processApproval`
  applies `approvalValue.txMeta` AFTER acceptance
  (TransactionController.ts:2979-2991); ApprovalController lets the
  displayed request mutate while open. REJECTED: Vex binds the
  versioned proposal digest + whole-card equality.
- Rabby's retry mutates the approved payload (nonce bump / gas x1.3
  re-signed under the original approval, rpcFlow.ts:424-465).
  REJECTED: rule 90 revalidate-at-commit; never re-derive, never
  re-broadcast.
- MetaMask's PendingTransactionTracker marks a tx FAILED on a
  not-found timeout (PendingTransactionTracker.ts:456-497) - guessing
  an unknown commit outcome. REJECTED: `superseded_unproven` stays a
  non-failure terminal.
- Rabby's security engine runs only in the renderer and only disables
  the button; the background re-checks almost nothing. REJECTED:
  rules 07/90 - the privileged executor re-checks (our steps 6/8).

## Gaps to FIX before A4b closes (pass 6)

1. NONCE OWNERSHIP: per-(address, chainId) single-flight held from
   nonce fill through sign, released immediately before publish
   (MetaMask nonce.ts + TransactionController.ts:3107-3179 is the
   pattern). Today viem's prepareTransactionRequest reads the node's
   pending count with no lock (staged-broadcast.ts:358-405): two
   concurrent confirms can sign the same nonce.
2. CONCLUSIVE SAME-NONCE DROP: a CONFIRMED same-(from,nonce) sibling
   is definitive evidence, not a suggestion - the A6 lane should
   terminalize on it immediately (`nonce_superseded`) instead of
   waiting out the full non-inclusion window
   (PendingTransactionTracker.ts:544-557 is the pattern).

## Named omissions (not smuggled into A4b; own future arcs)

- Counterparty reputation / first-interaction / blacklist layer
  (MetaMask first-time-interaction.ts, Rabby rule engine). A bounded
  rule seam is a product feature with its own review; named per the
  provider-depth decree.
- Open-card re-simulation (MetaMask ResimulateHelper): UX honesty
  only - our commit-time re-decode + re-simulate means nothing unsafe
  signs; intent TTL bounds the staleness window.

## Reference caveat

Rabby's full rule list lives in `@rabby-wallet/rabby-security-engine`
(not vendored in the checkout) - only the wired rule ids were
enumerable. NOT FOUND recorded rather than guessed.
