/**
 * Pendle READ-SURFACE fixtures — captured VERBATIM from the live keyless Pendle
 * core API on 2026-07-27 (`https://api-v2.pendle.finance/core`). Nothing is
 * synthesized; numeric and structural truth is byte-exact as returned.
 *
 * ONE sanitisation, in `PENDLE_MERKLE_REWARDS` only: the third-party wallet the
 * probe found is replaced everywhere by the synthetic `0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e`
 * (same 40-hex shape). Every other field of that payload — tokens, amounts,
 * merkle roots, asset ids, windows — is untouched. All other endpoints here are
 * public catalogue/market data and carry no identity at all (rules/06).
 *
 * Regenerate (each call is free and keyless):
 *   curl -s 'https://api-v2.pendle.finance/core/v2/markets/all?chainId=1&isActive=true&order_by=liquidity:-1&skip=0&limit=2'
 *   curl -s 'https://api-v2.pendle.finance/core/v2/markets/all?chainId=1&isActive=false&ids=1-0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654'
 *   curl -s 'https://api-v2.pendle.finance/core/v1/sdk/1/markets/0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654/tokens'
 *   curl -s 'https://api-v2.pendle.finance/core/v1/sdk/1/markets/0x34280882267ffa6383b363e278b027be083bbe3b/swapping-prices'
 *   curl -s 'https://api-v2.pendle.finance/core/v3/1/markets/0x34280882267ffa6383b363e278b027be083bbe3b/historical-data?time_frame=day&timestamp_start=2026-07-20T00:00:00.000Z&timestamp_end=2026-07-27T00:00:00.000Z&fields=impliedApy,tvl,ptPrice'
 *   curl -s 'https://api-v2.pendle.finance/core/v4/1/prices/0xb253eff1104802b97ac7e3ac9fdd73aece295a2c/ohlcv?time_frame=day&timestamp_start=2026-07-20T00:00:00.000Z'
 *   curl -s 'https://api-v2.pendle.finance/core/v1/prices/assets?ids=1-0xb253eff1104802b97ac7e3ac9fdd73aece295a2c,1-0x34280882267ffa6383b363e278b027be083bbe3b'
 *   curl -s 'https://api-v2.pendle.finance/core/v1/dashboard/merkle-rewards/<a wallet with pending merkle rewards>'
 *   curl -s 'https://api-v2.pendle.finance/core/v2/limit-orders/book/1?market=0xfce3f966a131c46a51b896ceea3917bc4c302577&precisionDecimal=2'
 *
 * Live coordinates behind these bodies:
 *   ACTIVE   market 1-0x34280882267ffa6383b363e278b027be083bbe3b (wstETH, expiry 2027-12-30)
 *   MATURED  market 1-0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654 (srUSDe, expiry 2026-04-02)
 *            — absent from `isActive=true`, present under `isActive=false`
 *   ORDERBOOK market 1-0xfce3f966a131c46a51b896ceea3917bc4c302577 (ynRWAx) — limit-order whitelisted
 *
 * SHAPE FACTS these bodies pin, each of which contradicted an assumption:
 *   - `historical-data` returns ROW OBJECTS under `results`, not parallel arrays,
 *     and its window params are `timestamp_start`/`timestamp_end` (ISO strings).
 *   - `ohlcv` returns a CSV STRING under `results` with a header line, unix-second
 *     timestamps, and a legitimately EMPTY trailing volume column on some rows.
 *   - `prices/assets` returns a MAP (`{"1-0x…": number}`), not an array of rows.
 *   - `swapping-prices` answers HTTP 404 (`Given market is expired`) for a matured
 *     market — it does NOT return null legs.
 *   - `limit-orders/book` answers HTTP 404 for a market that is not limit-order
 *     whitelisted, and only emits `ammSize` when `includeAmm=true`.
 *   - `order_by` NEEDS THE DOTTED PATH for nested fields. The capture below was
 *     requested with `order_by=liquidity:-1` and came back UNSORTED by
 *     liquidity — the endpoint accepts an unknown sort key silently (so does
 *     `order_by=nonsense:1`). Only `details.liquidity:-1` actually orders by
 *     liquidity. The rows here are therefore in the provider's default order,
 *     which is exactly what makes the point.
 */

