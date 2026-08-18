/**
 * Morpho VAULT GraphQL fixtures - captured VERBATIM from the live keyless
 * endpoint `https://api.morpho.org/graphql` on 2026-08-14. Nothing is
 * synthesized; numeric and structural truth is byte-exact as returned. Rows were
 * TRIMMED (fewer items, shorter allocation and timelock lists) but never edited.
 *
 * NO SANITISATION WAS NEEDED. Every body here is public catalogue data: token
 * contracts, market ids, and PUBLIC vault, curator, guardian and sentinel
 * contract addresses. No third-party wallet appears, so rules/06 required
 * nothing to be replaced.
 *
 * Regenerate (keyless; POST with `Content-Type: application/json`). The exact
 * documents are in `src/tools/morpho/queries-vaults.ts`:
 *
 *   MORPHO_VAULTS_V1_PAGE     query VexMorphoVaultsV1, variables
 *     {"first":50,"skip":0,"orderBy":"TotalAssetsUsd","orderDirection":"Desc","where":{"listed":true}}
 *   MORPHO_VAULTS_V2_PAGE     query VexMorphoVaultsV2, same variables
 *   MORPHO_VAULT_V1_DETAIL    query VexMorphoVaultV1, variables
 *     {"address":"0xbeefFF209270748ddd194831b3fa287a5386f5bC","chainId":1}
 *   MORPHO_VAULT_V2_DETAIL_GATED  query VexMorphoVaultV2, variables
 *     {"address":"0x01Fb7F4f156256bc0084421330305bA50a83501B","chainId":8453}
 *   MORPHO_VAULT_NOT_FOUND    query VexMorphoVaultV1, variables
 *     {"address":"0x0000000000000000000000000000000000000001","chainId":1}
 *   MORPHO_VAULTS_V1_UNORDERED
 *     {vaults(first:5){items{address name symbol listed chain{id} state{totalAssetsUsd netApy}}}}
 *
 * SHAPE FACTS these bodies pin, each of which shaped a decision in the code:
 *
 *   - V1 NESTS EVERYTHING UNDER `state`; V2 IS FLAT. `Vault.state.totalAssets`
 *     versus `VaultV2.totalAssets`. One document cannot cover both, which is why
 *     `queries-vaults.ts` holds four.
 *
 *   - A VAULT `netApy` IS `apy` AFTER THE FEE. Steakhouse USDC reports
 *     apy 0.041208 with fee 0.25 and netApy 0.030750; Steakhouse USDT reports
 *     apy 0.030737 with fee 0.05 and netApy 0.029178. This is the arithmetic
 *     behind the rule that a vault APY and a market APY are different bases.
 *
 *   - THE `BigInt` SCALAR STILL ARRIVES IN TWO FORMS. `totalAssets` comes back
 *     as a JSON number and `totalSupply` as a JSON string in the SAME row.
 *
 *   - V2 FEES ARE FRACTIONS ON OUTPUT AND WAD ON INPUT. `performanceFee: 0.2`
 *     is returned, while `performanceFee_gte: "150000000000000000"` is what the
 *     filter takes. V1 is the opposite: `fee: 0.25` out, `fee_lte: 0.05` in.
 *
 *   - GATES ARE REAL AND LIVE. `Basecamp` carries a non-null
 *     `gatesConfig.sendAssetsGate.address`, so a gate contract decides whether
 *     assets may be sent into it. The other three gates on the same vault are
 *     `abdicated: true`, which is the opposite assurance.
 *
 *   - V2 HAS NO SINGLE TIMELOCK. It returns a per-function `timelocks[]` table
 *     whose durations range from 0 to 604800 seconds on one vault, some already
 *     `abdicatedAt` a timestamp. V1 has one `state.timelock` number.
 *
 *   - V2 ALLOCATIONS LIVE IN A UNION. `caps[].data` is
 *     `AdapterCapData | CollateralCapData | MarketV1CapData`; only the last
 *     names a market, so the other two are not allocations.
 *
 *   - A MISSING VAULT IS HTTP 200 WITH `data: null` AND
 *     `errors[{status: "NOT_FOUND"}]` - the same envelope as a removed field,
 *     which is why the client needs an explicit not-found hook.
 *
 *   - MORPHO'S UNORDERED VAULT LIST IS NOT A USEFUL DEFAULT. With no `orderBy`
 *     and no `listed` filter, the second row returned is a vault named
 *     `tstcntrct` and the fourth is named `Test`, both unlisted and holding
 *     about ten dollars between them. That is the whole case for
 *     `listedOnly: true`.
 */

