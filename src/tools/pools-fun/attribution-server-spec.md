# VEX attestation on pools.fun - server specification

Status: LIVE on both sides as of 2026-08-24. The pools.fun team confirmed this
contract in writing and implemented the endpoint at the proposed path on
`api.bankr.bot`; Vex probe-verified its conformance the same day (closed
error vocabulary, flat `code` field, `launch_not_ready` for an unindexed
token, recovery against `GatewayLaunch.launcher` - see the measured table in
`PoolsFun.md`). The success path is exercised by real launches; everything
below remains the binding contract both sides implemented.

The equivalent flow is already live with trench.express, so this is not a new
mechanism - it is the same mechanism pointed at a launchpad whose launches go
through a gateway contract, which changes the verification in one specific and
easy-to-get-wrong way (see section 2, step 3).

Authoritative sources on the Vex side, for anyone who wants to read the client
rather than trust this document:

- `src/tools/pools-fun/constants.ts` - the pinned chain id, factory, gateway.
- `src/tools/pools-fun/abi.ts` - the verified `GatewayLaunch` and
  `TokenLaunched` event fragments, and the gateway's `launcherOf` view.
- `src/vex-agent/sync/pools-settlement-decoder.ts` - the dual-event decode Vex
  itself performs on a launch receipt. The server-side algorithm below is the
  same proof, done independently.
- `src/tools/trench-express/attribution.ts` and
  `src/vex-agent/sync/launch-attribution.ts` - the live trench.express client
  and its retry sweep, which the pools.fun client mirrors.
- `src/tools/pools-fun/PoolsFun.md` - the measured provider reference for
  everything else in this module.

## 1. Endpoint and general requirements

```
POST /pools-fun/vex/attestations
```

The path is the ONE thing in this document that is open to a counter-proposal.
It was chosen to sit under the existing `/pools-fun/*` convention; if the
pools.fun team prefers a different path, name it and Vex will use it. Nothing
else here is negotiable without a new version, because the client is being
built against it.

- HTTPS is required. The client refuses plain HTTP outside `localhost`.
- No authentication, no API key, no bearer token. The PROOF IS THE SIGNATURE.
  The request body carries nothing an attacker could replay for anything other
  than the exact token it already names.
- Client timeout: 15 seconds per request.
- Client retry cadence: a FIXED 600 seconds. There is no exponential backoff and
  no jitter, and the client does NOT read `Retry-After`. Do not size anything on
  the assumption that `Retry-After` will be honored; if the endpoint needs a
  slower cadence than one attempt per 600 seconds per token, say so and the
  constant changes on the Vex side.
- Content type: `application/json` in both directions.
- Free-text error messages are never consumed by the client - not interpreted,
  not logged, not retained. Only the closed code vocabulary in section 3
  changes client behavior. Human-readable text in the body is welcome for
  operators reading their own responses; to the Vex client it does not exist.

## 2. The verification algorithm

This is the heart of the contract, and step 3 is where a reasonable
implementation goes wrong.

### Request body

```json
{
  "chainId": 4663,
  "tokenAddress": "0x<40 lowercase hex>",
  "attestSignature": "0x<65-byte EIP-191 signature>",
  "txHash": "0x<launch transaction hash>"
}
```

`txHash` IS A LOCATOR ONLY. It is not part of the signed bytes, and the server
must not trust it beyond using it to fetch a receipt. Everything the server
concludes must come from the receipt's own logs and from the recovered signer.
A caller who supplies a receipt that does not prove what section 2 requires
gets a refusal, not a benefit of the doubt.

### The signed message

EIP-191 `personal_sign` over these exact UTF-8 bytes, with NO trailing newline:

```
VEX-attest:v1:pools.fun:4663:<lowercase 0x token address>
```

One line. The `v1` is a version marker on the byte layout itself: if this string
ever has to change, it becomes `v2` and both sides support both for a migration
window. The bytes are never mutated in place.

### Steps

**1. Fetch the receipt of `txHash` on Robinhood Chain (chainId 4663).**

The receipt must exist and must be successful (`status` 1). It must also be
sufficiently final: the server verifies against a block it is prepared to treat
as settled on Robinhood Chain rather than against a just-mined head, so that a
reorg cannot leave a badge standing on a launch that no longer exists. If the
receipt is not yet visible, not yet final, or not yet in the server's index,
that is `launch_not_ready` and NOT `not_pools_launch` (see section 3). The
client will come back.

**2. The receipt must contain exactly one `GatewayLaunch` and exactly one
`TokenLaunched`, from their PINNED emitters.**

| Event | Emitter that must have logged it |
|---|---|
| `GatewayLaunch(address token, address pool, address launcher, address pairedAsset, address feeRecipient, bytes32 userSalt, uint256 feePaidWei, uint256 devBuyOut)` | `PoolsFunLaunchGateway` `0x3AB42e7dd316aF8854033bc216C657eD34961164` |
| `TokenLaunched(address token, address pool, address pairedAsset, address creator, address deployer, address feeRecipient, int24 startTick, string metadataUri, uint256 devBuyAmountOut)` | `PartyFactory` `0x626C3d09B65bF5d1D40E0D5F25e19fa49783B3D4` |