/** `GET /v2/markets/all?chainId=1&isActive=true&order_by=liquidity:-1&limit=2`. */
export const PENDLE_MARKETS_ACTIVE_PAGE: unknown = {
    "total": 61,
    "limit": 2,
    "skip": 0,
    "results": [
      {
        "name": "wstETH",
        "protocol": "Lido",
        "icon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/7d7ba120-b263-4107-8f96-3a99dab402d3.svg",
        "address": "0x34280882267ffa6383b363e278b027be083bbe3b",
        "expiry": "2027-12-30T00:00:00.000Z",
        "pt": "1-0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
        "yt": "1-0x04b7fa1e727d7290d6e24fa9b426d0c940283a95",
        "sy": "1-0xcbc72d92b2dc8187414f6734718563898740c0bc",
        "underlyingAsset": "1-0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
        "accountingAsset": "1-0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
        "rewardTokens": [
          "1-0x808507121b80c02388fad14726482e061b8da827"
        ],
        "inputTokens": [
          "1-0x0000000000000000000000000000000000000000",
          "1-0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
          "1-0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
          "1-0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"
        ],
        "outputTokens": [
          "1-0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
          "1-0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"
        ],
        "details": {
          "liquidity": 3542391.7571333637,
          "totalTvl": 3863636.2889823606,
          "tradingVolume": 1219.2189816719801,
          "underlyingApy": 0.022078690487234764,
          "swapFeeApy": 0.000007896578527955,
          "pendleApy": 0.0016156814432556068,
          "ytFloatingApy": -0.03441608986754707,
          "impliedApy": 0.02276412626056401,
          "feeRate": 0.0004999999993486881,
          "yieldRange": {
            "min": 0.029978328225930276,
            "max": 0.07247767045580256
          },
          "aggregatedApy": 0.023738649329237523,
          "maxBoostedApy": 0.026162171494120933,
          "totalPt": 100.06167927678678,
          "totalSy": 1393.8219696898254,
          "totalSupply": 823.8809126600967,
          "totalActiveSupply": 331.32295102226533,
          "ytRoi": -0.04869822808610469,
          "ptRoi": 0.032606540558200114
        },
        "isNew": false,
        "isPrime": true,
        "timestamp": "2023-05-29T07:40:11.000Z",
        "categoryIds": [
          "eth",
          "blue-chips",
          "lido"
        ],
        "isVolatile": false,
        "underlyingRewardApyBreakdown": [],
        "lpRewardApyBreakdown": [],
        "ytApyBreakdown": {
          "categories": [
            {
              "label": "Protocol Yield",
              "apy": 0.022078690487234764,
              "items": [
                {
                  "id": "1-0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
                  "apy": 0.022078690487234764,
                  "tags": [
                    "INTEREST",
                    "AUTO"
                  ],
                  "source": "CONTRACT"
                }
              ]
            }
          ]
        },
        "lpApyBreakdown": {
          "categories": [
            {
              "label": "Underlying Yield",
              "apy": 0.020906821715073586,
              "items": [
                {
                  "id": "1-0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
                  "apy": 0.020906821715073586,
                  "tags": [
                    "INTEREST",
                    "AUTO"
                  ],
                  "source": "CONTRACT"
                }
              ]
            },
            {
              "label": "PT Fixed Yield",
              "apy": 0.0012082495882494817,
              "items": [
                {
                  "id": "1-0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
                  "apy": 0.0012082495882494817,
                  "tags": [
                    "FIXED_YIELD",
                    "AUTO"
                  ]
                }
              ]
            },
            {
              "label": "LP Rewards",
              "apy": 0.0006541691558301977,
              "items": [
                {
                  "id": "1-0x34280882267ffa6383b363e278b027be083bbe3b",
                  "apy": 0.000007896578527955,
                  "tags": [
                    "SWAP_FEE",
                    "AUTO"
                  ]
                },
                {
                  "id": "PENDLE",
                  "apy": 0.0006462725773022427,
                  "tags": [
                    "INCENTIVE",
                    "BOOSTABLE"
                  ]
                }
              ]
            }
          ]
        },
        "chainId": 1,
        "externalProtocols": {
          "pt": [
            {
              "protocol": {
                "id": "yearn",
                "name": "yearn",
                "iconUrl": "https://storage.googleapis.com/external-integration-prod/dfe9328f-1644-4b76-aff6-4360590f1bfe.png",
                "category": "yield strategy",
                "url": "https://pendle.yearn.space/",
                "description": "Yearn is a decentralized suite of products helping individuals, DAOs, and other protocols earn yield on their digital assets."
              },
              "integrationUrl": "https://yearn.fi/v3?search=yPT-wstETH&chains=1",
              "description": "yPT-wstETH Yearn Auto-Rolling Pendle PT Vault",
              "subtitle": null,
              "chainId": 1
            }
          ],
          "yt": [],
          "lp": [],
          "crossPt": []
        },
        "pendleEmission": {
          "totalIncentive": 71.76576904490038,
          "tvlIncentive": 70.83190620798084,
          "feeIncentive": 0.9338628369195492,
          "discretionaryIncentive": 0,
          "cobribingIncentive": 0,
          "limitOrderIncentive": 0
        },
        "marketInfo": {
          "assetDescription": "<p>wstETH is a Liquid staking token allows you to earn staking rewards by delegating your ETH to a staking service provider.</p>",
          "riskInvolved": "<p>This pool has minimal risk of generating negative yield</p>",
          "importantQuirks": "<p>NA</p>",
          "initiatedBy": "Pendle Team",
          "conversionRate": {
            "rate": 1.2403224147318532,
            "fromUnit": "wstETH",
            "toUnit": "stETH"
          },
          "utilizedProtocols": [
            {
              "id": "lido",
              "url": "https://stake.lido.fi/",
              "name": "Lido",
              "imageUrl": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/7c9b898e-a009-4dc2-8872-3bef7c9a659e.svg"
            }
          ],
          "deposit": {
            "url": "https://stake.lido.fi/withdrawals/request",
            "description": "Pendle Router automatically finds the best route between native minting and DEX swapping"
          },
          "withdrawal": {
            "url": "https://stake.lido.fi/withdrawals/request",
            "description": "Pendle Router automatically finds the best route between native withdrawal and DEX swapping"
          }
        }
      },
      {
        "name": "ynRWAx",
        "protocol": "YieldNest",
        "icon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/3838be51-cc43-47e3-9fb0-76aed8ecf637.svg",
        "address": "0xfce3f966a131c46a51b896ceea3917bc4c302577",
        "expiry": "2026-10-15T00:00:00.000Z",
        "pt": "1-0x77db49ac43107f0cef6f65837aa55ee8ae4cd9fa",
        "yt": "1-0x2263fdec108939ae8fd0ab41901fa9755203b232",
        "sy": "1-0x5271be3516a36316465ee50c4288ce91e58f7759",
        "underlyingAsset": "1-0x01ba69727e2860b37bc1a2bd56999c1afb4c15d8",
        "accountingAsset": "1-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "rewardTokens": [
          "1-0x808507121b80c02388fad14726482e061b8da827"
        ],
        "inputTokens": [
          "1-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "1-0x01ba69727e2860b37bc1a2bd56999c1afb4c15d8"
        ],
        "outputTokens": [
          "1-0x01ba69727e2860b37bc1a2bd56999c1afb4c15d8"
        ],
        "details": {
          "liquidity": 836946.0951419071,
          "totalTvl": 890470.2716599052,
          "tradingVolume": 0,
          "underlyingApy": 0.11409050416027244,
          "swapFeeApy": 0.0002630977646749244,
          "pendleApy": 0,
          "ytFloatingApy": 0.24581367106638696,
          "impliedApy": 0.10526848313939796,
          "feeRate": 0.002041156818012757,
          "yieldRange": {
            "min": 0.060000000000000005,
            "max": 0.15
          },
          "aggregatedApy": 0.13116868183188468,
          "maxBoostedApy": 0.16272279079791513,
          "totalPt": 409312.231072,
          "totalSy": 401607.264215097,
          "totalSupply": 0.4009776831633529,
          "totalActiveSupply": 0.22813904759850756,
          "ytRoi": 0.04891259435587347,
          "ptRoi": 0.021984572807882685
        },
        "isNew": false,
        "isPrime": false,
        "timestamp": "2025-10-24T07:43:23.000Z",
        "categoryIds": [
          "stables",
          "rwa"
        ],
        "isVolatile": false,
        "underlyingRewardApyBreakdown": [
          {
            "asset": "1-0x01ba69727e2860b37bc1a2bd56999c1afb4c15d8",
            "absoluteApy": 0.016928605956153843,
            "relativeApy": 1,
            "source": "PORTAL_INCENTIVE",
            "ytExclusive": false,
            "lpExclusive": true,
            "portalExtData": {
              "amount": 3000,
              "startTimestamp": "2026-06-04T00:00:00.000Z",
              "endTimestamp": "2026-08-27T00:00:00.000Z"
            }
          },
          {
            "asset": "1-0x808507121b80c02388fad14726482e061b8da827",
            "absoluteApy": 0.004107466687866438,
            "relativeApy": 1,
            "source": "PENDLE_CO_BRIBE",
            "ytExclusive": false,
            "lpExclusive": true,
            "portalExtData": {
              "amount": 518.7033256656911,
              "startTimestamp": "2026-06-04T00:00:00.000Z",
              "endTimestamp": "2026-08-27T00:00:00.000Z"
            }
          }
        ],
        "lpRewardApyBreakdown": [
          {
            "asset": "1-0x01ba69727e2860b37bc1a2bd56999c1afb4c15d8",
            "absoluteApy": 0.016928605956153843,
            "relativeApy": 1,
            "source": "PORTAL_INCENTIVE",
            "ytExclusive": false,
            "lpExclusive": true,
            "portalExtData": {
              "amount": 3000,
              "startTimestamp": "2026-06-04T00:00:00.000Z",
              "endTimestamp": "2026-08-27T00:00:00.000Z"
            }
          },
          {
            "asset": "1-0x808507121b80c02388fad14726482e061b8da827",
            "absoluteApy": 0.004107466687866438,
            "relativeApy": 1,
            "source": "PENDLE_CO_BRIBE",
            "ytExclusive": false,
            "lpExclusive": true,
            "portalExtData": {
              "amount": 518.7033256656911,
              "startTimestamp": "2026-06-04T00:00:00.000Z",
              "endTimestamp": "2026-08-27T00:00:00.000Z"
            }
          }
        ],
        "ytApyBreakdown": {
          "categories": [
            {
              "label": "Protocol Yield",
              "apy": 0.11409050416027244,
              "items": [
                {
                  "id": "1-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                  "apy": 0.11409050416027244,
                  "tags": [
                    "INTEREST",
                    "AUTO"
                  ],
                  "source": "CONTRACT"
                }
              ]
            }
          ]
        },
        "lpApyBreakdown": {
          "categories": [
            {
              "label": "Underlying Yield",
              "apy": 0.05950266602499582,
              "items": [
                {
                  "id": "1-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                  "apy": 0.05950266602499582,
                  "tags": [
                    "INTEREST",
                    "AUTO"
                  ],
                  "source": "CONTRACT"
                }
              ]
            },
            {
              "label": "PT Fixed Yield",
              "apy": 0.050366846571973545,
              "items": [
                {
                  "id": "1-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                  "apy": 0.050366846571973545,
                  "tags": [
                    "FIXED_YIELD",
                    "AUTO"
                  ]
                }
              ]
            },
            {
              "label": "LP Rewards",
              "apy": 0.008677526822283036,
              "items": [
                {
                  "id": "1-0xfce3f966a131c46a51b896ceea3917bc4c302577",
                  "apy": 0.0002630977646749244,
                  "tags": [
                    "SWAP_FEE",
                    "AUTO"
                  ]
                },
                {
                  "id": "PENDLE",
                  "apy": 0,
                  "tags": [
                    "INCENTIVE",
                    "BOOSTABLE"
                  ]
                },
                {
                  "id": "1-0x01ba69727e2860b37bc1a2bd56999c1afb4c15d8",
                  "apy": 0.006771442382461537,
                  "tags": [
                    "CO-INCENTIVE",
                    "BOOSTABLE"
                  ],
                  "source": "PORTAL_INCENTIVE",
                  "campaignDetail": {
                    "amount": 3000,
                    "startTimestamp": "2026-06-04T00:00:00.000Z",
                    "endTimestamp": "2026-08-27T00:00:00.000Z"
                  }
                },
                {
                  "id": "1-0x808507121b80c02388fad14726482e061b8da827",
                  "apy": 0.0016429866751465753,
                  "tags": [
                    "CO-INCENTIVE",
                    "BOOSTABLE"
                  ],
                  "source": "PENDLE_CO_BRIBE",
                  "campaignDetail": {
                    "amount": 518.7033256656911,
                    "startTimestamp": "2026-06-04T00:00:00.000Z",
                    "endTimestamp": "2026-08-27T00:00:00.000Z"
                  }
                }
              ]
            }
          ]
        },
        "chainId": 1,
        "limitOrderIncentive": {
          "amountPerSec": 0.000009032294055211112,
          "impliedApy": 0.10526848313939796,
          "buyYtApr": 0.08744714599224321,
          "sellPtApr": 0.0019233572379840373,
          "sellYtApr": 1,
          "buyPtApr": 0.31851784119177223,
          "long": {
            "mode": "RELATIVE",
            "amountPerSec": 0.000004516147027605556,
            "minApy": 0.10158408622951903,
            "maxApy": 0.10895288004927689
          },
          "short": {
            "mode": "RELATIVE",
            "amountPerSec": 0.000004516147027605556,
            "minApy": 0.10158408622951903,
            "maxApy": 0.10895288004927689
          }
        },
        "pendleEmission": {
          "totalIncentive": 27.479073410264185,
          "tvlIncentive": 0,
          "feeIncentive": 0,
          "discretionaryIncentive": 0,
          "cobribingIncentive": 22.016341965672503,
          "limitOrderIncentive": 5.462731444591681
        },
        "marketInfo": {
          "assetDescription": "<p>ynRWAx is a curated Real-World Asset (RWA) product from YieldNest offering stable, off-chain yields backed by diversified, real collateral. It provides users with seamless access to RWA-backed returns on USDC through fully audited, on-chain infrastructure.</p>",
          "riskInvolved": "<p>If any of the underlying strategies are compromised, it could result in bad debt or a negative yield for the derivative. In the unlikely event of a drawdown, the accounting module will write down the asset value, which may lead to a decrease in the share price.</p>\n<p><strong>from underlying protocol</strong></p>",
          "importantQuirks": "<p>This market has no special quirks</p>",
          "initiatedBy": "YieldNest",
          "auditedUrl": "",
          "conversionRate": {
            "rate": 1.087049,
            "fromUnit": "ynRWAx",
            "toUnit": "USDC staked in YieldNest"
          },
          "utilizedProtocols": [
            {
              "id": "yieldnest",
              "url": "https://app.yieldnest.finance/",
              "name": "YieldNest",
              "imageUrl": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/c196bba6-87a1-49b5-a302-1a6ff6553d68.svg"
            }
          ],
          "deposit": {
            "url": "https://app.yieldnest.finance/",
            "description": "Pendle Router automatically finds the best route between native minting and DEX swapping"
          },
          "withdrawal": {
            "url": "https://app.yieldnest.finance/",
            "description": "Pendle Router automatically finds the best route between native withdrawal and DEX swapping"
          }
        }
      }
    ]
  };