export const MORPHO_VAULTS_V1_PAGE = {
  "data": {
    "vaults": {
      "pageInfo": {
        "countTotal": 98,
        "count": 3,
        "limit": 3,
        "skip": 0
      },
      "items": [
        {
          "address": "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
          "name": "Gauntlet USDC Prime",
          "symbol": "gtUSDCp",
          "listed": true,
          "creationTimestamp": 1717444929,
          "chain": {
            "id": 8453,
            "network": "Base"
          },
          "asset": {
            "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "symbol": "USDC",
            "decimals": 6,
            "price": {
              "usd": 0.9995626119677885
            }
          },
          "warnings": [],
          "state": {
            "totalAssets": 428244566852575,
            "totalAssetsUsd": 428057257.80417407,
            "totalSupply": "386748146094677377578468092",
            "apy": 0.04122726800100715,
            "netApy": 0.04122726800100715,
            "netApyExcludingRewards": 0.04122726800100715,
            "fee": 0,
            "timelock": 604800,
            "curator": "0x9E33faAE38ff641094fa68c65c2cE600b3410585",
            "owner": "0x5a4E19842e09000a582c20A4f524C26Fb48Dd4D0",
            "guardian": "0x7084bF4dB6c21e1834dD6482f6056a39A33584cD",
            "sharePriceNumber": 1.107295719906926,
            "sharePriceUsd": 1.1068114020109197,
            "allRewards": [],
            "curators": [
              {
                "id": "gauntlet",
                "name": "Gauntlet",
                "verified": true
              }
            ]
          }
        },
        {
          "address": "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183",
          "name": "Steakhouse USDC",
          "symbol": "steakUSDC",
          "listed": true,
          "creationTimestamp": 1717156251,
          "chain": {
            "id": 8453,
            "network": "Base"
          },
          "asset": {
            "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "symbol": "USDC",
            "decimals": 6,
            "price": {
              "usd": 0.9995626119677885
            }
          },
          "warnings": [],
          "state": {
            "totalAssets": 161134100252182,
            "totalAssetsUsd": 161063622.12515053,
            "totalSupply": "146710485882173579043114312",
            "apy": 0.04120813123981836,
            "netApy": 0.03074957230992715,
            "netApyExcludingRewards": 0.030749572334306436,
            "fee": 0.25,
            "timelock": 604800,
            "curator": "0x827e86072B06674a077f592A531dcE4590aDeCdB",
            "owner": "0x0A0e559bc3b0950a7e448F0d4894db195b9cf8DD",
            "guardian": "0x9e0FdDDa790651E6a05CD2dE69e624B94C04eAf5",
            "sharePriceNumber": 1.098313452397616,
            "sharePriceUsd": 1.0978330632379203,
            "allRewards": [],
            "curators": [
              {
                "id": "steakhouse-financial",
                "name": "Steakhouse Financial",
                "verified": true
              }
            ]
          }
        },
        {
          "address": "0xbEef047a543E45807105E51A8BBEFCc5950fcfBa",
          "name": "Steakhouse USDT",
          "symbol": "steakUSDT",
          "listed": true,
          "creationTimestamp": 1705697315,
          "chain": {
            "id": 1,
            "network": "Ethereum"
          },
          "asset": {
            "address": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            "symbol": "USDT",
            "decimals": 6,
            "price": {
              "usd": 0.9990546213507114
            }
          },
          "warnings": [],
          "state": {
            "totalAssets": 91465630925979,
            "totalAssetsUsd": 91379161.27135788,
            "totalSupply": "81078034000012685954893676",
            "apy": 0.03073734473882723,
            "netApy": 0.029178276530320995,
            "netApyExcludingRewards": 0.02917827653681223,
            "fee": 0.05,
            "timelock": 604800,
            "curator": "0x827e86072B06674a077f592A531dcE4590aDeCdB",
            "owner": "0x0A0e559bc3b0950a7e448F0d4894db195b9cf8DD",
            "guardian": "0xaeC761545Fd135db6d04D27C92BCB3951668c67F",
            "sharePriceNumber": 1.128118510199255,
            "sharePriceUsd": 1.1270520110458455,
            "allRewards": [],
            "curators": [
              {
                "id": "steakhouse-financial",
                "name": "Steakhouse Financial",
                "verified": true
              }
            ]
          }
        }
      ]
    }
  },
  "extensions": {
    "complexity": 23750,
    "maximumComplexity": 1000000
  }
} as const;

