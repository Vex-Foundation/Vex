/**
 * Pendle ASSET-CATALOGUE fixtures — captured VERBATIM from the live keyless
 * Pendle core API on 2026-07-27. Every row below is byte-exact as returned;
 * nothing is synthesized and no field is edited. These are public catalogue
 * endpoints, so no identity appears in them.
 *
 * Regenerate with:
 *   curl -s https://api-v2.pendle.finance/core/v1/1/assets/all
 *   curl -s https://api-v2.pendle.finance/core/v1/143/assets/all
 *   curl -s https://api-v2.pendle.finance/core/v1/assets/all
 *   curl -s https://api-v2.pendle.finance/core/v1/sdk/1/supported-aggregators
 *
 * Why both asset endpoints are here (H-1): they have DIFFERENT roots and
 * DIFFERENT row shapes, and the product read the wrong one.
 *
 *   GET /v1/{chainId}/assets/all  → a BARE ARRAY. Rows carry `price.usd`,
 *     `price.acc`, `decimals`, `baseType` and `priceUpdatedAt` — everything the
 *     tools price and size a trade with. Chain 1 returned 2453 rows,
 *     2378 of them priced.
 *
 *   GET /v1/assets/all           → an OBJECT, `{"assets":[…]}`, and its rows
 *     carry NO `price` and NO `baseType` at all (field set is exactly
 *     name/decimals/address/symbol/tags/expiry/proIcon/chainId). 3416 rows.
 *     Unwrapping `.assets` is therefore NOT a fix for the old defect: it yields
 *     undefined prices and a permanently false `baseType === "PT"` filter. It is
 *     kept here so a regression test can prove we REJECT this root.
 *
 * Chain-1 subset is curated (9 of 2453 rows — the full body is 1.8 MB, too
 * large to vendor) and deliberately non-empty on every axis the tools consume:
 * a 6-decimal priced PT/YT/SY plus the 18-decimal LP of the same live SIERRA
 * market, 6-decimal USDC (the token whose assumed-18 decimals caused the 10^12
 * sizing error), 18-decimal PENDLE, native ETH, a MATURED priced PT, and a PT
 * with no price at all (the tolerance case).
 *
 * Chain 143 (Monad) is the COMPLETE response — all 29 rows, unmodified.
 */