/** `GET /v2/markets/all?chainId=1&isActive=false&ids=1-0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654` — the MATURED srUSDe market. */
export const PENDLE_MARKETS_MATURED_PAGE: unknown = {
    "total": 1,
    "limit": 20,
    "skip": 0,
    "results": [
      {
        "name": "srUSDe",
        "protocol": "Strata",
        "icon": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/e847b0a9-1332-4b4d-9929-5962a03cf811.svg",
        "address": "0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654",
        "expiry": "2026-04-02T00:00:00.000Z",
        "pt": "1-0x9bf45ab47747f4b4dd09b3c2c73953484b4eb375",
        "yt": "1-0x31f9e6692e87d81ff8d64de1f475fce6880a030f",
        "sy": "1-0xc9bfebc79a722c05dc34bd2a227ef2db19fd1b8e",
        "underlyingAsset": "1-0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
        "accountingAsset": "1-0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
        "rewardTokens": [
          "1-0x808507121b80c02388fad14726482e061b8da827"
        ],
        "inputTokens": [
          "1-0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
          "1-0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
          "1-0x9d39a5de30e57443bff2a8307a4256c8797a3497"
        ],
        "outputTokens": [
          "1-0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
          "1-0x9d39a5de30e57443bff2a8307a4256c8797a3497"
        ],
        "details": {
          "liquidity": 1987125.1340318301,
          "totalTvl": 195717248.8418324,
          "tradingVolume": 0,
          "underlyingApy": 0.028208109966874062,
          "swapFeeApy": 0.0007597784669646224,
          "pendleApy": 0.001114938173900188,
          "ytFloatingApy": 0,
          "impliedApy": 0,
          "feeRate": 0.0009147076236166729,
          "yieldRange": {
            "min": 0.035,
            "max": 0.21999999999999997
          },
          "aggregatedApy": 0.003140627846696326,
          "maxBoostedApy": 0.004813035107546607,
          "totalPt": 13685982.771487752,
          "totalSy": 632363.9441677389,
          "totalSupply": 5775664.4219186185,
          "totalActiveSupply": 2419795.5830998155,
          "ytRoi": -1,
          "ptRoi": 9.780710574780471e-8
        },
        "isNew": false,
        "isPrime": true,
        "timestamp": "2025-12-27T04:35:35.000Z",
        "categoryIds": [
          "stables",
          "points",
          "ethena"
        ],
        "isVolatile": false,
        "underlyingRewardApyBreakdown": [],
        "lpRewardApyBreakdown": [],
        "ytApyBreakdown": {
          "categories": [
            {
              "label": "Protocol Yield",
              "apy": 0.028208109966874062,
              "items": [
                {
                  "id": "1-0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
                  "apy": 0.028208109966874062,
                  "tags": [
                    "INTEREST",
                    "AUTO"
                  ],
                  "source": "CONTRACT"
                }
              ]
            }
          ]
        },
        "lpApyBreakdown": {
          "categories": [
            {
              "label": "Underlying Yield",
              "apy": 0.0012658991812809519,
              "items": [
                {
                  "id": "1-0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
                  "apy": 0.0012658991812809519,
                  "tags": [
                    "INTEREST",
                    "AUTO"
                  ],
                  "source": "CONTRACT"
                }
              ]
            },
            {
              "label": "PT Fixed Yield",
              "apy": 0,
              "items": [
                {
                  "id": "1-0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
                  "apy": 0,
                  "tags": [
                    "FIXED_YIELD",
                    "AUTO"
                  ]
                }
              ]
            },
            {
              "label": "LP Rewards",
              "apy": 0.0012057537365246975,
              "items": [
                {
                  "id": "1-0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654",
                  "apy": 0.0007597784669646224,
                  "tags": [
                    "SWAP_FEE",
                    "AUTO"
                  ]
                },
                {
                  "id": "PENDLE",
                  "apy": 0.00044597526956007525,
                  "tags": [
                    "INCENTIVE",
                    "BOOSTABLE"
                  ]
                }
              ]
            }
          ]
        },
        "chainId": 1,
        "points": [
          {
            "key": "Strata",
            "type": "multiplier",
            "pendleAsset": "basic",
            "value": 60,
            "perDollarLp": null
          },
          {
            "key": "Ethena",
            "type": "multiplier",
            "pendleAsset": "basic",
            "value": 35,
            "perDollarLp": null
          }
        ],
        "marketInfo": {
          "assetDescription": "<p>Senior USDe (srUSDe) is an over-collateralized, yield-bearing synthetic dollar backed by USDe, representing the senior risk tranche in Strata’s structure. It offers superior risk-adjusted yield by providing principal-protection and guaranteed minimum yield tied to the benchmark rate (Supply-weighted average of USDC/USDT lending rates on Aave Core) and uncapped upside exposure to sUSDe APY.</p>\n<p>srUSDe always earns a share of the yield generated by the protocol on the pooled USDe collateral by staking USDe. Its yield has a floor equivalent to the benchmark rate ensuring uncapped upside exposure to sUSDe APY with minimum guaranteed yield. In extreme scenarios (jrUSDe TVL ~ 0, sUSDe APY &lt; benchmark rate), srUSDe APY will be equivalent to the sUSDe APY.</p>",
          "riskInvolved": "<p>This pool has minimal risk of generating negative yield</p>",
          "importantQuirks": "<ul>\n<li>Instant withdrawal to sUSDe is subjected to 0.025% redemption fee.</li>\n</ul>\n",
          "initiatedBy": "Strata",
          "conversionRate": {
            "rate": 1.0169016924486358,
            "fromUnit": "srUSDe",
            "toUnit": "USDe staked in Strata Senior Tranche"
          },
          "utilizedProtocols": [
            {
              "id": "strata",
              "url": "https://www.strata.money/",
              "name": "Strata",
              "imageUrl": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/e6c3c470-66d1-46ba-bc9c-6ad0645e8b1e.svg"
            },
            {
              "id": "ethena",
              "url": "https://app.ethena.fi/",
              "name": "Ethena",
              "imageUrl": "https://storage.googleapis.com/prod-pendle-bucket-a/images/uploads/d0918b29-562c-4534-ae7c-089646d37a65.svg"
            }
          ],
          "deposit": {
            "url": "https://app.strata.money/#/buy-and-earn",
            "description": "Pendle Router automatically finds the best route between native minting and DEX swapping"
          },
          "withdrawal": {
            "url": "https://app.strata.money/#/buy-and-earn",
            "description": "Pendle Router automatically finds the best route between native withdrawal and DEX swapping"
          }
        }
      }
    ]
  };

