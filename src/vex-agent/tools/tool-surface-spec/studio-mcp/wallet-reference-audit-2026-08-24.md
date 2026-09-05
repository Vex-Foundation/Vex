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
  BOTH venues additionally to the origin token, to the selected wallet
  and to an allowance EXACTLY equal to the principal Vex derived. The
  Khalani half closed second: `buildKhalaniDepositPlan` now hands
  `planKhalaniDepositLegs` the origin token, the wallet and the post-fee
  `bridgedAmountRaw` it already gives the native-value prover, so an
  unlimited, larger, smaller or foreign-token approval refuses before any
  leg, signer, nonce or durable row exists. An `approve(spender, 0)`
  reset stays legitimate: it grants nothing, so only the grant beside it
  is bound to the principal. Rabby's approval card is the reference for
  which three fields matter (token, spender, amount); unlike Rabby, Vex
  has no human at the step, so the bound replaces the human rather than
  informing one.

  SECOND CORRECTION (2026-09-04). The two items the paragraph
  above left open are now closed, and the exact shape of each matters:

  - THE ORDER. `reset -> exact grant -> deposit`, or a prefix of it, is
    the only approval shape either venue signs
    (`verifyApprovalSequence`). Relay orders by step index and Khalani by
    leg order, so a grant sequenced AFTER the deposit (a standing
    allowance created after the only transaction that justified it) and a
    reset with no grant behind it (a bare revocation the bridge never
    needed) both refuse pre-sign. A reset now gets every rule-2 check
    except the amount equality: on the origin token, from the selected
    wallet, naming this plan's deposit target.
  - THE DEPOSIT CALLDATA. `@tools/evm-chains/bridge-deposit-calldata.ts`
    binds the deposit call to the plan for every selector whose SIGNATURE
    an authoritative source confirms. Relay's `0xe8017952`
    (`depositErc20(address,address,uint256,bytes32)`), its three-argument
    overload and `0x49290c1c` (`depositNative(address,bytes32)`) come
    from the VERIFIED `RelayDepository` source the Base explorer
    publishes for `0x4cD00e387622c35bDDB9B4C962C136462338BC31`, the very
    address every live capture calls. Khalani's `0xf3125a1f` is NOT
    confirmed: its target is unverified on that explorer and on Sourcify
    and Khalani publishes no deposit ABI, so it is recorded as
    `deposit_selector_unverified` and logged once rather than refused -
    refusing honest traffic on our own ignorance is a worse failure than
    leaving the money guard to the receipt.
  - THE RECEIPT FLOOR. `bridge-deposit-evidence.ts` now has a floor as
    well as a ceiling: the proven ERC-20 amount must EQUAL the quoted
    principal unless the token has a MEASURED deduction in
    `FEE_ON_TRANSFER_DEDUCTIONS` (empty, absolute atomic units, never a
    percentage). A shortfall is a `deposit_short` outcome that records
    the row for review without an amount and makes the Vex fee leg
    INELIGIBLE on both venues, so a deposit of one unit against a
    million-unit quote can no longer pay a full fixed fee.

## Reference caveat

Rabby's full rule list lives in `@rabby-wallet/rabby-security-engine`
(not vendored in the checkout) - only the wired rule ids were
enumerable. NOT FOUND recorded rather than guessed.