export const MORPHO_VAULTS_V2_PAGE = {
  "data": {
    "vaultV2s": {
      "pageInfo": {
        "countTotal": 169,
        "count": 3,
        "limit": 3,
        "skip": 0
      },
      "items": [
        {
          "address": "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9",
          "name": "Steakhouse Prime USDC",
          "symbol": "steakUSDC",
          "listed": true,
          "type": "MorphoVault",
          "creationTimestamp": 1761598627,
          "chain": {
            "id": 8453,
            "network": "Base"
          },
          "asset": {
            "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "symbol": "USDC",
            "decimals": 6,
            "price": {
              "usd": 0.9995626119677885
            }
          },
          "warnings": [],
          "totalAssets": 597137927491814,
          "totalAssetsUsd": 596876746.5087495,
          "totalSupply": "575948160841719731889415379",
          "idleAssets": 0,
          "idleAssetsUsd": 0,
          "liquidity": 198955156866961,
          "liquidityUsd": 198868136.26240063,
          "sharePrice": 1.036791100468358,
          "apy": 0.041210819108469514,
          "netApy": 0.041210819108469514,
          "netApyExcludingRewards": 0.041210819108469514,
          "maxApy": 6.389056098807342,
          "performanceFee": 0,
          "managementFee": 0,
          "curator": {
            "address": "0x827e86072B06674a077f592A531dcE4590aDeCdB"
          },
          "owner": {
            "address": "0x639bfA26472906Ccd40513408284a8aD292bC5D6"
          },
          "curators": {
            "items": [
              {
                "id": "steakhouse-financial",
                "name": "Steakhouse Financial",
                "verified": true
              }
            ]
          },
          "rewards": [],
          "gatesConfig": {
            "sendSharesGate": {
              "address": null,
              "abdicated": true
            },
            "receiveSharesGate": {
              "address": null,
              "abdicated": true
            },
            "receiveAssetsGate": {
              "address": null,
              "abdicated": true
            },
            "sendAssetsGate": {
              "address": null,
              "abdicated": false
            }
          }
        },
        {
          "address": "0xbEEF00A59B577423653A1526c7009bdE103F542B",
          "name": "Steakhouse Confidential Prime USDC",
          "symbol": "steakcUSDC",
          "listed": true,
          "type": "MorphoVault",
          "creationTimestamp": 1781867411,
          "chain": {
            "id": 1,
            "network": "Ethereum"
          },
          "asset": {
            "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "symbol": "USDC",
            "decimals": 6,
            "price": {
              "usd": 0.9995626119677885
            }
          },
          "warnings": [],
          "totalAssets": 33738446211094,
          "totalAssetsUsd": 33723689.418495856,
          "totalSupply": "33258529568454013263162293",
          "idleAssets": 3143290364,
          "idleAssetsUsd": 3141.9155264130204,
          "liquidity": 29135471335761,
          "liquidityUsd": 29122727.829285897,
          "sharePrice": 1.014429881563229,
          "apy": 0.07199999719278122,
          "netApy": 0.07199999719278122,
          "netApyExcludingRewards": 0.07199999719278122,
          "maxApy": 0.07199999719278122,
          "performanceFee": 0,
          "managementFee": 0,
          "curator": {
            "address": "0x827e86072B06674a077f592A531dcE4590aDeCdB"
          },
          "owner": {
            "address": "0x4D7bd498Bb24098Ca281C05519629c605407f71d"
          },
          "curators": {
            "items": [
              {
                "id": "steakhouse-financial",
                "name": "Steakhouse Financial",
                "verified": true
              }
            ]
          },
          "rewards": [],
          "gatesConfig": {
            "sendSharesGate": {
              "address": null,
              "abdicated": true
            },
            "receiveSharesGate": {
              "address": null,
              "abdicated": true
            },
            "receiveAssetsGate": {
              "address": null,
              "abdicated": true
            },
            "sendAssetsGate": {
              "address": "0x47C591A3BC346913d0b6bDD96FB50E34efA268Aa",
              "abdicated": false
            }
          }
        },
        {
          "address": "0x6dC58a0FdfC8D694e571DC59B9A52EEEa780E6bf",
          "name": "Sentora RLUSD Main",
          "symbol": "senRLUSDv2",
          "listed": true,
          "type": "MorphoVault",
          "creationTimestamp": 1772667719,
          "chain": {
            "id": 1,
            "network": "Ethereum"
          },
          "asset": {
            "address": "0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD",
            "symbol": "RLUSD",
            "decimals": 18,
            "price": {
              "usd": 1.000065230213634
            }
          },
          "warnings": [],
          "totalAssets": "322826472264616630671518940",
          "totalAssetsUsd": 322847530.30436915,
          "totalSupply": "319829819068346630629215141",
          "idleAssets": "20224618450157142318920815",
          "idleAssetsUsd": 20225937.70633931,
          "liquidity": "20224618450157142318920815",
          "liquidityUsd": 20225937.70633931,
          "sharePrice": 1.0093695240956555,
          "apy": 0.028846164281599175,
          "netApy": 0.061276549762865395,
          "netApyExcludingRewards": 0.02592449345537679,
          "maxApy": 6.389056098807342,
          "performanceFee": 0.1,
          "managementFee": 0,
          "curator": {
            "address": "0x9e396dE3312D373b87F9BD8763fb48184b42aac0"
          },
          "owner": {
            "address": "0xe8C9C99EcaD0686A14A00d8521c572281E938008"
          },
          "curators": {
            "items": [
              {
                "id": "sentora",
                "name": "Sentora",
                "verified": true
              }
            ]
          },
          "rewards": [
            {
              "supplyApr": 0.035352056307488604,
              "asset": {
                "address": "0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD",
                "symbol": "RLUSD",
                "decimals": 18
              }
            }
          ],
          "gatesConfig": {
            "sendSharesGate": {
              "address": null,
              "abdicated": true
            },
            "receiveSharesGate": {
              "address": null,
              "abdicated": true
            },
            "receiveAssetsGate": {
              "address": null,
              "abdicated": true
            },
            "sendAssetsGate": {
              "address": null,
              "abdicated": false
            }
          }
        }
      ]
    }
  },
  "extensions": {
    "complexity": 317750,
    "maximumComplexity": 1000000
  }
} as const;