/** `GET /v1/sdk/1/markets/{matured market}/tokens` — served for matured markets too. */
export const PENDLE_MARKET_TOKENS: unknown = {
    "tokensMintSy": [
      "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
      "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
      "0x9d39a5de30e57443bff2a8307a4256c8797a3497"
    ],
    "tokensRedeemSy": [
      "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
      "0x9d39a5de30e57443bff2a8307a4256c8797a3497"
    ],
    "tokensIn": [
      "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
      "0xc9bfebc79a722c05dc34bd2a227ef2db19fd1b8e",
      "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
      "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
      "0x111111111117dc0aa78b770fa6a738034120c302",
      "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9",
      "0xe95a203b1a91a908f9b9ce46459d101078c2c3cb",
      "0xb50721bcf8d664c30412cfbc6cf7a15145234ad1",
      "0xbe0ed4138121ecfc5c0e56b40517da27e6c5226b",
      "0xc0c293ce456ff0ed870add98a0828dd4d2903dbf",
      "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
      "0xba100000625a3754423978a60c9317c58a424e3d",
      "0x97ad75064b20fb2b2447fed4fa953bf7f007a706",
      "0xb8c77482e45f1f44de1745f52c74426c631bdd52",
      "0x152649ea73beab28c5b49b26eb48f7ead6d4c898",
      "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
      "0xc00e94cb662c3520282e6f5717214004a7f26888",
      "0xd533a949740bb3306d119cc777fa900ba034cd52",
      "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e",
      "0xad55aebc9b8c03fc43cd9f62260391c13c23e7c0",
      "0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b",
      "0x6b175474e89094c44da98b954eedeac495271d0f",
      "0x865377367054516e17014ccded1e7d814edc9ce4",
      "0x657e8c867d8b37dcc18fa4caead9c45eb088c642",
      "0x35fa164735182de50811e8e2e824cfb9b6118ac2",
      "0xec53bf9167f50cdeb3ae105f56099aaab9061f83",
      "0x57e114b691db790c35207b2e685d4a43181e6061",
      "0xc18360217d8f7ab5e7c516566761ea12ce7f9d72",
      "0x0000000000000000000000000000000000000000",
      "0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb",
      "0xa35b1b31ce002fbf2058d22f30f95d405200a15b",
      "0x1a7e4e63778b4f12a199c062f3efdd288afcbce8",
      "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c",
      "0x90d2af7d622ca3141efa4d8f1f24d86e5974cc8f",
      "0xbf5495efe5db9ce00f80364c8b423567e58d2110",
      "0xc96de26018a54d51c097160568752c4e3bd6c364",
      "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409",
      "0xaea46a60368a7bd060eec7df8cba43b7ef41ad85",
      "0xcf0c122c6b73ff809c693db761e7baebe62b6a2e",
      "0x6f40d4a6237c257fff2db00fa0510deeecd303eb",
      "0x853d955acef822db058eb8505911ed77f175b99e",
      "0x5e8422345238f34275888049021821e8e08caa1f",
      "0x085780639cc2cacd35e474e71f4d000e2405d8f6",
      "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f",
      "0xc944e90c64b2c07662a292be6244bdf05cda44a7",
      "0xc824a08db624942c5e5f330d56530cd1598859fd",
      "0xe28b3b32b6c345a34ff64674606124dd5aceca30",
      "0x8f08b70456eb22f6109f57b8fafe862ed28e6040",
      "0x8236a87084f8b84306f72007f36f2618a5634494",
      "0x5a98fcbea516cf06857215779fd812ca3bef1b32",
      "0x514910771af9ca656af840dff83e8264ecf986ca",
      "0x7c1156e515aa1a2e851674120074968c905aaf37",
      "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2",
      "0x3c3a81e81dc49a522a592e7622a7e711c06bf354",
      "0x58d97b57bb95320f9a05dc918aef65434969c2b2",
      "0x64351fc9810adad17a690e4e1717df5e7e085160",
      "0xab5eb14c09d416f0ac63661e57edb7aecdb9befa",
      "0x856c4efb76c1d1ae02e20ceb03a2a6a08b0b8dc3",
      "0x45804880de22913dafe09f4980848ece6ecbaf78",
      "0x808507121b80c02388fad14726482e061b8da827",
      "0x6982508145454ce325ddbe47a25d4ec3d2311933",
      "0xd9a442856c234a39a81a089c06451ebaa4306a72",
      "0x4d1c297d39c5c1277964d0e3f8aa901493664530",
      "0xf469fbd2abcd6b9de8e169d128226c0fc90a012e",
      "0x04c154b66cb340f3ae24111cc767e0184ed00cc6",
      "0x6c3ea9036406852006290770bedfcaba0e23a0e8",
      "0x8c9532a60e0e7c6bbd2b2c1303f63ace1c3e9811",
      "0x84631c0d0081fde56deb72f6de77abbbf6a9f93a",
      "0xae78736cd615f374d3085123a210448e74fc6393",
      "0x4956b52ae2ff65d74ca2d61207523288e4528f96",
      "0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
      "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7",
      "0x7a4effd87c2f3c55ca251080b1343b605f327e3a",
      "0xfae103dc9cf190ed75350761e95403b7b8afa6c0",
      "0x83f20f44975d03b1b09e64809b757c47f942beea",
      "0xd1b5651e55d4ceed36251c61c50c889b36f6abb5",
      "0x8be3460a480c80728a8c4d7a5d5303c85ba7b3b9",
      "0xa663b02cf0a4b149d2ad41910cb81e23e1c41c32",
      "0xac3e018457b222d93114458476f3e3416abbe38f",
      "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce",
      "0x56072c95faa701256059aa122697b133aded9279",
      "0x4737d9b4592b40d51e110b94c9c043c6654067ae",
      "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f",
      "0x7a56e1c57c7475ccf742a1832b028f0456652f97",
      "0x9559aaa82d9649c7a7b220e7c461d2e74c9a3593",
      "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
      "0xaf5191b0de278c7286d6c7cc6ab6bb8a73ba2cd6",
      "0x7122985656e38bdc0302db86685bb972b145bd3c",
      "0xb60acd2057067dc9ed8c083f5aa227a244044fd6",
      "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
      "0xe24a3dc889621612422a64e6388927901608b91d",
      "0x0a6e7ba5042b38349e437ec6db6214aec7b35676",
      "0xf951e335afb289353dc249e82926178eac7ded78",
      "0x643c4e15d7d62ad0abec4a9bd4b001aa3ef52d66",
      "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
      "0x18084fba666a33d37592fa2633fd49a74dd93a88",
      "0xd11c452fc99cf405034ee446803b6f6c1f6d5ed8",
      "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
      "0x004e9c3ef86bc1ca1f0bb5c7662861ee93350568",
      "0xf1376bcef0f78459c0ed0ba5ddce976f1ddf51f4",
      "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5",
      "0x35d8949372d46b7a3d5a56006ae77b215fc69bc0",
      "0x0000206329b97db379d5e1bf586bbdb969c63274",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "0xfa2b947eec368f42195f24f36d2af29f7c24cec2",
      "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
      "0xbdc7c08592ee4aa51d06c27ee23d5087d65adbcd",
      "0xdc035d45d973e3ec169d2276ddab16f1e407384f",
      "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "0xda67b4284609d2d48e5d10cfac411572727dc1ed",
      "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110",
      "0xc4441c2be5d8fa8126822b9929ca0b81ea0de38e",
      "0x06b964d96f5dcf7eae9d7c559b09edce244d4b8e",
      "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
      "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee",
      "0x7223442cad8e9ca474fc40109ab981608f8c4273",
      "0x917cee801a67f933f2e6b33fc0cd1ed2d5909d88",
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "0x163f8c2467924be0ae7b5347228cabf260318753",
      "0x437cc33344a0b27a429f795ff6b469c72698b291",
      "0x4691937a7508860f876c9c0a2a617e7d9e945d4b",
      "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
      "0x77e06c9eccf2e797fd462a92b6d7642ef85b0a44",
      "0x7751e2f4b8ae93ef6b79d86419d42fe3295a4559",
      "0xd9d920aa40f578ab794426f5c90f6c731d159def",
      "0xe868084cf08f3c3db11f4b73a95473762d9463f7",
      "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a",
      "0x6985884c4392d348587b19cb9eaaf157f13271cd"
    ],
    "tokensOut": [
      "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
      "0xc9bfebc79a722c05dc34bd2a227ef2db19fd1b8e",
      "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
      "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
      "0x111111111117dc0aa78b770fa6a738034120c302",
      "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9",
      "0xe95a203b1a91a908f9b9ce46459d101078c2c3cb",
      "0xb50721bcf8d664c30412cfbc6cf7a15145234ad1",
      "0xbe0ed4138121ecfc5c0e56b40517da27e6c5226b",
      "0xc0c293ce456ff0ed870add98a0828dd4d2903dbf",
      "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
      "0xba100000625a3754423978a60c9317c58a424e3d",
      "0x97ad75064b20fb2b2447fed4fa953bf7f007a706",
      "0xb8c77482e45f1f44de1745f52c74426c631bdd52",
      "0x152649ea73beab28c5b49b26eb48f7ead6d4c898",
      "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
      "0xc00e94cb662c3520282e6f5717214004a7f26888",
      "0xd533a949740bb3306d119cc777fa900ba034cd52",
      "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e",
      "0xad55aebc9b8c03fc43cd9f62260391c13c23e7c0",
      "0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b",
      "0x6b175474e89094c44da98b954eedeac495271d0f",
      "0x865377367054516e17014ccded1e7d814edc9ce4",
      "0x657e8c867d8b37dcc18fa4caead9c45eb088c642",
      "0x35fa164735182de50811e8e2e824cfb9b6118ac2",
      "0xec53bf9167f50cdeb3ae105f56099aaab9061f83",
      "0x57e114b691db790c35207b2e685d4a43181e6061",
      "0xc18360217d8f7ab5e7c516566761ea12ce7f9d72",
      "0x0000000000000000000000000000000000000000",
      "0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb",
      "0xa35b1b31ce002fbf2058d22f30f95d405200a15b",
      "0x1a7e4e63778b4f12a199c062f3efdd288afcbce8",
      "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c",
      "0x90d2af7d622ca3141efa4d8f1f24d86e5974cc8f",
      "0xbf5495efe5db9ce00f80364c8b423567e58d2110",
      "0xc96de26018a54d51c097160568752c4e3bd6c364",
      "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409",
      "0xaea46a60368a7bd060eec7df8cba43b7ef41ad85",
      "0xcf0c122c6b73ff809c693db761e7baebe62b6a2e",
      "0x6f40d4a6237c257fff2db00fa0510deeecd303eb",
      "0x853d955acef822db058eb8505911ed77f175b99e",
      "0x5e8422345238f34275888049021821e8e08caa1f",
      "0x085780639cc2cacd35e474e71f4d000e2405d8f6",
      "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f",
      "0xc944e90c64b2c07662a292be6244bdf05cda44a7",
      "0xc824a08db624942c5e5f330d56530cd1598859fd",
      "0xe28b3b32b6c345a34ff64674606124dd5aceca30",
      "0x8f08b70456eb22f6109f57b8fafe862ed28e6040",
      "0x8236a87084f8b84306f72007f36f2618a5634494",
      "0x5a98fcbea516cf06857215779fd812ca3bef1b32",
      "0x514910771af9ca656af840dff83e8264ecf986ca",
      "0x7c1156e515aa1a2e851674120074968c905aaf37",
      "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2",
      "0x3c3a81e81dc49a522a592e7622a7e711c06bf354",
      "0x58d97b57bb95320f9a05dc918aef65434969c2b2",
      "0x64351fc9810adad17a690e4e1717df5e7e085160",
      "0xab5eb14c09d416f0ac63661e57edb7aecdb9befa",
      "0x856c4efb76c1d1ae02e20ceb03a2a6a08b0b8dc3",
      "0x45804880de22913dafe09f4980848ece6ecbaf78",
      "0x808507121b80c02388fad14726482e061b8da827",
      "0x6982508145454ce325ddbe47a25d4ec3d2311933",
      "0xd9a442856c234a39a81a089c06451ebaa4306a72",
      "0x4d1c297d39c5c1277964d0e3f8aa901493664530",
      "0xf469fbd2abcd6b9de8e169d128226c0fc90a012e",
      "0x04c154b66cb340f3ae24111cc767e0184ed00cc6",
      "0x6c3ea9036406852006290770bedfcaba0e23a0e8",
      "0x8c9532a60e0e7c6bbd2b2c1303f63ace1c3e9811",
      "0x84631c0d0081fde56deb72f6de77abbbf6a9f93a",
      "0xae78736cd615f374d3085123a210448e74fc6393",
      "0x4956b52ae2ff65d74ca2d61207523288e4528f96",
      "0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
      "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7",
      "0x7a4effd87c2f3c55ca251080b1343b605f327e3a",
      "0xfae103dc9cf190ed75350761e95403b7b8afa6c0",
      "0x83f20f44975d03b1b09e64809b757c47f942beea",
      "0xd1b5651e55d4ceed36251c61c50c889b36f6abb5",
      "0x8be3460a480c80728a8c4d7a5d5303c85ba7b3b9",
      "0xa663b02cf0a4b149d2ad41910cb81e23e1c41c32",
      "0xac3e018457b222d93114458476f3e3416abbe38f",
      "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce",
      "0x56072c95faa701256059aa122697b133aded9279",
      "0x4737d9b4592b40d51e110b94c9c043c6654067ae",
      "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f",
      "0x7a56e1c57c7475ccf742a1832b028f0456652f97",
      "0x9559aaa82d9649c7a7b220e7c461d2e74c9a3593",
      "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
      "0xaf5191b0de278c7286d6c7cc6ab6bb8a73ba2cd6",
      "0x7122985656e38bdc0302db86685bb972b145bd3c",
      "0xb60acd2057067dc9ed8c083f5aa227a244044fd6",
      "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
      "0xe24a3dc889621612422a64e6388927901608b91d",
      "0x0a6e7ba5042b38349e437ec6db6214aec7b35676",
      "0xf951e335afb289353dc249e82926178eac7ded78",
      "0x643c4e15d7d62ad0abec4a9bd4b001aa3ef52d66",
      "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
      "0x18084fba666a33d37592fa2633fd49a74dd93a88",
      "0xd11c452fc99cf405034ee446803b6f6c1f6d5ed8",
      "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
      "0x004e9c3ef86bc1ca1f0bb5c7662861ee93350568",
      "0xf1376bcef0f78459c0ed0ba5ddce976f1ddf51f4",
      "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5",
      "0x35d8949372d46b7a3d5a56006ae77b215fc69bc0",
      "0x0000206329b97db379d5e1bf586bbdb969c63274",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "0xfa2b947eec368f42195f24f36d2af29f7c24cec2",
      "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
      "0xbdc7c08592ee4aa51d06c27ee23d5087d65adbcd",
      "0xdc035d45d973e3ec169d2276ddab16f1e407384f",
      "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "0xda67b4284609d2d48e5d10cfac411572727dc1ed",
      "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110",
      "0xc4441c2be5d8fa8126822b9929ca0b81ea0de38e",
      "0x06b964d96f5dcf7eae9d7c559b09edce244d4b8e",
      "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
      "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee",
      "0x7223442cad8e9ca474fc40109ab981608f8c4273",
      "0x917cee801a67f933f2e6b33fc0cd1ed2d5909d88",
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "0x163f8c2467924be0ae7b5347228cabf260318753",
      "0x437cc33344a0b27a429f795ff6b469c72698b291",
      "0x4691937a7508860f876c9c0a2a617e7d9e945d4b",
      "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
      "0x77e06c9eccf2e797fd462a92b6d7642ef85b0a44",
      "0x7751e2f4b8ae93ef6b79d86419d42fe3295a4559",
      "0xd9d920aa40f578ab794426f5c90f6c731d159def",
      "0xe868084cf08f3c3db11f4b73a95473762d9463f7",
      "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a",
      "0x6985884c4392d348587b19cb9eaaf157f13271cd"
    ]
  };