/** `GET /v1/1/assets/all` — bare array root. Curated 9-row verbatim subset. */
export const PENDLE_CHAIN1_ASSETS: readonly unknown[] = [
  {
    "id": "1-0x0000000000000000000000000000000000000000",
    "chainId": 1,
    "address": "0x0000000000000000000000000000000000000000",
    "symbol": "ETH",
    "decimals": 18,
    "expiry": null,
    "accentColor": null,
    "price": {
      "usd": 1966.43
    },
    "priceUpdatedAt": "2026-07-27T07:11:15.006Z",
    "name": "ETH",
    "baseType": "NATIVE",
    "types": [
      "NATIVE"
    ],
    "protocol": null,
    "proSymbol": "ETH",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/3e9c6be7-0a20-4b5f-8c34-f49c223fc689.svg",
    "zappable": true,
    "simpleName": "ETH",
    "simpleSymbol": "ETH",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/3e9c6be7-0a20-4b5f-8c34-f49c223fc689.svg",
    "proName": "ETH"
  },
  {
    "id": "1-0x808507121b80c02388fad14726482e061b8da827",
    "chainId": 1,
    "address": "0x808507121b80c02388fad14726482e061b8da827",
    "symbol": "PENDLE",
    "decimals": 18,
    "accentColor": null,
    "price": {
      "usd": 1.5611465383803342
    },
    "priceUpdatedAt": "2026-07-27T07:11:15.006Z",
    "name": "PENDLE",
    "baseType": "GENERIC",
    "types": [
      "GENERIC"
    ],
    "protocol": "Pendle",
    "proSymbol": "PENDLE",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/ea33e392-1876-46a5-b7ce-c8434b5a7e71.svg",
    "zappable": true,
    "simpleName": "PENDLE",
    "simpleSymbol": "PENDLE",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/ea33e392-1876-46a5-b7ce-c8434b5a7e71.svg",
    "proName": "PENDLE"
  },
  {
    "id": "1-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "chainId": 1,
    "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "symbol": "USDC",
    "decimals": 6,
    "expiry": null,
    "accentColor": "",
    "price": {
      "usd": 0.99988891
    },
    "priceUpdatedAt": "2026-07-27T07:11:15.006Z",
    "name": "USDC",
    "baseType": "GENERIC",
    "types": [
      "GENERIC"
    ],
    "protocol": "",
    "proSymbol": "USDC",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/ff696349-5cfc-4117-9e98-cce61d626f56.svg",
    "zappable": true,
    "simpleName": "USDC",
    "simpleSymbol": "USDC",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/ff696349-5cfc-4117-9e98-cce61d626f56.svg",
    "proName": "USDC"
  },
  {
    "id": "1-0x1f40b9a1d21afedbe3c49776e7790ed2139ec075",
    "chainId": 1,
    "address": "0x1f40b9a1d21afedbe3c49776e7790ed2139ec075",
    "symbol": "PLP-SIERRA-6AUG2026",
    "decimals": 18,
    "expiry": "2026-08-06T00:00:00.000Z",
    "price": {
      "usd": 2135199490588.6938
    },
    "priceUpdatedAt": "2026-07-27T07:11:15.000Z",
    "name": "PLP-SIERRA-6AUG2026",
    "baseType": "PENDLE_LP",
    "types": [
      "PENDLE_LP"
    ],
    "proSymbol": "LP SIERRA (USDC)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/1cf5507c-bea4-443e-ae17-9d2f1ea6ee7d.svg",
    "zappable": false,
    "simpleName": "LP SIERRA (USDC)",
    "simpleSymbol": "LP SIERRA (USDC)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/1cf5507c-bea4-443e-ae17-9d2f1ea6ee7d.svg",
    "proName": "LP SIERRA (USDC)"
  },
  {
    "id": "1-0x0ee083964c815baed1a2d7f5e3cec851ec394e7d",
    "chainId": 1,
    "address": "0x0ee083964c815baed1a2d7f5e3cec851ec394e7d",
    "symbol": "PT-SIERRA-6AUG2026",
    "decimals": 6,
    "expiry": "2026-08-06T00:00:00.000Z",
    "price": {
      "usd": 0.9973745870538542
    },
    "priceUpdatedAt": "2026-07-27T07:11:15.000Z",
    "name": "PT-SIERRA-6AUG2026",
    "baseType": "PT",
    "types": [
      "PT"
    ],
    "proSymbol": "PT SIERRA (USDC)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/9aaf6f2b-9e37-4add-a668-bba586b5a605.svg",
    "zappable": false,
    "simpleName": "PT SIERRA (USDC)",
    "simpleSymbol": "PT SIERRA (USDC)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/9aaf6f2b-9e37-4add-a668-bba586b5a605.svg",
    "proName": "PT SIERRA (USDC)"
  },
  {
    "id": "1-0xdf0bd47a116be19f2d4a2577372bd773060a01dc",
    "chainId": 1,
    "address": "0xdf0bd47a116be19f2d4a2577372bd773060a01dc",
    "symbol": "YT-SIERRA-6AUG2026",
    "decimals": 6,
    "expiry": "2026-08-06T00:00:00.000Z",
    "price": {
      "usd": 0.0025143229461456963
    },
    "priceUpdatedAt": "2026-07-27T07:11:15.000Z",
    "name": "YT-SIERRA-6AUG2026",
    "baseType": "YT",
    "types": [
      "YT"
    ],
    "proSymbol": "YT SIERRA (USDC)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/d20900bf-b5f6-4cee-9270-e38a3783c275.svg",
    "zappable": false,
    "simpleName": "YT SIERRA (USDC)",
    "simpleSymbol": "YT SIERRA (USDC)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/d20900bf-b5f6-4cee-9270-e38a3783c275.svg",
    "proName": "YT SIERRA (USDC)"
  },
  {
    "id": "1-0x399e426e6812943ac22976333698e16eaa80a209",
    "chainId": 1,
    "address": "0x399e426e6812943ac22976333698e16eaa80a209",
    "symbol": "SY-SIERRA",
    "decimals": 6,
    "expiry": null,
    "price": {
      "usd": 1.0308206334130756
    },
    "priceUpdatedAt": "2026-07-27T07:11:15.000Z",
    "name": "SY-SIERRA",
    "baseType": "SY",
    "types": [
      "SY"
    ],
    "underlyingPool": "",
    "proSymbol": "SIERRA",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/98061079-3524-4239-b8d9-ab170f089a4f.svg",
    "zappable": false,
    "simpleName": "SIERRA",
    "simpleSymbol": "SIERRA",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/98061079-3524-4239-b8d9-ab170f089a4f.svg",
    "proName": "SIERRA"
  },
  {
    "id": "1-0x9014f29610e904c8269726c74ebc79f5d512dafd",
    "chainId": 1,
    "address": "0x9014f29610e904c8269726c74ebc79f5d512dafd",
    "symbol": "PT-Stargate USDT-27JUN2024",
    "decimals": 6,
    "expiry": "2024-06-27T00:00:00.000Z",
    "accentColor": "",
    "price": {
      "usd": 0.99902332,
      "acc": 1
    },
    "priceUpdatedAt": "2026-07-27T06:21:00.000Z",
    "name": "PT-Stargate USDT-27JUN2024",
    "baseType": "PT",
    "types": [
      "PT"
    ],
    "protocol": "Stargate",
    "underlyingPool": "USDT",
    "proSymbol": "PT S*USDT (USDT)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/bc41cfad-eaff-436f-8a97-0376ed00edef.svg",
    "zappable": false,
    "simpleName": "PT S*USDT (USDT)",
    "simpleSymbol": "PT S*USDT (USDT)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/bc41cfad-eaff-436f-8a97-0376ed00edef.svg",
    "proName": "PT S*USDT (USDT)"
  },
  {
    "id": "1-0x5e9aaf3b0b09c78c8651968dd1a4d0ed0d0b55e9",
    "chainId": 1,
    "address": "0x5e9aaf3b0b09c78c8651968dd1a4d0ed0d0b55e9",
    "symbol": "PT-ankrETH-WETH_BalancerLP Aura-26SEP2024",
    "decimals": 18,
    "expiry": "2024-09-26T00:00:00.000Z",
    "accentColor": "",
    "name": "PT-ankrETH-WETH_BalancerLP Aura-26SEP2024",
    "baseType": "PT",
    "types": [
      "PT"
    ],
    "protocol": "Aura",
    "underlyingPool": "ankrETH-WETH",
    "proSymbol": "PT ankrETH-WETH BLP (ankrETH-WETH BLP)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/4004ad24-848e-449f-839b-ea4e679d843b.svg",
    "zappable": false,
    "simpleName": "PT ankrETH-WETH BLP (ankrETH-WETH BLP)",
    "simpleSymbol": "PT ankrETH-WETH BLP (ankrETH-WETH BLP)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/4004ad24-848e-449f-839b-ea4e679d843b.svg",
    "proName": "PT ankrETH-WETH BLP (ankrETH-WETH BLP)"
  }
];