export const MORPHO_VAULT_V1_DETAIL = {
  "data": {
    "vaultByAddress": {
      "address": "0xBEeFFF209270748ddd194831b3fa287a5386f5bC",
      "name": "Smokehouse USDC",
      "symbol": "bbqUSDC",
      "listed": true,
      "creationTimestamp": 1733418911,
      "chain": {
        "id": 1,
        "network": "Ethereum"
      },
      "asset": {
        "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "symbol": "USDC",
        "decimals": 6,
        "price": {
          "usd": 0.9995626119677885
        }
      },
      "warnings": [],
      "liquidity": {
        "underlying": 8678604376112,
        "usd": 8674808.45842159
      },
      "allocators": [
        {
          "address": "0x9E9110cFd24cd851ea5bc73a27975B33E308f9e1"
        },
        {
          "address": "0x29d4CDFee8F533af8529A9e1517b580E022874f7"
        },
        {
          "address": "0xfd32fA2ca22c76dD6E550706Ad913FC6CE91c75D"
        },
        {
          "address": "0xfeed46c11F57B7126a773EeC6ae9cA7aE1C03C9a"
        }
      ],
      "state": {
        "totalAssets": 15797061624759,
        "totalAssetsUsd": 15790152.179060223,
        "totalSupply": "14071503605551801172939813",
        "apy": 0.05914496950604116,
        "netApy": 0.05307636833061457,
        "netApyExcludingRewards": 0.05307636835054046,
        "fee": 0.1,
        "timelock": 259200,
        "curator": "0x827e86072B06674a077f592A531dcE4590aDeCdB",
        "owner": "0x0A0e559bc3b0950a7e448F0d4894db195b9cf8DD",
        "guardian": "0x94aa34975987119197e53e760AF1ee5aC80A27D3",
        "sharePriceNumber": 1.122627834777107,
        "sharePriceUsd": 1.122136810797548,
        "allRewards": [],
        "curators": [
          {
            "id": "steakhouse-financial",
            "name": "Steakhouse Financial",
            "verified": true
          }
        ],
        "feeRecipient": "0x255c7705e8BB334DfCae438197f7C4297988085a",
        "skimRecipient": "0x0000000000000000000000000000000000000000",
        "pendingOwner": null,
        "avgNetApy": 0.04973958020352476,
        "avgNetApyExcludingRewards": 0.04973958020352476,
        "pendingConfigs": {
          "pageInfo": {
            "countTotal": 0
          }
        },
        "allocation": [
          {
            "supplyAssets": 0,
            "supplyAssetsUsd": 0,
            "supplyCap": 20000000000000,
            "supplyCapUsd": 19991252.23935577,
            "pendingSupplyCap": null,
            "pendingSupplyCapValidAt": null,
            "supplyQueueIndex": 8,
            "withdrawQueueIndex": 13,
            "removableAt": null,
            "market": {
              "marketId": "0x4565ac05d38b19374ccbb04c17cca60ca9353cd41824f0803d0fc7704f60eaed",
              "lltv": "915000000000000000",
              "listed": true,
              "loanAsset": {
                "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                "symbol": "USDC",
                "decimals": 6
              },
              "collateralAsset": {
                "address": "0x5086bf358635B81D8C47C66d1C8b9E567Db70c72",
                "symbol": "reUSD",
                "decimals": 18
              },
              "state": {
                "supplyApy": 0.10767005346125612,
                "netSupplyApy": 0.10767005346125612,
                "borrowApy": 0.1161464403897811,
                "utilization": 0.9306228158558593
              }
            }
          },
          {
            "supplyAssets": 0,
            "supplyAssetsUsd": 0,
            "supplyCap": 10000000000000,
            "supplyCapUsd": 9995626.119677885,
            "pendingSupplyCap": null,
            "pendingSupplyCapValidAt": null,
            "supplyQueueIndex": 12,
            "withdrawQueueIndex": 17,
            "removableAt": null,
            "market": {
              "marketId": "0x2412afc9614939a5d994397fe0b94a4f6fb8bc02bfc139e1a5956a865e2efe26",
              "lltv": "915000000000000000",
              "listed": true,
              "loanAsset": {
                "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                "symbol": "USDC",
                "decimals": 6
              },
              "collateralAsset": {
                "address": "0xc1906aeCf868749a2DeE203F59b904c0cf212140",
                "symbol": "PT-USDG-24SEP2026",
                "decimals": 6
              },
              "state": {
                "supplyApy": 0.0019677931692823804,
                "netSupplyApy": 0.0019677931692823804,
                "borrowApy": 0.012248712349494591,
                "utilization": 0.1614761425654643
              }
            }
          },
          {
            "supplyAssets": 0,
            "supplyAssetsUsd": 0,
            "supplyCap": 50000000000000,
            "supplyCapUsd": 49978130.598389424,
            "pendingSupplyCap": null,
            "pendingSupplyCapValidAt": null,
            "supplyQueueIndex": 14,
            "withdrawQueueIndex": 19,
            "removableAt": null,
            "market": {
              "marketId": "0x85c7f4374f3a403b36d54cc284983b2b02bbd8581ee0f3c36494447b87d9fcab",
              "lltv": "915000000000000000",
              "listed": true,
              "loanAsset": {
                "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                "symbol": "USDC",
                "decimals": 6
              },
              "collateralAsset": {
                "address": "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
                "symbol": "sUSDe",
                "decimals": 18
              },
              "state": {
                "supplyApy": 0.004116287095923952,
                "netSupplyApy": 0.004116287095923952,
                "borrowApy": 0.012729149536129303,
                "utilization": 0.32478115896444115
              }
            }
          }
        ]
      }
    }
  },
  "extensions": {
    "complexity": 820,
    "maximumComplexity": 1000000
  }
} as const;