/** `GET /v1/sdk/1/markets/{active market}/swapping-prices`. */
export const PENDLE_SWAPPING_PRICES: unknown = {
    "underlyingToken": "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    "underlyingTokenToPtRate": 1.279499822417471,
    "ptToUnderlyingTokenRate": 0.7800959822028567,
    "underlyingTokenToYtRate": 33.50853392094492,
    "ytToUnderlyingTokenRate": 0.024769377284453577,
    "impliedApy": 0.02276412113952293
  };

/** `GET /v3/1/markets/{active market}/historical-data` — 8 daily points, 3 selected fields. */
export const PENDLE_MARKET_HISTORY: unknown = {
    "total": 8,
    "timestamp_start": "2026-07-20T00:00:00.000Z",
    "timestamp_end": "2026-07-27T00:00:00.000Z",
    "results": [
      {
        "timestamp": "2026-07-20T00:00:00.000Z",
        "impliedApy": 0.022749282949949823,
        "tvl": 3465165.4572149003,
        "ptPrice": 1838.2372174557609
      },
      {
        "timestamp": "2026-07-21T00:00:00.000Z",
        "impliedApy": 0.022749282962437167,
        "tvl": 3520832.9192051333,
        "ptPrice": 1867.770885169349
      },
      {
        "timestamp": "2026-07-22T00:00:00.000Z",
        "impliedApy": 0.022749282974972473,
        "tvl": 3521484.65949884,
        "ptPrice": 1868.1186349179723
      },
      {
        "timestamp": "2026-07-23T00:00:00.000Z",
        "impliedApy": 0.022749282987555297,
        "tvl": 3428633.521518936,
        "ptPrice": 1818.8660109475404
      },
      {
        "timestamp": "2026-07-24T00:00:00.000Z",
        "impliedApy": 0.022749283000186304,
        "tvl": 3391723.3520032195,
        "ptPrice": 1799.2886006947972
      },
      {
        "timestamp": "2026-07-25T00:00:00.000Z",
        "impliedApy": 0.02274848698156262,
        "tvl": 3413956.417885785,
        "ptPrice": 1810.9756134262682
      },
      {
        "timestamp": "2026-07-26T00:00:00.000Z",
        "impliedApy": 0.022841507195406452,
        "tvl": 3567969.8501898763,
        "ptPrice": 1892.4391375465682
      },
      {
        "timestamp": "2026-07-27T00:00:00.000Z",
        "impliedApy": 0.022764127796852218,
        "tvl": 3542391.7571333637,
        "ptPrice": 1879.0332779112755
      }
    ]
  };

