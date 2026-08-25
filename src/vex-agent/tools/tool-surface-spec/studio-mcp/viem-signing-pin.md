# viem signing-path pin note (probed 2026-08-24, installed package)

Facts read from `node_modules/viem/_esm`, recorded so every invariant
about the deferred signing arm is anchored in the installed source, not
in assumptions. Re-probe on any viem upgrade.

1. `actions/wallet/signTransaction.js:63`: the CLIENT ACTION
   unconditionally awaits `getChainId({})` (an `eth_chainId` provider
   round trip) BEFORE invoking the account signer, and passes the
   result into `assertCurrentChain` and the signable payload. Therefore
   `walletClient.signTransaction` can NEVER satisfy "zero provider
   calls between the authority fence and the cryptographic signature".
2. `accounts/privateKeyToAccount.js:31`: the LOCAL ACCOUNT exposes
   `account.signTransaction(transaction, { serializer })` which calls
   `accounts/utils/signTransaction.js` - keccak over
   `serializer(signableTransaction)`, sign, `serializer(tx, signature)`
   - with NO client and NO transport. This is the offline path the
   deferred arm must use.
3. `accounts/utils/signTransaction.js:5`: the default serializer is
   viem's `serializeTransaction`; a custom chain serializer is the
   optional second argument. The prepared request must therefore carry
   an EXPLICIT `chainId` (the account path does not inject one), and
   the chain's serializer must be passed when the chain defines one
   (`chain.serializers?.transaction`).
4. Consequence for the fence contract: chainId is read/asserted DURING
   PREPARATION (before the fence); the post-fence signature is
   `account.signTransaction(preparedRequestWithChainId, { serializer })`
   only. A test transport that throws on any request after the fence
   is the regression guard.