Filter logs by emitter address BEFORE decoding. Any contract can emit an event
with the same signature, and an unpinned emitter would let an unrelated address
be attested as the user's token.

Exactly one of each, not "the first one". A receipt carrying two launches is not
a receipt one launch can be attributed from, and picking the first would be a
guess. Both events must name the requested `tokenAddress` in their `token`
field, and they must agree with each other on `token` and `pool`.

**3. Cross-check: `TokenLaunched.creator` and `TokenLaunched.deployer` must both
equal the pinned GATEWAY address. They are NEVER the human signer.**

Read that twice. On the gateway launch path the factory is called BY the
gateway, so the factory credits the gateway contract
(`0x3AB42e7dd316aF8854033bc216C657eD34961164`) as both `creator` and
`deployer`. The human who launched the token appears in NEITHER field.

**A verifier that recovers the signature and compares it to
`TokenLaunched.creator` will reject every single Vex launch.** This is the one
mistake that silently breaks the whole integration: the code looks correct, the
tests pass against a hand-rolled fixture, and in production nothing is ever
attested. If `creator` and `deployer` are anything other than the pinned
gateway, this was not the gateway path and the attestation does not apply.

**4. Recover the EIP-191 signer of the exact message bytes and require it to
equal `GatewayLaunch.launcher`.**

`launcher` is the only field in either event that names the human, and it is
indexed on `GatewayLaunch`. This is what makes the gateway path attributable at
all.

`PoolsFunLaunchGateway.launcherOf(token)` is a CORROBORATING read: if the server
consults it, it must agree with `GatewayLaunch.launcher`, and a disagreement is
a refusal rather than a tie-break. It is not an equivalent substitute for the
event. The event is the receipt's own account of the transaction the caller
pointed at; the view is contract state read at some later block, and it does not
by itself tie the launch to the transaction under examination.

Recovery must be done over the exact bytes of the message in this document.
Rebuild the string from the chain id and the lowercased token address rather
than echoing anything from the request other than the address itself.

## 3. Responses and the closed error vocabulary

**Acceptance:** HTTP 2xx with a JSON body carrying `success: true`.

```json
{ "success": true }
```

The client reads exactly one field, `success`. A 2xx whose body does not carry
a boolean `success: true` is NOT read as agreement; it is recorded as an
unreadable answer and retried. Extra fields alongside `success` are ignored, not
rejected, so the response can grow without breaking the client.

**Refusal:** a non-2xx status with a JSON body carrying the code in a field
named `code`:

```json
{ "success": false, "code": "invalid_signature" }
```

These five are the only codes. A code outside the list, a missing `code`
field, or an unreadable body is treated as an unreadable refusal and retried.

Classification precedence, exactly as the client implements it:

1. HTTP 429 and every 5xx are RETRYABLE regardless of any code in the body.
   An overloaded or erroring server can never terminalize a token by echoing
   a terminal code mid-outage, so put terminal codes on 4xx statuses.
2. For every other non-2xx status, classification is by the `code` field
   alone; the exact status is informational (4xx recommended).

Extra fields, including human-readable text for operators, are welcome and
ignored.

| code | meaning | client behavior |
|---|---|---|
| `invalid_signature` | the bytes were recovered and the signer is not `GatewayLaunch.launcher` | TERMINAL |
| `validation_failed` | the request itself is malformed: bad address shape, bad signature shape, missing field | TERMINAL |
| `not_pools_launch` | a FINALIZED receipt proves the pinned gateway/factory relationship is absent or mismatched | TERMINAL |
| `launch_not_ready` | the launch is not indexed yet, or the receipt is not final enough to judge | RETRYABLE |
| `chain_unsupported` | `chainId` is not a chain this endpoint serves | RETRYABLE |

Terminal means the client stops asking about that token permanently and logs
the refusal with the HTTP status and the validated code. Retryable means the
client comes back in 600 seconds, indefinitely.

`chain_unsupported` is retryable on the Vex side because the client only ever
sends chain 4663, the one chain this launchpad runs on. If that code comes back,
the honest reading is a lane misconfiguration or a server-side outage of chain
support, not a request Vex should abandon - so it is retried rather than treated
as a permanent verdict on the token.

**The consequence of choosing `not_pools_launch` over `launch_not_ready` is
permanent.** `not_pools_launch` is a statement that the server LOOKED at a
finalized receipt and found that it does not describe a pools.fun gateway
launch. It must never be returned because indexing is behind, because the RPC
was slow, or because the receipt was not visible yet - all of those are
`launch_not_ready`. A `not_pools_launch` returned for a lag condition costs a
real user their badge forever, and nothing on the Vex side will ever ask again.