/** `GET /v4/1/prices/{active PT}/ohlcv` — CSV-in-JSON, 8 daily candles, 4 with empty volume (rows 2-5). */
export const PENDLE_ASSET_OHLCV: unknown = {
    "total": 8,
    "currency": "USD",
    "timeFrame": "day",
    "timestamp_start": 1784505600,
    "timestamp_end": 1785110400,
    "results": "time,open,high,low,close,volume\n1784505600,1812.6885,1850.6601,1789.9877,1838.2372,0.1912\n1784592000,1838.2376,1882.0950,1838.2376,1867.7709,\n1784678400,1867.7713,1891.8848,1849.9909,1868.1186,\n1784764800,1868.1190,1874.0982,1812.7984,1818.8660,\n1784851200,1818.8664,1840.7762,1793.6115,1799.2886,\n1784937600,1799.2890,1810.9756,1793.5031,1810.9756,11.8288\n1785024000,1810.9760,1900.3180,1810.9760,1892.4391,1403.7784\n1785110400,1892.4395,1912.7685,1862.9684,1879.0333,1219.2190"
  };

/** `GET /v1/prices/assets?ids=…` — USD price MAP keyed by `chainId-address`. */
export const PENDLE_ASSET_PRICES: unknown = {
    "prices": {
      "1-0xb253eff1104802b97ac7e3ac9fdd73aece295a2c": 1879.0335032268176,
      "1-0x34280882267ffa6383b363e278b027be083bbe3b": 4299.640549070807
    },
    "total": 2,
    "skip": 0
  };