export const MORPHO_VAULT_V2_DETAIL_GATED = {
  "data": {
    "vaultV2ByAddress": {
      "address": "0x01Fb7F4f156256bc0084421330305bA50a83501B",
      "name": "Basecamp",
      "symbol": "CAMP",
      "listed": false,
      "type": "MorphoVault",
      "creationTimestamp": 1773932123,
      "chain": {
        "id": 8453,
        "network": "Base"
      },
      "asset": {
        "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "symbol": "USDC",
        "decimals": 6,
        "price": {
          "usd": 0.9995626119677885
        }
      },
      "warnings": [
        {
          "type": "not_whitelisted",
          "level": "YELLOW"
        }
      ],
      "totalAssets": 1,
      "totalAssetsUsd": 9.995626119677884e-07,
      "totalSupply": 1000000000000,
      "idleAssets": 0,
      "idleAssetsUsd": 0,
      "liquidity": 1,
      "liquidityUsd": 9.995626119677884e-07,
      "sharePrice": 1,
      "apy": 0.041208091475980625,
      "netApy": 0.041208091475980625,
      "netApyExcludingRewards": 0.041208091475980625,
      "maxApy": 6.389056098807342,
      "performanceFee": 0,
      "managementFee": 0,
      "curator": {
        "address": "0x7aa619B62e8Ad768182F91fca7665Dc05a9e62A8"
      },
      "owner": {
        "address": "0x7aa619B62e8Ad768182F91fca7665Dc05a9e62A8"
      },
      "curators": {
        "items": []
      },
      "rewards": [],
      "gatesConfig": {
        "sendSharesGate": {
          "address": null,
          "abdicated": true
        },
        "receiveSharesGate": {
          "address": null,
          "abdicated": true
        },
        "receiveAssetsGate": {
          "address": null,
          "abdicated": true
        },
        "sendAssetsGate": {
          "address": "0x82245908f2ffB91939BDBf05edb20d936655E2D4",
          "abdicated": false
        }
      },
      "avgNetApy": 0,
      "avgNetApyExcludingRewards": 0,
      "maxRate": 63419583967,
      "forceDeallocatableLiquidity": 0,
      "performanceFeeRecipient": "0x0000000000000000000000000000000000000000",
      "managementFeeRecipient": "0x0000000000000000000000000000000000000000",
      "timelocks": [
        {
          "functionName": "setIsAllocator",
          "duration": 0,
          "abdicatedAt": null
        },
        {
          "functionName": "setReceiveSharesGate",
          "duration": 0,
          "abdicatedAt": 1773932123
        },
        {
          "functionName": "setSendSharesGate",
          "duration": 0,
          "abdicatedAt": 1773932123
        },
        {
          "functionName": "setReceiveAssetsGate",
          "duration": 0,
          "abdicatedAt": 1773932123
        }
      ],
      "sentinels": [
        {
          "sentinel": {
            "address": "0x7aa619B62e8Ad768182F91fca7665Dc05a9e62A8"
          }
        }
      ],
      "allocators": [
        {
          "allocator": {
            "address": "0x1310Ddb809Cbab45C2bafF042Fec54E36ccCa2b9"
          }
        }
      ],
      "pendingConfigs": {
        "pageInfo": {
          "countTotal": 0
        }
      },
      "adapters": {
        "pageInfo": {
          "countTotal": 1
        },
        "items": [
          {
            "address": "0x6A903e20C76F4866892Bc84c0CD05253A1e02281",
            "type": "MorphoMarketV1",
            "assets": 1,
            "assetsUsd": 9.995626119677884e-07,
            "forceDeallocatePenalty": "10000000000000000"
          }
        ]
      },
      "caps": {
        "pageInfo": {
          "countTotal": 10
        },
        "items": [
          {
            "id": "0x13ff47043c4f28ff9eb52ff2a760b64b77707c842acabb83558f6415c9cb4797",
            "type": "Collateral",
            "absoluteCap": "340282366920938463463374607431768211455",
            "relativeCap": "1000000000000000000",
            "allocation": 1,
            "data": {
              "__typename": "CollateralCapData"
            }
          },
          {
            "id": "0x14c7edc816babc1f28c477fab6c128987238064125cc6b85f4dedf1b92b0bb37",
            "type": "MarketV1",
            "absoluteCap": "340282366920938463463374607431768211455",
            "relativeCap": "1000000000000000000",
            "allocation": 1,
            "data": {
              "__typename": "MarketV1CapData",
              "adapterAddress": "0x6A903e20C76F4866892Bc84c0CD05253A1e02281",
              "market": {
                "marketId": "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
                "lltv": "860000000000000000",
                "listed": true,
                "loanAsset": {
                  "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                  "symbol": "USDC",
                  "decimals": 6
                },
                "collateralAsset": {
                  "address": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
                  "symbol": "cbBTC",
                  "decimals": 8
                },
                "state": {
                  "supplyApy": 0.04120801296621134,
                  "netSupplyApy": 0.04120801296621134,
                  "borrowApy": 0.04774309906344836,
                  "utilization": 0.8658438439584916
                }
              }
            }
          },
          {
            "id": "0x207cf9968961dcdfb8e4007f249958d856244d4356441a5379d11c267f651be4",
            "type": "Collateral",
            "absoluteCap": "340282366920938463463374607431768211455",
            "relativeCap": "1000000000000000000",
            "allocation": 0,
            "data": {
              "__typename": "CollateralCapData"
            }
          }
        ]
      }
    }
  },
  "extensions": {
    "complexity": 45560,
    "maximumComplexity": 1000000
  }
} as const;