/** `GET /v1/143/assets/all` — bare array root. COMPLETE live response (Monad). */
export const PENDLE_CHAIN143_ASSETS: readonly unknown[] = [
  {
    "id": "143-0x754704bc059f8c67012fed69bc8a327a5aafb603",
    "chainId": 143,
    "address": "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    "symbol": "USDC",
    "decimals": 6,
    "accentColor": "",
    "price": {
      "usd": 0.99989874
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.034Z",
    "name": "USDC",
    "baseType": "GENERIC",
    "types": [
      "GENERIC"
    ],
    "proSymbol": "USDC",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/e647c7d9-486d-4634-856a-e89edc136505.png",
    "zappable": true,
    "simpleName": "USDC",
    "simpleSymbol": "USDC",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/e647c7d9-486d-4634-856a-e89edc136505.png",
    "proName": "USDC"
  },
  {
    "id": "143-0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
    "chainId": 143,
    "address": "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
    "symbol": "WMON",
    "decimals": 18,
    "accentColor": "",
    "price": {
      "usd": 0.02104086918582
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.034Z",
    "name": "WMON",
    "baseType": "GENERIC",
    "types": [
      "GENERIC"
    ],
    "proSymbol": "WMON",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/3b0cbcb6-32e6-4a7b-9165-4f7520028b26.png",
    "zappable": true,
    "simpleName": "WMON",
    "simpleSymbol": "WMON",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/3b0cbcb6-32e6-4a7b-9165-4f7520028b26.png",
    "proName": "WMON"
  },
  {
    "id": "143-0x0000000000000000000000000000000000000000",
    "chainId": 143,
    "address": "0x0000000000000000000000000000000000000000",
    "symbol": "MON",
    "decimals": 18,
    "accentColor": "",
    "price": {
      "usd": 0.02105696
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.034Z",
    "name": "MON",
    "baseType": "GENERIC",
    "types": [
      "GENERIC"
    ],
    "proSymbol": "MON",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/a93532cb-e225-41f0-9e96-ac165d6657c2.svg",
    "zappable": true,
    "simpleName": "MON",
    "simpleSymbol": "MON",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/a93532cb-e225-41f0-9e96-ac165d6657c2.svg",
    "proName": "MON"
  },
  {
    "id": "143-0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
    "chainId": 143,
    "address": "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
    "symbol": "AUSD",
    "decimals": 6,
    "price": {
      "usd": 0.9999137384811001
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.034Z",
    "name": "AUSD",
    "baseType": "GENERIC",
    "types": [
      "GENERIC"
    ],
    "proSymbol": "AUSD",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/5659586e-b021-49c9-a42e-9a8d8e485c63.png",
    "zappable": true,
    "simpleName": "AUSD",
    "simpleSymbol": "AUSD",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/5659586e-b021-49c9-a42e-9a8d8e485c63.png",
    "proName": "AUSD"
  },
  {
    "id": "143-0xee8c0e9f1bffb4eb878d8f15f368a02a35481242",
    "chainId": 143,
    "address": "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242",
    "symbol": "WETH",
    "decimals": 18,
    "price": {
      "usd": 1967.52358138
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.034Z",
    "name": "WETH",
    "baseType": "GENERIC",
    "types": [
      "GENERIC"
    ],
    "proSymbol": "WETH",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/8335acd6-9dad-40f6-ac30-0ef1e95855cd.png",
    "zappable": true,
    "simpleName": "WETH",
    "simpleSymbol": "WETH",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/8335acd6-9dad-40f6-ac30-0ef1e95855cd.png",
    "proName": "WETH"
  },
  {
    "id": "143-0xe7cd86e13ac4309349f30b3435a9d337750fc82d",
    "chainId": 143,
    "address": "0xe7cd86e13ac4309349f30b3435a9d337750fc82d",
    "symbol": "USDT0",
    "decimals": 6,
    "price": {
      "usd": 0.99924087
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.034Z",
    "name": "USDT0",
    "baseType": "GENERIC",
    "types": [
      "GENERIC"
    ],
    "proSymbol": "USDT0",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/4bafb2ed-4391-4ea2-b3c7-4f1b456da0b4.png",
    "zappable": true,
    "simpleName": "USDT0",
    "simpleSymbol": "USDT0",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/4bafb2ed-4391-4ea2-b3c7-4f1b456da0b4.png",
    "proName": "USDT0"
  },
  {
    "id": "143-0x0555e30da8f98308edb960aa94c0db47230d2b9c",
    "chainId": 143,
    "address": "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
    "symbol": "WBTC",
    "decimals": 8,
    "price": {
      "usd": 65339.12682997
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.034Z",
    "name": "WBTC",
    "baseType": "GENERIC",
    "types": [
      "GENERIC"
    ],
    "proSymbol": "WBTC",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/7d42d5ca-c564-427e-986c-61f59bb9de61.png",
    "zappable": true,
    "simpleName": "WBTC",
    "simpleSymbol": "WBTC",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/7d42d5ca-c564-427e-986c-61f59bb9de61.png",
    "proName": "WBTC"
  },
  {
    "id": "143-0x0fe4a1bbe013b54e38ef4e4ec8ba1d64d12a0663",
    "chainId": 143,
    "address": "0x0fe4a1bbe013b54e38ef4e4ec8ba1d64d12a0663",
    "symbol": "PT-cUSD-23JUL2026",
    "decimals": 18,
    "expiry": "2026-07-23T00:00:00.000Z",
    "price": {
      "usd": 0.99988891
    },
    "priceUpdatedAt": "2026-07-27T07:12:00.000Z",
    "name": "PT-cUSD-23JUL2026",
    "baseType": "PT",
    "types": [
      "PT"
    ],
    "proSymbol": "PT cUSD (cUSD)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/e8e8523f-cce9-4933-b286-66aaec6ab805.svg",
    "zappable": false,
    "simpleName": "PT cUSD (cUSD)",
    "simpleSymbol": "PT cUSD (cUSD)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/e8e8523f-cce9-4933-b286-66aaec6ab805.svg",
    "proName": "PT cUSD (cUSD)"
  },
  {
    "id": "143-0x9fc74f8ed616b5baf52a170caa97d6d3898602d1",
    "chainId": 143,
    "address": "0x9fc74f8ed616b5baf52a170caa97d6d3898602d1",
    "symbol": "PT-AUSD-8OCT2026",
    "decimals": 6,
    "expiry": "2026-10-08T00:00:00.000Z",
    "price": {
      "usd": 0.987520122262965
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "PT-AUSD-8OCT2026",
    "baseType": "PT",
    "types": [
      "PT"
    ],
    "underlyingPool": "",
    "proSymbol": "PT AUSD (AUSD)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/dc276caf-4aa7-4ea0-8a32-5bc60d82028f.svg",
    "zappable": false,
    "simpleName": "PT AUSD (AUSD)",
    "simpleSymbol": "PT AUSD (AUSD)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/dc276caf-4aa7-4ea0-8a32-5bc60d82028f.svg",
    "proName": "PT AUSD (AUSD)"
  },
  {
    "id": "143-0xba3d60f5000f472aef947fb8020a3e6319f9a0b7",
    "chainId": 143,
    "address": "0xba3d60f5000f472aef947fb8020a3e6319f9a0b7",
    "symbol": "SY-AUSD",
    "decimals": 6,
    "expiry": null,
    "price": {
      "usd": 0.9999137384811001
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "SY-AUSD",
    "baseType": "SY",
    "types": [
      "SY"
    ],
    "underlyingPool": "",
    "proSymbol": "AUSD",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/76f6d205-f76b-4a2a-b0d7-656802ecd8d0.svg",
    "zappable": false,
    "simpleName": "AUSD",
    "simpleSymbol": "AUSD",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/76f6d205-f76b-4a2a-b0d7-656802ecd8d0.svg",
    "proName": "AUSD"
  },
  {
    "id": "143-0x6f99cf00ee7290ae78a072bb6910ef72d1129fe7",
    "chainId": 143,
    "address": "0x6f99cf00ee7290ae78a072bb6910ef72d1129fe7",
    "symbol": "PLP-AUSD-8OCT2026",
    "decimals": 18,
    "expiry": "2026-10-08T00:00:00.000Z",
    "price": {
      "usd": 2820631930669.7617
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "PLP-AUSD-8OCT2026",
    "baseType": "PENDLE_LP",
    "types": [
      "PENDLE_LP"
    ],
    "underlyingPool": "",
    "proSymbol": "LP AUSD (AUSD)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/616f202c-65b7-413e-9a81-2e122942aae2.svg",
    "zappable": false,
    "simpleName": "LP AUSD (AUSD)",
    "simpleSymbol": "LP AUSD (AUSD)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/616f202c-65b7-413e-9a81-2e122942aae2.svg",
    "proName": "LP AUSD (AUSD)"
  },
  {
    "id": "143-0xe24a28fe8ecd859db4280d1291783a10017d6fc4",
    "chainId": 143,
    "address": "0xe24a28fe8ecd859db4280d1291783a10017d6fc4",
    "symbol": "SY-earnAUSD",
    "decimals": 6,
    "expiry": null,
    "price": {
      "usd": 1.031642001316844
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "SY-earnAUSD",
    "baseType": "SY",
    "types": [
      "SY"
    ],
    "underlyingPool": "",
    "proSymbol": "earnAUSD",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/79d66825-3644-42d0-85d9-ab509c35f248.svg",
    "zappable": false,
    "simpleName": "earnAUSD",
    "simpleSymbol": "earnAUSD",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/79d66825-3644-42d0-85d9-ab509c35f248.svg",
    "proName": "earnAUSD"
  },
  {
    "id": "143-0xeddee9c0b56248d70a9bfdd103f8bd97c35dfd89",
    "chainId": 143,
    "address": "0xeddee9c0b56248d70a9bfdd103f8bd97c35dfd89",
    "symbol": "YT-AUSD-8OCT2026",
    "decimals": 6,
    "expiry": "2026-10-08T00:00:00.000Z",
    "price": {
      "usd": 0.01239361621813509
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "YT-AUSD-8OCT2026",
    "baseType": "YT",
    "types": [
      "YT"
    ],
    "underlyingPool": "",
    "proSymbol": "YT AUSD (AUSD)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/86d43f51-4e9e-4174-82eb-a9806df63df3.svg",
    "zappable": false,
    "simpleName": "YT AUSD (AUSD)",
    "simpleSymbol": "YT AUSD (AUSD)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/86d43f51-4e9e-4174-82eb-a9806df63df3.svg",
    "proName": "YT AUSD (AUSD)"
  },
  {
    "id": "143-0xdaf216939826acaba0c2312f7e30a890213845cd",
    "chainId": 143,
    "address": "0xdaf216939826acaba0c2312f7e30a890213845cd",
    "symbol": "PT-earnAUSD-8OCT2026",
    "decimals": 6,
    "expiry": "2026-10-08T00:00:00.000Z",
    "price": {
      "usd": 0.982209217816007
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "PT-earnAUSD-8OCT2026",
    "baseType": "PT",
    "types": [
      "PT"
    ],
    "underlyingPool": "",
    "proSymbol": "PT earnAUSD (AUSD)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/409eeb72-990c-4eb4-b990-ae94a2423d08.svg",
    "zappable": false,
    "simpleName": "PT earnAUSD (AUSD)",
    "simpleSymbol": "PT earnAUSD (AUSD)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/409eeb72-990c-4eb4-b990-ae94a2423d08.svg",
    "proName": "PT earnAUSD (AUSD)"
  },
  {
    "id": "143-0x103222f020e98bba0ad9809a011fdf8e6f067496",
    "chainId": 143,
    "address": "0x103222f020e98bba0ad9809a011fdf8e6f067496",
    "symbol": "earnAUSD",
    "decimals": 6,
    "expiry": null,
    "accentColor": "",
    "price": {
      "usd": 1.031642001316844
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.034Z",
    "name": "earnAUSD",
    "baseType": "IB",
    "types": [
      "IB"
    ],
    "proSymbol": "earnAUSD",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/c963db4e-ca3c-4c55-bccf-e059d0002f5c.svg",
    "zappable": true,
    "simpleName": "earnAUSD",
    "simpleSymbol": "earnAUSD",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/c963db4e-ca3c-4c55-bccf-e059d0002f5c.svg",
    "proName": "earnAUSD"
  },
  {
    "id": "143-0x4147a0c89a83faba5d401e644e110a1c5f67bd8b",
    "chainId": 143,
    "address": "0x4147a0c89a83faba5d401e644e110a1c5f67bd8b",
    "symbol": "YT-earnAUSD-8OCT2026",
    "decimals": 6,
    "expiry": "2026-10-08T00:00:00.000Z",
    "price": {
      "usd": 0.01768416869242135
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "YT-earnAUSD-8OCT2026",
    "baseType": "YT",
    "types": [
      "YT"
    ],
    "underlyingPool": "",
    "proSymbol": "YT earnAUSD (AUSD)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/ac87e694-5a7b-480b-b70f-5ba8d8b5df84.svg",
    "zappable": false,
    "simpleName": "YT earnAUSD (AUSD)",
    "simpleSymbol": "YT earnAUSD (AUSD)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/ac87e694-5a7b-480b-b70f-5ba8d8b5df84.svg",
    "proName": "YT earnAUSD (AUSD)"
  },
  {
    "id": "143-0x475b98c83aedbfdd0a0abaa930ec8cb501ac93b1",
    "chainId": 143,
    "address": "0x475b98c83aedbfdd0a0abaa930ec8cb501ac93b1",
    "symbol": "PLP-earnAUSD-8OCT2026",
    "decimals": 18,
    "expiry": "2026-10-08T00:00:00.000Z",
    "price": {
      "usd": 2104990886985.4033
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "PLP-earnAUSD-8OCT2026",
    "baseType": "PENDLE_LP",
    "types": [
      "PENDLE_LP"
    ],
    "underlyingPool": "",
    "proSymbol": "LP earnAUSD (AUSD)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/90b7e0f9-2db9-4cd1-ad1d-12acd1a75cba.svg",
    "zappable": false,
    "simpleName": "LP earnAUSD (AUSD)",
    "simpleSymbol": "LP earnAUSD (AUSD)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/90b7e0f9-2db9-4cd1-ad1d-12acd1a75cba.svg",
    "proName": "LP earnAUSD (AUSD)"
  },
  {
    "id": "143-0x5e49e1f85813f2b65858860a3fa231b4186f2e0e",
    "chainId": 143,
    "address": "0x5e49e1f85813f2b65858860a3fa231b4186f2e0e",
    "symbol": "PENDLE",
    "decimals": 18,
    "price": {
      "usd": 1.56207658
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.034Z",
    "name": "PENDLE",
    "baseType": "GENERIC",
    "types": [
      "GENERIC"
    ],
    "proSymbol": "PENDLE",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/ea33e392-1876-46a5-b7ce-c8434b5a7e71.svg",
    "zappable": false,
    "simpleName": "PENDLE",
    "simpleSymbol": "PENDLE",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/ea33e392-1876-46a5-b7ce-c8434b5a7e71.svg",
    "proName": "PENDLE"
  },
  {
    "id": "143-0xf104c6cd68f81579c6a1d85849cb12fcc64bd72a",
    "chainId": 143,
    "address": "0xf104c6cd68f81579c6a1d85849cb12fcc64bd72a",
    "symbol": "PT-USDat-27AUG2026",
    "decimals": 6,
    "expiry": "2026-08-27T00:00:00.000Z",
    "price": {
      "usd": 0.9934000027671079
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "PT-USDat-27AUG2026",
    "baseType": "PT",
    "types": [
      "PT"
    ],
    "underlyingPool": "",
    "proSymbol": "PT USDat (USDat)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/a31d31f7-05f4-4e48-b976-1f45e85cced4.svg",
    "zappable": false,
    "simpleName": "PT USDat (USDat)",
    "simpleSymbol": "PT USDat (USDat)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/a31d31f7-05f4-4e48-b976-1f45e85cced4.svg",
    "proName": "PT USDat (USDat)"
  },
  {
    "id": "143-0xebdb7e4df7290c24239e8555d9a64b8ffc0ed0ba",
    "chainId": 143,
    "address": "0xebdb7e4df7290c24239e8555d9a64b8ffc0ed0ba",
    "symbol": "YT-USDat-27AUG2026",
    "decimals": 6,
    "expiry": "2026-08-27T00:00:00.000Z",
    "price": {
      "usd": 0.006396747561412103
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "YT-USDat-27AUG2026",
    "baseType": "YT",
    "types": [
      "YT"
    ],
    "underlyingPool": "",
    "proSymbol": "YT USDat (USDat)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/c55d258e-452b-4fdf-bf9b-7c1689abaf1a.svg",
    "zappable": false,
    "simpleName": "YT USDat (USDat)",
    "simpleSymbol": "YT USDat (USDat)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/c55d258e-452b-4fdf-bf9b-7c1689abaf1a.svg",
    "proName": "YT USDat (USDat)"
  },
  {
    "id": "143-0x0898c3346275e79db4892feb1c18875ec154f274",
    "chainId": 143,
    "address": "0x0898c3346275e79db4892feb1c18875ec154f274",
    "symbol": "SY-USDat",
    "decimals": 6,
    "expiry": null,
    "price": {
      "usd": 0.99979675032852
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "SY-USDat",
    "baseType": "SY",
    "types": [
      "SY"
    ],
    "underlyingPool": "",
    "proSymbol": "USDat",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/5c6df69c-1afb-4ad2-81be-0e871392a925.svg",
    "zappable": false,
    "simpleName": "USDat",
    "simpleSymbol": "USDat",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/5c6df69c-1afb-4ad2-81be-0e871392a925.svg",
    "proName": "USDat"
  },
  {
    "id": "143-0x0bb150dfa86ea5d7742f07fefcd8e8eda81d64ef",
    "chainId": 143,
    "address": "0x0bb150dfa86ea5d7742f07fefcd8e8eda81d64ef",
    "symbol": "USDat",
    "decimals": 6,
    "expiry": null,
    "accentColor": "",
    "price": {
      "usd": 0.99979675032852
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.034Z",
    "name": "USDat",
    "baseType": "IB",
    "types": [
      "IB"
    ],
    "proSymbol": "USDat",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/4fedc749-89b5-4ad9-a90b-85c6d47fba4d.svg",
    "zappable": true,
    "simpleName": "USDat",
    "simpleSymbol": "USDat",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/4fedc749-89b5-4ad9-a90b-85c6d47fba4d.svg",
    "proName": "USDat"
  },
  {
    "id": "143-0x1519fb0d8885020387fcd6a67bc888a168a40afa",
    "chainId": 143,
    "address": "0x1519fb0d8885020387fcd6a67bc888a168a40afa",
    "symbol": "PLP-USDat-27AUG2026",
    "decimals": 18,
    "expiry": "2026-08-27T00:00:00.000Z",
    "price": {
      "usd": 2063759234933.7463
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "PLP-USDat-27AUG2026",
    "baseType": "PENDLE_LP",
    "types": [
      "PENDLE_LP"
    ],
    "underlyingPool": "",
    "proSymbol": "LP USDat (USDat)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/2ac39f67-eabe-42f0-ad7a-6f31dd61f46d.svg",
    "zappable": false,
    "simpleName": "LP USDat (USDat)",
    "simpleSymbol": "LP USDat (USDat)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/2ac39f67-eabe-42f0-ad7a-6f31dd61f46d.svg",
    "proName": "LP USDat (USDat)"
  },
  {
    "id": "143-0xd236e83c563f888f540ca997c3ddf00e82d68c45",
    "chainId": 143,
    "address": "0xd236e83c563f888f540ca997c3ddf00e82d68c45",
    "symbol": "PT-sUSDE-22OCT2026",
    "decimals": 18,
    "expiry": "2026-10-22T00:00:00.000Z",
    "price": {
      "usd": 0.9904166576000726
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "PT-sUSDE-22OCT2026",
    "baseType": "PT",
    "types": [
      "PT"
    ],
    "underlyingPool": "",
    "proSymbol": "PT sUSDe (USDe)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/770e75fe-05a2-4e57-9dac-fee6c850de3e.svg",
    "zappable": false,
    "simpleName": "PT sUSDe (USDe)",
    "simpleSymbol": "PT sUSDe (USDe)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/770e75fe-05a2-4e57-9dac-fee6c850de3e.svg",
    "proName": "PT sUSDe (USDe)"
  },
  {
    "id": "143-0x758119e49319b91332eebd6fcbecd9e0387de16b",
    "chainId": 143,
    "address": "0x758119e49319b91332eebd6fcbecd9e0387de16b",
    "symbol": "YT-sUSDE-22OCT2026",
    "decimals": 18,
    "expiry": "2026-10-22T00:00:00.000Z",
    "price": {
      "usd": 0.00892370384240651
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "YT-sUSDE-22OCT2026",
    "baseType": "YT",
    "types": [
      "YT"
    ],
    "underlyingPool": "",
    "proSymbol": "YT sUSDe (USDe)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/5fdff739-4c5d-4374-971c-b1dd5267e5f3.svg",
    "zappable": false,
    "simpleName": "YT sUSDe (USDe)",
    "simpleSymbol": "YT sUSDe (USDe)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/5fdff739-4c5d-4374-971c-b1dd5267e5f3.svg",
    "proName": "YT sUSDe (USDe)"
  },
  {
    "id": "143-0x06fc2568fa3c8a9862d8f35bc6758355b3a32f51",
    "chainId": 143,
    "address": "0x06fc2568fa3c8a9862d8f35bc6758355b3a32f51",
    "symbol": "SY-sUSDE",
    "decimals": 18,
    "expiry": null,
    "price": {
      "usd": 1.2400226
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "SY-sUSDE",
    "baseType": "SY",
    "types": [
      "SY"
    ],
    "underlyingPool": "",
    "proSymbol": "sUSDe",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/27678868-b28f-4113-a46e-7dd4b82c08de.svg",
    "zappable": false,
    "simpleName": "sUSDe",
    "simpleSymbol": "sUSDe",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/27678868-b28f-4113-a46e-7dd4b82c08de.svg",
    "proName": "sUSDe"
  },
  {
    "id": "143-0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
    "chainId": 143,
    "address": "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
    "symbol": "USDe",
    "decimals": 18,
    "expiry": null,
    "accentColor": "",
    "price": {
      "usd": 0.99996587
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.034Z",
    "name": "USDe",
    "baseType": "GENERIC",
    "types": [
      "GENERIC"
    ],
    "proSymbol": "USDe",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/ab3533ad-a62c-4e5d-8c43-c80486354b8b.svg",
    "zappable": true,
    "simpleName": "USDe",
    "simpleSymbol": "USDe",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/ab3533ad-a62c-4e5d-8c43-c80486354b8b.svg",
    "proName": "USDe"
  },
  {
    "id": "143-0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2",
    "chainId": 143,
    "address": "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2",
    "symbol": "sUSDe",
    "decimals": 18,
    "expiry": null,
    "accentColor": "",
    "price": {
      "usd": 1.24005207
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.034Z",
    "name": "sUSDe",
    "baseType": "IB",
    "types": [
      "IB"
    ],
    "proSymbol": "sUSDe",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/4e4beab4-0c30-4f63-87d4-6bc561f4e6da.svg",
    "zappable": true,
    "simpleName": "sUSDe",
    "simpleSymbol": "sUSDe",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/4e4beab4-0c30-4f63-87d4-6bc561f4e6da.svg",
    "proName": "sUSDe"
  },
  {
    "id": "143-0x2142267022ecde6745de9f577e3ba4549ad23abc",
    "chainId": 143,
    "address": "0x2142267022ecde6745de9f577e3ba4549ad23abc",
    "symbol": "PLP-sUSDE-22OCT2026",
    "decimals": 18,
    "expiry": "2026-10-22T00:00:00.000Z",
    "price": {
      "usd": 3.009530501524484
    },
    "priceUpdatedAt": "2026-07-27T07:13:30.000Z",
    "name": "PLP-sUSDE-22OCT2026",
    "baseType": "PENDLE_LP",
    "types": [
      "PENDLE_LP"
    ],
    "underlyingPool": "",
    "proSymbol": "LP sUSDe (USDe)",
    "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/ce74aaec-dfb0-42c7-a8af-931f22910c5d.svg",
    "zappable": false,
    "simpleName": "LP sUSDe (USDe)",
    "simpleSymbol": "LP sUSDe (USDe)",
    "simpleIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/ce74aaec-dfb0-42c7-a8af-931f22910c5d.svg",
    "proName": "LP sUSDe (USDe)"
  }
];

/**
 * `GET /v1/assets/all` — the GLOBAL endpoint. Object root + price-less,
 * baseType-less rows. Present ONLY so the validator can be proven to reject it.
 */
export const PENDLE_GLOBAL_ASSETS_ENVELOPE: unknown = {
  assets: [
    {
      "name": "PT FRAX-USDC (FRAX-USDC)",
      "decimals": 18,
      "address": "0x5fe30ac5cb1abb0e44cdffb2916c254aeb368650",
      "symbol": "PT-FRAXUSDC_CurveLP Convex-30MAR2023",
      "tags": [
        "PT"
      ],
      "expiry": "2023-03-30T00:00:00.000Z",
      "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/acad6337-8ce4-47c2-87a7-c270aab01b3d.svg",
      "chainId": 1
    },
    {
      "name": "FRAX-USDC",
      "decimals": 18,
      "address": "0xd393d1ddd6b8811a86d925f5e14014282581bc04",
      "symbol": "SY-FRAXUSDC_CurveLP Convex",
      "tags": [
        "SY"
      ],
      "expiry": "",
      "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/7ffda969-3c4f-4031-82fe-6a16167c0be7.svg",
      "chainId": 1
    },
    {
      "name": "YT FRAX-USDC (FRAX-USDC)",
      "decimals": 18,
      "address": "0xc5cd692e9b4622ab8cdb57c83a0f99f874a169cd",
      "symbol": "YT-FRAXUSDC_CurveLP Convex-30MAR2023",
      "tags": [
        "YT"
      ],
      "expiry": "2023-03-30T00:00:00.000Z",
      "proIcon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/2239e536-439d-4c58-a417-805fb63c7ced.svg",
      "chainId": 1
    }
  ],
};

/**
 * `GET /v1/sdk/1/supported-aggregators` — verbatim. The entries are OBJECTS
 * (`{name, computingUnit}`), not bare strings: reading them as strings is what
 * silently pinned every Pendle trade to kyberswap.
 */
export const PENDLE_SUPPORTED_AGGREGATORS_CHAIN1: unknown = {
  "aggregators": [
    {
      "name": "kyberswap",
      "computingUnit": 1
    },
    {
      "name": "odos",
      "computingUnit": 10
    },
    {
      "name": "okx",
      "computingUnit": 1
    },
    {
      "name": "paraswap",
      "computingUnit": 15
    }
  ]
};
