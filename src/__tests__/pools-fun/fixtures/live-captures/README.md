# pools.fun live response captures

Real, unedited responses from the public pools.fun REST API (`api.bankr.bot`),
used by the `pools-fun` validation, client and error-mapping tests through
`../../_captures.ts`. The validators and the client are proven against bytes the
provider actually sent, never against a hand-rolled object that would merely
re-assert the test's own assumptions.

This convention is inherited deliberately from
`../../../trench-express/fixtures/live-captures/README.md`, and its reason is
sharper here than anywhere: pools.fun publishes NO API documentation and no
schema of any kind, so the only description of this API that exists is the bytes
in this folder. Hand-invented fixtures are banned.

## Envelope

Each JSON capture is `{ endpoint, capturedAt, response }`, where `response` is
the response body **verbatim** - values are never edited, reordered, or trimmed.
Two variations, both because the body is not a success payload:

- an error capture adds `httpStatus` (the 400 and 502 files);
- `route-not-found-404-html.json` carries `{ endpoint, capturedAt, httpStatus,
  contentType, bodyText, note }`, because that response is an HTML page and not
  JSON at all.

## Sanitization reasoning (not a ritual)

These endpoints are keyless public GETs returning public launchpad data: token
addresses, pool addresses, deployer and fee-recipient addresses, public X
handles, display prices and volumes. All of it is already on-chain or on a
public web page, and the deployer/fee-recipient addresses are part of what each
capture pins, so they are kept verbatim on purpose.

No Vex-controlled wallet appears in any of these files: every row was authored by
a third-party launcher on the public launchpad. If a future refresh pulls a row
deployed by one of our own wallets, replace it with another token's public data
before committing.

## Files - each pins a measured fact

| file | endpoint | pins |
|---|---|---|
| `discover-poolsfun-marketcap-desc.json` | `/discover?platform=poolsfun` | the pools.fun row shape: `decimals` and `totalSupply` are NULL, `poolId` is a 20-byte pool ADDRESS, and the row carries `pairedAsset` and `platform` |
| `discover-sushi-stock-paired.json` | `/discover?platform=sushi` | the other launcher's rows: `decimals` is 18 and `totalSupply` is a raw STRING (the opposite of the pools.fun rows), `feeRecipientAddress` can be null, and a `pairedAsset: "stock"` row carries an extra `pairedStock: {address, symbol}` block - a tokenised-stock pair is live, which the first probe recorded as not yet existing |
| `discover-empty-results.json` | `/discover` with an impossible market-cap floor | an empty market is `{"results":[],"nextCursor":null}` at HTTP 200 - NOT an error, and the cursor is null rather than absent |
| `discover-search-copycat-symbols.json` | `/discover?platform=all&q=sushicat` | identity is the ADDRESS: three different live tokens answer to the symbol SUSHICAT, across both launchers |
| `discover-invalid-sortby-400.json` | `/discover?sortBy=trending` | the rejection shape `{"error":"Invalid parameters","details":[{code,message,path}]}` at HTTP 400, whose `message` lists all fourteen accepted sort keys and whose `path` is an ARRAY of segments. This is the text the error mapper surfaces verbatim |
| `ohlcv-hour-weth-quote.json` | `/discover/{token}/ohlcv?timeframe=hour` | candles arrive as ARRAYS OF ARRAYS `[time, open, high, low, close, volumeUsd]`, with a `pool` and a `pair` naming the quote asset - and, on this pools.fun token, in OLDEST-FIRST order |
| `ohlcv-unknown-token-502.json` | `/discover/{unknown}/ohlcv` | an unindexed token answers HTTP **502** `{"error":"Upstream error resolving token pool"}` - a diagnosable not-found wearing a server-error status |
| `route-not-found-404-html.json` | `/search?q=x` | an unknown ROUTE answers HTTP 404 with an HTML page; the mapper must not try to read it as JSON |
| `discover-deployer-gateway-launch.json` | `/discover?platform=poolsfun&deployer=…` | a token launched through the pools.fun GATEWAY is still indexed under the launching WALLET, not under the gateway contract - `deployerAddress` is the EOA. One of two captures in this folder with edited values; see below |
| `launches-prepare-wallet-recipient.json` | `POST /launches/prepare` | the prepare contract AFTER the provider changed it under us: `feeRecipient` is `{address, display}` and `pairedAsset` is `{address, kind, symbol, decimals}` where both were strings, and `value` is HEX while every sibling amount on the same body is decimal. The envelope carries the `request` that produced it, whose `feeRecipient` is the `{type, value}` object a bare string is now rejected in favour of. The second sanitized capture; see below |
| `launches-prepare-insufficient-dev-buy-400.json` | `POST /launches/prepare` with a `devBuyEth` the wallet cannot afford | the launchpad's OTHER 400 shape: a bare `error` sentence beside a machine `"code": "INSUFFICIENT_DEV_BUY_BALANCE"`, and again no `details[]`. It is the reason the error mapper reads the `code` and the `error` field, not `details[]` alone - this is a money-path refusal with a real remedy (fund the wallet or lower the prebuy) |
| `launches-prepare-x-unresolvable-400.json` | `POST /launches/prepare` with `feeRecipient: {type: "x", …}` | the X path's failure mode: an unknown handle is HTTP 400 `{"error":"Could not resolve the x fee recipient. Check it and try again."}` - a bare `error` with NONE of the `details[]` array the `/discover` rejections carry, and a clean refusal rather than a silent fallback to some other address |