/** `GET /v1/dashboard/merkle-rewards/{user}` — NON-EMPTY; `user` sanitised. */
export const PENDLE_MERKLE_REWARDS: unknown = {
    "claimableRewards": [
      {
        "user": "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e",
        "token": "0x01ba69727e2860b37bc1a2bd56999c1afb4c15d8",
        "merkleRoot": "0x00a1d9cbdaee03ad8c95d173aa1046e417b11ec6704991368baa0c52b3b1a946",
        "chainId": 1,
        "assetId": "1-0xfce3f966a131c46a51b896ceea3917bc4c302577",
        "amount": "21629940315250",
        "toTimestamp": "2026-07-23T00:00:00.000Z",
        "fromTimestamp": "2026-07-16T00:00:00.000Z"
      },
      {
        "user": "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e",
        "token": "0x1d926bbe67425c9f507b9a0e8030eedc7880bf33",
        "merkleRoot": "0x00a1d9cbdaee03ad8c95d173aa1046e417b11ec6704991368baa0c52b3b1a946",
        "chainId": 1,
        "assetId": "1-0x384509537ce5daa5740baeb6d1ee0eb2847ea8a8",
        "amount": "297796490545500",
        "toTimestamp": "2026-07-23T00:00:00.000Z",
        "fromTimestamp": "2026-07-16T00:00:00.000Z"
      },
      {
        "user": "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e",
        "token": "0x1d926bbe67425c9f507b9a0e8030eedc7880bf33",
        "merkleRoot": "0x00a1d9cbdaee03ad8c95d173aa1046e417b11ec6704991368baa0c52b3b1a946",
        "chainId": 1,
        "assetId": "1-0x61703e1ea2887fffd4b5f777bafd6abd7122bcf9",
        "amount": "113258067921250",
        "toTimestamp": "2026-07-23T00:00:00.000Z",
        "fromTimestamp": "2026-07-16T00:00:00.000Z"
      },
      {
        "user": "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e",
        "token": "0x365accfca291e7d3914637abf1f7635db165bb09",
        "merkleRoot": "0x00a1d9cbdaee03ad8c95d173aa1046e417b11ec6704991368baa0c52b3b1a946",
        "chainId": 1,
        "assetId": "1-0x8308e53f584a7e5f0c581059d9ba971c0bec9454",
        "amount": "1316787501200",
        "toTimestamp": "2026-07-23T00:00:00.000Z",
        "fromTimestamp": "2026-07-16T00:00:00.000Z"
      },
      {
        "user": "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e",
        "token": "0x808507121b80c02388fad14726482e061b8da827",
        "merkleRoot": "0x00a1d9cbdaee03ad8c95d173aa1046e417b11ec6704991368baa0c52b3b1a946",
        "chainId": 1,
        "assetId": "1-0x1f40b9a1d21afedbe3c49776e7790ed2139ec075",
        "amount": "792685546250",
        "toTimestamp": "2026-07-24T00:00:00.000Z",
        "fromTimestamp": "2026-07-16T00:00:00.000Z"
      },
      {
        "user": "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e",
        "token": "0x808507121b80c02388fad14726482e061b8da827",
        "merkleRoot": "0x00a1d9cbdaee03ad8c95d173aa1046e417b11ec6704991368baa0c52b3b1a946",
        "chainId": 1,
        "assetId": "1-0xfce3f966a131c46a51b896ceea3917bc4c302577",
        "amount": "2229612138008",
        "toTimestamp": "2026-07-24T00:00:00.000Z",
        "fromTimestamp": "2026-07-16T00:00:00.000Z"
      },
      {
        "user": "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e",
        "token": "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
        "merkleRoot": "0x00a1d9cbdaee03ad8c95d173aa1046e417b11ec6704991368baa0c52b3b1a946",
        "chainId": 1,
        "assetId": "1-0xf80b67a32df07960c731794769309e3d30e9717f",
        "amount": "76",
        "toTimestamp": "2026-07-24T00:00:00.000Z",
        "fromTimestamp": "2026-07-17T00:00:00.000Z"
      }
    ],
    "claimedRewards": []
  };