429 and any 5xx are treated as retryable on the same 600 second cadence. They
are not transport failures on the Vex side - the server answered - and they
are not refusals; they simply settle nothing.

## 4. Hard requirements on the server

**Idempotency.** Repeating an already-accepted attestation MUST be a 2xx no-op
with `success: true` (200 recommended). The client's delivery is at-least-once BY DESIGN: it can
crash between receiving a 200 and recording that fact locally, and it will then
POST the same attestation again on the next sweep. A duplicate must be cheap and
safe, never a 409 and never a second badge event.

**Backfill.** An attestation arriving days or weeks after the launch MUST be
honored. There is no freshness window on the signature and none can be added
without breaking the client: the retry sweep runs on a fixed cadence over a
persistent queue, an app that was closed for a week attests on its next start,
and future re-delivery flows depend on the same property. The launch receipt is
as final in three weeks as it was in three minutes.

**Emitter pinning is not optional.** See section 2, step 2.

## 5. What this proof does and does not establish

State plainly, because the badge is a public claim and Vex will not overstate
it:

The proof DOES establish three things:

1. control of the launching wallet - only that key could produce the signature;
2. that wallet's consent to VEX attribution for that specific token - the token
   address is inside the signed bytes;
3. membership in pools.fun's own launch index - the receipt proves a real
   gateway launch of that token.

The proof does NOT establish that the launch originated from the Vex client.
The message string is public and fixed. Any launcher who signs it for a token
they launched through the pools.fun gateway qualifies for the badge, whether
or not they have ever run Vex (a launch that did not go through the gateway
fails section 2 regardless of who signs).
This is the same semantic that is already live with trench.express and it is
accepted deliberately: the alternative would be a shared secret or a relay, and
neither belongs in a self-custodial desktop app.

So the honest reading of the badge is **"the launcher attested VEX
involvement"**, not "this token was created in Vex".

Scope is FUTURE LAUNCHES ONLY. A signature can only be produced at launch time,
while the launch's signing clients are open - the token address does not exist
before the receipt, and nothing in Vex after the launch handler holds a signer.
Pre-existing pools.fun launches therefore have no stored signature, and none
will be created retroactively. There is no backfill of history, only backfill of
delivery for launches that were signed when they happened.

## 6. How to verify end to end

Once the endpoint is live and pools.fun has confirmed the contract, Vex enables
signing and the sequence is observable from both sides.

1. **A launch happens in Vex** on Robinhood Chain through the gateway. The launch
   handler signs the attestation message in the same step that produced the
   launch, and stores the signature with the launch row.
2. **The client POSTs** to `/pools-fun/vex/attestations` immediately after the
   launch receipt confirms. This is the healthy path and it is where a normal
   launch gets its badge.
3. **The retry sweep covers everything else** - app closed, network down, server
   answering `launch_not_ready` while indexing catches up - by re-POSTing on the
   fixed 600 second cadence until a terminal answer arrives.

On the Vex side, the log lines to look for mirror the trench.express lane
(`trench.launch_attribution.*` in `src/vex-agent/sync/launch-attribution.ts`),
under a `pools`-scoped equivalent:

- an accepted attestation, counted on the run that landed it;
- `rejected` with the HTTP status and the validated code - this is what makes
  a wrong-wallet signature distinguishable from a network blip;
- `transport_failed` when the client never learned whether the request arrived;
- `unsigned_gap` counting launches that have no stored signature and therefore
  can never be attested.

What the pools.fun side should see land: one POST per launched token, arriving
seconds after the launch transaction confirms, from a wallet that appears as
`GatewayLaunch.launcher` in that same transaction, and a badge appearing on that
token's page. A duplicate POST for a token already attested is expected traffic,
not a defect.

## 7. Known gaps on the Vex client (outside the server's scope)

Named here so the pools.fun team is not surprised by them:

- **A kill switch exists on the Vex side.** The contract was confirmed in
  writing and the endpoint verified on 2026-08-24. The client still carries a
  strict-boolean configuration flag for the lane; an install with it off sends
  zero traffic, so silence from one Vex install can mean the switch, not a
  defect.
- **The message bytes are versioned `v1` and will never be mutated.** Any change
  to the signed string is a new version marker, supported alongside `v1` for a
  migration window on both sides. A server that pins `v1` bytes will keep
  working.
- **The client never sends for a malformed address.** A token address that is
  not a 20-byte hex address is refused locally before any request is built, so
  `validation_failed` on address shape should be rare in practice and is worth
  investigating if it is not.
- **Only launches performed by Vex are attested.** Vex holds no signature for a
  pools.fun token launched anywhere else, and cannot produce one after the fact.
- **A terminal `validation_failed` can be re-delivered later.** If such a
  rejection was caused by a Vex-side encoding defect, the fix ships as a new
  client and re-queueing the affected rows is a deliberate maintenance action
  on the Vex side (clearing the rejection stamp). The server sees ordinary
  backfill traffic and needs no special handling beyond section 4.