## The sanitized captures

`launches-prepare-insufficient-dev-buy-400.json` is the simplest of them: its
RESPONSE contains no address at all and is verbatim, and only the recorded
`request` carried the probe wallet, replaced in the two fields that held it.

The two below are launches by a Vex-controlled probe wallet, which is the one
thing the rule above forbids, and both follow the README's own remedy: the wallet is
replaced CONSISTENTLY everywhere it appears, and the envelope records the
substitution in a `sanitization` field. Nothing else is touched.

`launches-prepare-wallet-recipient.json` needed the substitution in four places,
because the same wallet appears in four encodings: `request.creatorAddress` and
`request.feeRecipient.value`, `response.feeRecipient.address`, the TRUNCATED
label `response.feeRecipient.display` (`0x33eF…d2fA` -> `0x1111…1111`), and the
20-byte word inside `response.data`. Substituting the calldata too is what keeps
the capture internally coherent, and coherence is the property it pins: the
response's stated recipient IS the recipient inside its own calldata, which is
the relation the verifier's point 4 exists to check. `salt`,
`predictedTokenAddress` and `predictedPoolAddress` are left as measured and are
therefore NOT derivable from the substituted wallet - this capture proves SHAPE,
never CREATE2 derivation, and no test reads it for the latter.

`discover-deployer-gateway-launch.json` is the older exception. The row was authored by a Vex-controlled probe wallet, and the rule
above is that our own wallet never lands in a committed fixture. Following the
README's own remedy, the wallet address was replaced CONSISTENTLY - in the
recorded query and in every row field that carried it - with
`0x1111111111111111111111111111111111111111`, and the envelope records the
substitution in a `sanitization` field. Nothing else was touched.

The property the capture pins survives the substitution intact, because it is a
RELATION and not an identity: `deployerAddress` equals the wallet the `deployer`
filter asked for, and is not the gateway contract
`0x3AB42e7dd316aF8854033bc216C657eD34961164`. That is the whole claim - a
gateway launch does not disappear from a deployer query - and it is why
`pools.my_launches` needs no gateway caveat.

## The candle-order finding

The first probe capture (a token from the third launchpad this API also serves)
came back newest-first, and the tool spec drafted from it said so. Both pools.fun
tokens measured on the recapture came back OLDEST-first. The order is therefore
NOT a constant to echo: `pools.candles` derives it from the timestamps and
reports what it found. `ohlcv-hour-weth-quote.json` is the capture that pins the
ascending case.

## The V3 suite captures (2026-09-04)

`launches-config-v3.json` and the three `launches-prepare-v3-*.json` files are
the launch path's V3 evidence, captured the day pools.fun's third contract suite
went live. What each one pins, and must keep pinning through any refresh:

- `launches-config-v3` - `gatewayVersion: 3`. It read `1` when the launch path
  was written, and moved twice in three days.
- `launches-prepare-v3-weth` - selector `0x3cc0226c` and the FOURTEEN-member
  tuple. The V1 selector was `0xb3ee5495` over twelve members, which is why
  every launch refused `calldata_undecodable` until this suite landed. The
  price attestation is all-zero and `priceSignature` is empty.
- `launches-prepare-v3-holders-both` - `feeRecipient` is the gateway's
  `FEES_TO_HOLDERS_BOTH` sentinel, not a wallet, and the response labels it
  `display: "Token holders"`. The pair of facts is the whole reason verifier
  point 15 exists.
- `launches-prepare-v3-stock-nvda` - a stock pair whose attestation is EMPTY,
  because NVDA is `CHAINLINK_STOCK`. No live prepare against a `SIGNED_STOCK`
  asset was captured; the signed-stock cases are built locally and labelled as
  such in the tests rather than being passed off as measurements.

They needed no sanitization: the launching wallet is not a member of the launch
tuple, and the probe wallet was searched for in the raw bytes before copying.

## Regenerating

```
curl -s '<endpoint>' > body.json
```

then wrap it in the envelope above with the exact request URL as `endpoint` and
the capture time as `capturedAt`.

Refresh only with a reason. Which tokens appear will change - the tests assert
on shape and on field presence, never on which token is first. What a refresh
must NOT silently lose is the property each capture pins above: the null-versus-
present `decimals` split between the two launchers, the stock-paired block, the
empty-results shape, the repeated symbols, the 400 detail shape, the positional
candles, the 502-as-not-found, and the HTML 404. If one of those is gone, that is
a finding to write down, not a capture to overwrite.
