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

## ADOPTED from both references: the bridge destination is derived
(2026-09-03, studio-prod BRIDGE-1)

- MetaMask quotes a bridge for the SELECTED account: `walletAddress` on
  `GenericQuoteRequest` comes from the selected account
  (`bridge-controller.ts` `#getMultichainSelectedAccount`,
  `fetchBridgeQuotes`), and the only destination field,
  `destWalletAddress` (`types.ts:136`), exists for the SAME user's
  account on the other VM - the controller refuses to poll a
  Solana-crossing quote when the client did not supply it
  (`bridge-controller.test.ts:1585`). It is never a free address the
  caller names.
- Rabby's bridge flow has NO recipient input at all: the quote and the
  build both take `userAddress` from
  `state.account.currentAccount.address`
  (`Bridge/Component/BridgeContent.tsx:81,207,264`), and the word
  "recipient" does not occur anywhere under `src/ui/views/Bridge`.
- ADOPTED, and Vex goes one step further than either: `recipient` is
  removed from all four bridge tools (Khalani and Relay, quote and
  execute) and a caller-supplied value is REJECTED BY NAME with the
  address the bridge will deliver to, rather than dropped. Rule 90:
  "Fee receiver, destination, or other value that can redirect funds
  never originates from model input. Reject a caller-supplied forbidden
  field by name rather than silently dropping it." The destination is
  always `resolveSelectedAddress(..., destinationFamily)`; a
  cross-family bridge with no wallet selected on the destination family
  fails closed with the ordinary wallet-scope refusal, never an
  arbitrary address.
- Why by-name matters HERE and not for MetaMask or Rabby: their bridge
  destination is chosen by a human in a UI, ours by a model. A silent
  drop would hide an attempted redirection, and in a FULL project no
  approval card exists to show the human what the destination was.
- The prequote identity binds the DERIVED destination on both sides
  (`prequote/identity/bridge.ts`, `relay-bridge.ts`), the same fix
  `refundTo` got: a params-bound destination let an attacker set the
  same address on the quote AND the execute, collide the hashes and
  pass the gate.
- NOT adopted: MetaMask's `destWalletAddress` as an agent-facing
  parameter. It is the right shape for a wallet UI where the human owns
  both accounts and picks them; as a tool param it is exactly the
  redirection vector rule 90 forbids. A user who wants funds elsewhere
  bridges to their own wallet and then sends with `WalletSendPrepare`,
  which the user approves - the remedy every refusal names.

## Named omissions (not smuggled into A4b; own future arcs)

- Counterparty reputation / first-interaction / blacklist layer
  (MetaMask first-time-interaction.ts, Rabby rule engine). A bounded
  rule seam is a product feature with its own review; named per the
  provider-depth decree.
- Open-card re-simulation (MetaMask ResimulateHelper): UX honesty
  only - our commit-time re-decode + re-simulate means nothing unsafe
  signs; intent TTL bounds the staleness window.

  CORRECTION (2026-09-04). That sentence was true of the swap venues and
  FALSE of the bridges when it was written: Relay and Khalani signed a
  provider approve step after checking only the chain, the sender, the
  address shape and the native value, and decoded the spender and the
  allowance afterwards, to record evidence. What is true NOW is the
  approve step: `@tools/evm-chains/erc20-approve-step-guard.ts` binds it
  before any signer, on both venues, to a canonical `approve` with no
  native value whose spender is the plan's own deposit target, and on
  Relay additionally to the origin token and to an allowance EXACTLY
  equal to the principal Vex derived. Rabby's approval card is the
  reference for which three fields matter (token, spender, amount);
  unlike Rabby, Vex has no human at the step, so the bound replaces the
  human rather than informing one. STILL OPEN, and not claimed anywhere:
  the deposit step's own calldata is not decoded on either venue (a
  selector table needs the live captures archived on 2026-09-04), the
  Khalani planner cannot yet bind the allowance to the principal because
  neither the origin token nor the bridged amount reaches it, and the
  ERC-20 receipt rule in `bridge-deposit-evidence.ts` still has a
  ceiling but no floor.

## Reference caveat

Rabby's full rule list lives in `@rabby-wallet/rabby-security-engine`
(not vendored in the checkout) - only the wired rule ids were
enumerable. NOT FOUND recorded rather than guessed.