/** `GET /v2/limit-orders/book/1?market=…&precisionDecimal=2`. */
export const PENDLE_ORDERBOOK: unknown = {
    "longYieldEntries": [
      {
        "impliedApy": 0.1052,
        "limitOrderSize": "1921533336",
        "incentiveQualifiedPySize": "1921533336"
      },
      {
        "impliedApy": 0.102,
        "limitOrderSize": "10502821741",
        "incentiveQualifiedPySize": "10502821741"
      },
      {
        "impliedApy": 0.1019,
        "limitOrderSize": "32673312128",
        "incentiveQualifiedPySize": "32673312128"
      },
      {
        "impliedApy": 0.1017,
        "limitOrderSize": "70425201856",
        "incentiveQualifiedPySize": "70425201856"
      },
      {
        "impliedApy": 0.1,
        "limitOrderSize": "13974801428",
        "incentiveQualifiedPySize": "0"
      }
    ],
    "shortYieldEntries": [
      {
        "impliedApy": 0.1086,
        "limitOrderSize": "697423972",
        "incentiveQualifiedPySize": "697423972"
      }
    ]
  };

/** Same book with `includeAmm=true` — rows gain `ammSize`. */
export const PENDLE_ORDERBOOK_WITH_AMM: unknown = {
    "longYieldEntries": [
      {
        "impliedApy": 0.1052,
        "limitOrderSize": "1921533336",
        "ammSize": "661024894",
        "incentiveQualifiedPySize": "2582558230"
      },
      {
        "impliedApy": 0.1051,
        "limitOrderSize": "0",
        "ammSize": "966025710",
        "incentiveQualifiedPySize": "966025710"
      },
      {
        "impliedApy": 0.105,
        "limitOrderSize": "0",
        "ammSize": "965871173",
        "incentiveQualifiedPySize": "965871173"
      },
      {
        "impliedApy": 0.1049,
        "limitOrderSize": "0",
        "ammSize": "965706907",
        "incentiveQualifiedPySize": "965706907"
      },
      {
        "impliedApy": 0.1048,
        "limitOrderSize": "0",
        "ammSize": "965532917",
        "incentiveQualifiedPySize": "965532917"
      },
      {
        "impliedApy": 0.1047,
        "limitOrderSize": "0",
        "ammSize": "965349207",
        "incentiveQualifiedPySize": "965349207"
      },
      {
        "impliedApy": 0.1046,
        "limitOrderSize": "0",
        "ammSize": "965155784",
        "incentiveQualifiedPySize": "965155784"
      },
      {
        "impliedApy": 0.1045,
        "limitOrderSize": "0",
        "ammSize": "964952654",
        "incentiveQualifiedPySize": "964952654"
      },
      {
        "impliedApy": 0.1044,
        "limitOrderSize": "0",
        "ammSize": "964739822",
        "incentiveQualifiedPySize": "964739822"
      },
      {
        "impliedApy": 0.1043,
        "limitOrderSize": "0",
        "ammSize": "964517297",
        "incentiveQualifiedPySize": "964517297"
      }
    ],
    "shortYieldEntries": [
      {
        "impliedApy": 0.1053,
        "limitOrderSize": "0",
        "ammSize": "305171512",
        "incentiveQualifiedPySize": "305171512"
      },
      {
        "impliedApy": 0.1054,
        "limitOrderSize": "0",
        "ammSize": "966387829",
        "incentiveQualifiedPySize": "966387829"
      },
      {
        "impliedApy": 0.1055,
        "limitOrderSize": "0",
        "ammSize": "966513550",
        "incentiveQualifiedPySize": "966513550"
      },
      {
        "impliedApy": 0.1056,
        "limitOrderSize": "0",
        "ammSize": "966629527",
        "incentiveQualifiedPySize": "966629527"
      },
      {
        "impliedApy": 0.1057,
        "limitOrderSize": "0",
        "ammSize": "966735754",
        "incentiveQualifiedPySize": "966735754"
      },
      {
        "impliedApy": 0.1058,
        "limitOrderSize": "0",
        "ammSize": "966832230",
        "incentiveQualifiedPySize": "966832230"
      },
      {
        "impliedApy": 0.1059,
        "limitOrderSize": "0",
        "ammSize": "966918955",
        "incentiveQualifiedPySize": "966918955"
      },
      {
        "impliedApy": 0.106,
        "limitOrderSize": "0",
        "ammSize": "966995923",
        "incentiveQualifiedPySize": "966995923"
      },
      {
        "impliedApy": 0.1061,
        "limitOrderSize": "0",
        "ammSize": "967063136",
        "incentiveQualifiedPySize": "967063136"
      },
      {
        "impliedApy": 0.1062,
        "limitOrderSize": "0",
        "ammSize": "967120592",
        "incentiveQualifiedPySize": "967120592"
      }
    ]
  };

/** The synthetic wallet that replaced the probed holder in `PENDLE_MERKLE_REWARDS`. */
export const PENDLE_MERKLE_FIXTURE_WALLET = "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e";