export const MORPHO_VAULT_NOT_FOUND = {
  "errors": [
    {
      "message": "No results matching given parameters",
      "status": "NOT_FOUND",
      "extensions": {}
    }
  ],
  "data": null,
  "extensions": {
    "complexity": 820,
    "maximumComplexity": 1000000
  }
} as const;

export const MORPHO_VAULTS_V1_UNORDERED = {
  "data": {
    "vaults": {
      "items": [
        {
          "address": "0xFfedad42083E2Eb8Ca401F09c0038A9DeD7eF8e5",
          "name": "Allez USDC",
          "symbol": "AllezUSDC",
          "listed": false,
          "chain": {
            "id": 8453
          },
          "state": {
            "totalAssetsUsd": 1.0613291633310504,
            "netApy": 0.041208153469478925
          }
        },
        {
          "address": "0xFfD3D9fc55ffC0F5234c24ee22C8a2EB7b1fbC50",
          "name": "tstcntrct",
          "symbol": "tstcntrct",
          "listed": false,
          "chain": {
            "id": 8453
          },
          "state": {
            "totalAssetsUsd": 10.358570515025185,
            "netApy": 0.03701205447117169
          }
        },
        {
          "address": "0xfF76Ede3FC0FF1B877b3CCa2BeaCC7400EAD936E",
          "name": "HyperEVM USDe Idle Vault",
          "symbol": "hUSDE-IDLE",
          "listed": false,
          "chain": {
            "id": 999
          },
          "state": {
            "totalAssetsUsd": 0.9995249318683035,
            "netApy": 0
          }
        },
        {
          "address": "0xFEf1b0dc9F6a337548088AaF882DA563a6f7D56C",
          "name": "Test",
          "symbol": "TEST",
          "listed": false,
          "chain": {
            "id": 137
          },
          "state": {
            "totalAssetsUsd": 8.096572296870395,
            "netApy": 1.4802378635509852e-06
          }
        },
        {
          "address": "0xfeaC08ffA38d95ec5Ed7C46c933C8891a44C5F26",
          "name": "Spark Blue Chip USDC Vault",
          "symbol": "sparkUSDCbc",
          "listed": false,
          "chain": {
            "id": 1
          },
          "state": {
            "totalAssetsUsd": 0,
            "netApy": 0
          }
        }
      ]
    }
  },
  "extensions": {
    "complexity": 525,
    "maximumComplexity": 1000000
  }
} as const;
