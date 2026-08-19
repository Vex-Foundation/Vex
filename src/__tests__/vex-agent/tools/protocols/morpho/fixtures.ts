/**
 * Morpho GraphQL fixtures - captured VERBATIM from the live keyless endpoint
 * `https://api.morpho.org/graphql` on 2026-08-14. Nothing is synthesized;
 * numeric and structural truth is byte-exact as returned.
 *
 * NO SANITISATION WAS NEEDED. Every body here is public market/catalogue data.
 * The only addresses present are token contracts, oracles, IRMs, market ids and
 * PUBLIC vault contracts - no third-party wallet appears in any of them, so
 * rules/06 required nothing to be replaced.
 *
 * Regenerate (every call is free and keyless; POST with
 * `Content-Type: application/json`):
 *
 *   MORPHO_MARKETS_PAGE
 *     query VexMorphoMarkets, variables
 *     {"first":3,"skip":0,"orderBy":"SupplyAssetsUsd","orderDirection":"Desc",
 *      "where":{"listed":true,"chainId_in":[1,8453]}}
 *
 *   MORPHO_MARKET_DETAIL
 *     query VexMorphoMarket, variables
 *     {"marketId":"0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
 *      "chainId":8453}
 *
 *   MORPHO_MARKETS_WITH_REWARDS
 *     query VexMorphoMarkets, variables
 *     {"first":2,"where":{"chainId_in":[143],"listed":true,"supplyAssetsUsd_gte":1000}}
 *
 *   MORPHO_MARKETS_UNLISTED
 *     query VexMorphoMarkets ranked by NetSupplyApy Desc, variables
 *     {"first":2,"where":{"listed":false}}
 *
 *   MORPHO_CHAINS
 *     {chains{id network currency blockTimeMs}}
 *
 * The exact documents are in `src/tools/morpho/queries.ts`.
 *
 * SHAPE FACTS these bodies pin, each of which contradicted an assumption made
 * before the probe:
 *
 *   - `extensions.warnings[]` DOES NOT EXIST. The plan expected deprecation
 *     notices there; `extensions` carries only `complexity` and
 *     `maximumComplexity`. The previous field generation is already REMOVED,
 *     not deprecated: `whitelisted`, `uniqueKey` and `priceUsd` are hard
 *     `GRAPHQL_VALIDATION_FAILED` errors. There is no warning window left.
 *
 *   - The `BigInt` scalar arrives as BOTH a JSON number and a JSON string in
 *     ONE response, split on whether the value fits in a double.
 *     `MORPHO_MARKETS_PAGE` row 1 has `supplyAssets: 1483209486620379` (number)
 *     while row 2 has `collateralAssets: "355405952890211270375830324"`
 *     (string). A validator that accepts only one form drops half the rows.
 *
 *   - APYs are FRACTIONS (0.0412 = 4.12%), and `supplyApy` / `netSupplyApy` are
 *     EQUAL on every market here because none of them pays incentives. That
 *     equality is why `MORPHO_MARKETS_WITH_REWARDS` exists: it is the only
 *     capture with a non-empty `state.rewards`, a WMON stream on Monad, which
 *     is where the base-versus-net distinction becomes observable.
 *
 *   - `publicAllocatorSharedLiquidity` returns ONE ROW PER withdraw-market
 *     pair, so a single vault appears many times - the Steakhouse High Yield
 *     USDC v1.1 vault appears EIGHT times in `MORPHO_MARKET_DETAIL`. Reporting
 *     the rows verbatim double-counts; the validator sums per vault.
 *
 *   - The oracle price scale is `36 + loanDecimals - collateralDecimals`,
 *     verified numerically against this capture rather than taken from docs:
 *     `state.price` 6.2746442e38 at scale 34 (36 + 6 - 8) is 62,746.44, which
 *     matches the same response's cbBTC mark of 62,686 USD.
 *
 *   - `marketById` takes `chainId: Int!`. A nullable `$chainId: Int` variable
 *     is refused at validation time, before any data is read.
 *
 *   - MarketState exposes NO field with arguments. Averaged APYs are FIXED
 *     field names (`weeklyNetSupplyApy` and siblings), so a lookback selects a
 *     field name locally and never becomes a server argument.
 *
 *   - `MORPHO_MARKETS_UNLISTED` is the evidence behind `listedOnly: true`.
 *     Ranking UNLISTED markets by net supply APY returns 2979.957... (that is
 *     297,995%) on a market holding 0.0379 USD, flagged `oracle_unusable` and
 *     `sustained_low_liquidity` at RED. The second row reports 2.75 BILLION USD
 *     supplied while carrying the same unusable-oracle flag, which is also why
 *     a USD figure from a warned market must never be quoted as fact.
 *
 *   - `countTotal` counts rows MATCHING THE FILTER, not rows returned: 395 for
 *     listed markets on chains 1 and 8453, against 6,169 unlisted overall.
 */

export const MORPHO_MARKETS_PAGE: unknown = {
    "data": {
      "markets": {
        "pageInfo": {
          "countTotal": 395,
          "count": 3,
          "limit": 3,
          "skip": 0
        },
        "items": [
          {
            "marketId": "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
            "lltv": "860000000000000000",
            "listed": true,
            "irmAddress": "0x46415998764C29aB2a25CbeA6254146D50D22687",
            "creationTimestamp": 1725443309,
            "reallocatableLiquidityAssets": 7960935049394,
            "chain": {
              "id": 8453,
              "network": "Base"
            },
            "loanAsset": {
              "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995409393593403
              }
            },
            "collateralAsset": {
              "address": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
              "symbol": "cbBTC",
              "decimals": 8,
              "price": {
                "usd": 62686.32975179037
              }
            },
            "oracle": {
              "address": "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9",
              "type": "ChainlinkOracleV2"
            },
            "warnings": [],
            "state": {
              "timestamp": 1786701181,
              "blockNumber": 49955917,
              "supplyAssets": 1483209486620379,
              "supplyAssetsUsd": 1482528603.5232184,
              "borrowAssets": 1284058156614307,
              "borrowAssetsUsd": 1283468696.0542872,
              "collateralAssets": 3616405721027,
              "collateralAssetsUsd": 2266992015.4455976,
              "liquidityAssets": 199151330006072,
              "liquidityAssetsUsd": 199059907.4689312,
              "utilization": 0.8657294658626709,
              "fee": 0,
              "supplyApy": 0.04120798108290647,
              "netSupplyApy": 0.04120798108290647,
              "borrowApy": 0.047749517947699376,
              "netBorrowApy": 0.047749517947699376,
              "apyAtTarget": 0.04918725432384528,
              "rewards": []
            }
          },
          {
            "marketId": "0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354",
            "lltv": "915000000000000000",
            "listed": true,
            "irmAddress": "0x46415998764C29aB2a25CbeA6254146D50D22687",
            "creationTimestamp": 1779877679,
            "reallocatableLiquidityAssets": 0,
            "chain": {
              "id": 8453,
              "network": "Base"
            },
            "loanAsset": {
              "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995409393593403
              }
            },
            "collateralAsset": {
              "address": "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
              "symbol": "USDe",
              "decimals": 18,
              "price": {
                "usd": 0.9994646533032397
              }
            },
            "oracle": {
              "address": "0xF4b17C79492d68775e22e8Dd0a2Bb22854A39A47",
              "type": "Unknown"
            },
            "warnings": [],
            "state": {
              "timestamp": 1786701171,
              "blockNumber": 49955912,
              "supplyAssets": 353442325908735,
              "supplyAssetsUsd": 353280074.4481671,
              "borrowAssets": 318245449038596,
              "borrowAssetsUsd": 318099355.0788733,
              "collateralAssets": "355405952890211270375830324",
              "collateralAssetsUsd": 355215687.4873225,
              "liquidityAssets": 35196876870139,
              "liquidityAssetsUsd": 35180719.36929378,
              "utilization": 0.9004169158867875,
              "fee": 0,
              "supplyApy": 0.03386170444364708,
              "netSupplyApy": 0.03386170444364708,
              "borrowApy": 0.03767641766249423,
              "netBorrowApy": 0.03767641766249423,
              "apyAtTarget": 0.0372024506883137,
              "rewards": []
            }
          },
          {
            "marketId": "0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64",
            "lltv": "860000000000000000",
            "listed": true,
            "irmAddress": "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
            "creationTimestamp": 1725479483,
            "reallocatableLiquidityAssets": 984028987179,
            "chain": {
              "id": 1,
              "network": "Ethereum"
            },
            "loanAsset": {
              "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995409393593403
              }
            },
            "collateralAsset": {
              "address": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
              "symbol": "cbBTC",
              "decimals": 8,
              "price": {
                "usd": 62686.32975179037
              }
            },
            "oracle": {
              "address": "0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a",
              "type": "ChainlinkOracleV2"
            },
            "warnings": [],
            "state": {
              "timestamp": 1786701167,
              "blockNumber": 25752499,
              "supplyAssets": 305776363861164,
              "supplyAssetsUsd": 305635993.9676713,
              "borrowAssets": 276647851105011,
              "borrowAssetsUsd": 276520852.9652456,
              "collateralAssets": 835615184359,
              "collateralAssetsUsd": 523816489.92331374,
              "liquidityAssets": 29128512756153,
              "liquidityAssetsUsd": 29115141.002425693,
              "utilization": 0.9047391616921097,
              "fee": 0,
              "supplyApy": 0.04193678779431732,
              "netSupplyApy": 0.04193678779431732,
              "borrowApy": 0.04645343246797202,
              "netBorrowApy": 0.04645343246797202,
              "apyAtTarget": 0.0405554445328034,
              "rewards": []
            }
          }
        ]
      }
    },
    "extensions": {
      "complexity": 1755,
      "maximumComplexity": 1000000
    }
  };

export const MORPHO_MARKET_DETAIL: unknown = {
    "data": {
      "marketById": {
        "marketId": "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
        "lltv": "860000000000000000",
        "listed": true,
        "irmAddress": "0x46415998764C29aB2a25CbeA6254146D50D22687",
        "creationTimestamp": 1725443309,
        "reallocatableLiquidityAssets": 7960944973478,
        "chain": {
          "id": 8453,
          "network": "Base"
        },
        "loanAsset": {
          "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "symbol": "USDC",
          "decimals": 6,
          "price": {
            "usd": 0.9995409393593403
          }
        },
        "collateralAsset": {
          "address": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
          "symbol": "cbBTC",
          "decimals": 8,
          "price": {
            "usd": 62686.32975179037
          }
        },
        "oracle": {
          "address": "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9",
          "type": "ChainlinkOracleV2"
        },
        "warnings": [],
        "badDebt": {
          "underlying": 0,
          "usd": 0
        },
        "realizedBadDebt": {
          "underlying": 0,
          "usd": 0
        },
        "publicAllocatorSharedLiquidity": [
          {
            "assets": 2016300380,
            "vault": {
              "address": "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
              "name": "Steakhouse High Yield USDC v1.1"
            }
          },
          {
            "assets": 2364770479,
            "vault": {
              "address": "0xef417a2512C5a41f69AE4e021648b69a7CdE5D03",
              "name": "Yearn OG USDC"
            }
          },
          {
            "assets": 437173426657,
            "vault": {
              "address": "0xef417a2512C5a41f69AE4e021648b69a7CdE5D03",
              "name": "Yearn OG USDC"
            }
          },
          {
            "assets": 15771731777,
            "vault": {
              "address": "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
              "name": "Steakhouse High Yield USDC v1.1"
            }
          },
          {
            "assets": 92333248227,
            "vault": {
              "address": "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
              "name": "Steakhouse High Yield USDC v1.1"
            }
          },
          {
            "assets": 24557136208,
            "vault": {
              "address": "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
              "name": "Steakhouse High Yield USDC v1.1"
            }
          },
          {
            "assets": 2588,
            "vault": {
              "address": "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
              "name": "Steakhouse High Yield USDC v1.1"
            }
          },
          {
            "assets": 2,
            "vault": {
              "address": "0x874aab24BC783a386275D796699CD8A7772A78B9",
              "name": "SCL"
            }
          },
          {
            "assets": 1111946584138,
            "vault": {
              "address": "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
              "name": "Steakhouse High Yield USDC v1.1"
            }
          },
          {
            "assets": 228706843286,
            "vault": {
              "address": "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
              "name": "Steakhouse High Yield USDC v1.1"
            }
          },
          {
            "assets": 14810128,
            "vault": {
              "address": "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
              "name": "Steakhouse High Yield USDC v1.1"
            }
          },
          {
            "assets": 269467186998,
            "vault": {
              "address": "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
              "name": "Steakhouse High Yield USDC v1.1"
            }
          },
          {
            "assets": 551856732098,
            "vault": {
              "address": "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183",
              "name": "Steakhouse USDC"
            }
          },
          {
            "assets": 83856919458,
            "vault": {
              "address": "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2",
              "name": "Steakhouse Prime USDC"
            }
          },
          {
            "assets": 40574344732,
            "vault": {
              "address": "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2",
              "name": "Steakhouse Prime USDC"
            }
          },
          {
            "assets": 2467563528587,
            "vault": {
              "address": "0xBeEf2d50B428675a1921bC6bBF4bfb9D8cF1461A",
              "name": "Grove x Steakhouse USDC High Yield"
            }
          },
          {
            "assets": 502236034497,
            "vault": {
              "address": "0xbeEFe1372c0A384aCEcBe8a0Adf3c94c389F6704",
              "name": "Safe x Steakhouse USDC"
            }
          },
          {
            "assets": 302597267809,
            "vault": {
              "address": "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2",
              "name": "Steakhouse Prime USDC"
            }
          },
          {
            "assets": 247669301688,
            "vault": {
              "address": "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183",
              "name": "Steakhouse USDC"
            }
          },
          {
            "assets": 61446171199,
            "vault": {
              "address": "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
              "name": "Steakhouse High Yield USDC v1.1"
            }
          },
          {
            "assets": 699657249923,
            "vault": {
              "address": "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183",
              "name": "Steakhouse USDC"
            }
          },
          {
            "assets": 819135382619,
            "vault": {
              "address": "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2",
              "name": "Steakhouse Prime USDC"
            }
          }
        ],
        // Captured live on 2026-08-18 from the same Base cbBTC/USDC market as the
        // V1 list below. Note the FLAT `netApy`, where V1 nests it under `state`,
        // and note "Gauntlet USDC Prime": a V1 vault in the list below carries
        // the SAME NAME at a different address, which is why a supplier row must
        // report its version.
        "supplyingVaultV2s": [
          {
            "address": "0x050cE30b927Da55177A4914EC73480238BAD56f0",
            "name": "Gauntlet USDC Prime",
            "netApy": 0.041219206521614114
          },
          {
            "address": "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9",
            "name": "Steakhouse Prime USDC",
            "netApy": 0.0412193957569257
          }
        ],
        "supplyingVaults": [
          {
            "address": "0x1401d1271C47648AC70cBcdfA3776D4A87CE006B",
            "name": "Pangolins USDC",
            "state": {
              "netApy": 0.037011967709553485
            }
          },
          {
            "address": "0x1D3b1Cd0a0f242d598834b3F2d126dC6bd774657",
            "name": "Clearstar USDC Reactor",
            "state": {
              "netApy": 0.03228177288386917
            }
          },
          {
            "address": "0x236919F11ff9eA9550A4287696C2FC9e18E6e890",
            "name": "Gauntlet USDC Frontier",
            "state": {
              "netApy": 0.05936322194242172
            }
          },
          {
            "address": "0x5435BC53f2C61298167cdB11Cdf0Db2BFa259ca0",
            "name": "UltraYield USDC",
            "state": {
              "netApy": 0.059550499360448976
            }
          },
          {
            "address": "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A",
            "name": "Spark USDC Vault",
            "state": {
              "netApy": 0.03701211196342024
            }
          },
          {
            "address": "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
            "name": "Steakhouse High Yield USDC v1.1",
            "state": {
              "netApy": 0.056754650533083796
            }
          },
          {
            "address": "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2",
            "name": "Steakhouse Prime USDC",
            "state": {
              "netApy": 0.039110619228834444
            }
          },
          {
            "address": "0xE74c499fA461AF1844fCa84204490877787cED56",
            "name": "Yield Clearstar USDC",
            "state": {
              "netApy": 0.04495510560004138
            }
          },
          {
            "address": "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183",
            "name": "Steakhouse USDC",
            "state": {
              "netApy": 0.030749951359180416
            }
          },
          {
            "address": "0xc0c5689e6f4D256E861F65465b691aeEcC0dEb12",
            "name": "Gauntlet USDC Core",
            "state": {
              "netApy": 0.037374858974145095
            }
          },
          {
            "address": "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca",
            "name": "Moonwell Flagship USDC",
            "state": {
              "netApy": 0.04051740348105079
            }
          },
          {
            "address": "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
            "name": "Gauntlet USDC Prime",
            "state": {
              "netApy": 0.04122684674621222
            }
          },
          {
            "address": "0xef417a2512C5a41f69AE4e021648b69a7CdE5D03",
            "name": "Yearn OG USDC",
            "state": {
              "netApy": 0.04877837590969597
            }
          }
        ],
        "state": {
          "timestamp": 1786701029,
          "blockNumber": 49955841,
          "supplyAssets": 1483216645477024,
          "supplyAssetsUsd": 1482554382.6975195,
          "borrowAssets": 1284057425049621,
          "borrowAssetsUsd": 1283484087.7411773,
          "collateralAssets": 3616405721027,
          "collateralAssetsUsd": 2266809199.9743466,
          "liquidityAssets": 199159220427403,
          "liquidityAssetsUsd": 199067794.26808032,
          "totalLiquidity": 207120165400881,
          "totalLiquidityUsd": 207025084.68505853,
          "utilization": 0.8657247941258436,
          "fee": 0,
          "supplyApy": 0.041207971757614606,
          "netSupplyApy": 0.041207971757614606,
          "borrowApy": 0.047749770816845685,
          "netBorrowApy": 0.047749770816845685,
          "apyAtTarget": 0.04918771688257339,
          "rateAtTarget": 1522585674,
          "price": "627464420000000000000000000000000000000",
          "rewards": [],
          "dailySupplyApy": 0.041222223541860004,
          "dailyNetSupplyApy": 0.041222223541860004,
          "dailyBorrowApy": 0.04783445408541964,
          "dailyNetBorrowApy": 0.04783445408541964,
          "weeklySupplyApy": 0.04468269773592359,
          "weeklyNetSupplyApy": 0.04468269773592359,
          "weeklyBorrowApy": 0.050299859333409636,
          "weeklyNetBorrowApy": 0.050299859333409636,
          "monthlySupplyApy": 0.044847218661766775,
          "monthlyNetSupplyApy": 0.044847218661766775,
          "monthlyBorrowApy": 0.05015372883272806,
          "monthlyNetBorrowApy": 0.05015372883272806,
          "quarterlySupplyApy": 0.044388278796404945,
          "quarterlyNetSupplyApy": 0.044388278796404945,
          "quarterlyBorrowApy": 0.04973657353720973,
          "quarterlyNetBorrowApy": 0.04973657353720973,
          "yearlySupplyApy": 0.05080866164080389,
          "yearlyNetSupplyApy": 0.05080866164080389,
          "yearlyBorrowApy": 0.05734004086377609,
          "yearlyNetBorrowApy": 0.05734004086377609,
          "allTimeSupplyApy": 0.05099344639758008,
          "allTimeNetSupplyApy": 0.05099344639758008,
          "allTimeBorrowApy": 0.05760352818863401,
          "allTimeNetBorrowApy": 0.05760352818863401
        }
      }
    },
    "extensions": {
      "complexity": 3030,
      "maximumComplexity": 1000000
    }
  };

export const MORPHO_MARKETS_WITH_REWARDS: unknown = {
    "data": {
      "markets": {
        "pageInfo": {
          "countTotal": 34,
          "count": 2,
          "limit": 2,
          "skip": 0
        },
        "items": [
          {
            "marketId": "0x9e8441e7af65860feac831ebc117473e3033321abf528ebc8fbde1eeaaa3a626",
            "lltv": "770000000000000000",
            "listed": true,
            "irmAddress": "0x09475a3D6eA8c314c592b1a3799bDE044E2F400F",
            "creationTimestamp": 1769154623,
            "reallocatableLiquidityAssets": 0,
            "chain": {
              "id": 143,
              "network": "Monad"
            },
            "loanAsset": {
              "address": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995409393593403
              }
            },
            "collateralAsset": {
              "address": "0x7Cd231120a60F500887444a9bAF5e1BD753A5e59",
              "symbol": "aHYPER",
              "decimals": 6,
              "price": {
                "usd": 1.0611727451658397
              }
            },
            "oracle": {
              "address": "0x4af4f38164cD7F28653A66aa2255B249a23cFBec",
              "type": "ChainlinkOracleV2"
            },
            "warnings": [],
            "state": {
              "timestamp": 1786698755,
              "blockNumber": 95878385,
              "supplyAssets": 41694693446558,
              "supplyAssetsUsd": 41675553.05387231,
              "borrowAssets": 37733700933019,
              "borrowAssetsUsd": 37716378.87609422,
              "collateralAssets": 51860388721052,
              "collateralAssetsUsd": 55032831.0644863,
              "liquidityAssets": 3960992513539,
              "liquidityAssetsUsd": 3959174.1777780866,
              "utilization": 0.9050000806789481,
              "fee": 0,
              "supplyApy": 0.10551048136862343,
              "netSupplyApy": 0.11604062855044879,
              "borrowApy": 0.11721243745279238,
              "netBorrowApy": 0.11721243745279238,
              "apyAtTarget": 0.1011782561487242,
              "rewards": [
                {
                  "supplyApr": 0.010530147181825367,
                  "borrowApr": 0,
                  "asset": {
                    "address": "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
                    "symbol": "WMON",
                    "decimals": 18
                  }
                }
              ]
            }
          },
          {
            "marketId": "0x8bdb7d2c5024d349772884afb3c5c409bc8de58ed63d79618bf48fb57b595060",
            "lltv": "945000000000000000",
            "listed": true,
            "irmAddress": "0x09475a3D6eA8c314c592b1a3799bDE044E2F400F",
            "creationTimestamp": 1768421763,
            "reallocatableLiquidityAssets": 0,
            "chain": {
              "id": 143,
              "network": "Monad"
            },
            "loanAsset": {
              "address": "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242",
              "symbol": "WETH",
              "decimals": 18,
              "price": {
                "usd": 1868.4754848565972
              }
            },
            "collateralAsset": {
              "address": "0x10Aeaf63194db8d453d4D85a06E5eFE1dd0b5417",
              "symbol": "wstETH",
              "decimals": 18,
              "price": {
                "usd": 2327.1579494426214
              }
            },
            "oracle": {
              "address": "0xBB16f6B3c5422209ee1d9b0f63761F159C136694",
              "type": "ChainlinkOracleV2"
            },
            "warnings": [],
            "state": {
              "timestamp": 1786700740,
              "blockNumber": 95884956,
              "supplyAssets": "20113851609887521293243",
              "supplyAssetsUsd": 37582238.63911823,
              "borrowAssets": "18087388376309421959179",
              "borrowAssetsUsd": 33795841.76621433,
              "collateralAssets": "16232899646486387765083",
              "collateralAssetsUsd": 37776521.45482512,
              "liquidityAssets": "2026463233578099334064",
              "liquidityAssetsUsd": 3786396.8729039067,
              "utilization": 0.8992503637353109,
              "fee": 0,
              "supplyApy": 0.0144036193047396,
              "netSupplyApy": 0.02934921732657681,
              "borrowApy": 0.016030232212504974,
              "netBorrowApy": 0.016030232212504974,
              "apyAtTarget": 0.016040330054550255,
              "rewards": [
                {
                  "supplyApr": 0.014945598021837214,
                  "borrowApr": 0,
                  "asset": {
                    "address": "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
                    "symbol": "WMON",
                    "decimals": 18
                  }
                }
              ]
            }
          }
        ]
      }
    },
    "extensions": {
      "complexity": 1170,
      "maximumComplexity": 1000000
    }
  };

export const MORPHO_MARKETS_UNLISTED: unknown = {
    "data": {
      "markets": {
        "pageInfo": {
          "countTotal": 6169,
          "count": 2,
          "limit": 2,
          "skip": 0
        },
        "items": [
          {
            "marketId": "0x07cd0d69b60deb9f1e6f07025707658969ce1c6ce4f228b0594cc9ecf1a5222a",
            "lltv": "860000000000000000",
            "listed": false,
            "irmAddress": "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
            "creationTimestamp": 1741035431,
            "reallocatableLiquidityAssets": 0,
            "chain": {
              "id": 1,
              "network": "Ethereum"
            },
            "loanAsset": {
              "address": "0x73A15FeD60Bf67631dC6cd7Bc5B6e8da8190aCF5",
              "symbol": "USD0",
              "decimals": 18,
              "price": {
                "usd": 0.9987833653766248
              }
            },
            "collateralAsset": {
              "address": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
              "symbol": "WBTC",
              "decimals": 8,
              "price": {
                "usd": 62721.75694435756
              }
            },
            "oracle": {
              "address": "0x0D9cd1Dc03FFEfC459C5641678cf406f40d32cAc",
              "type": "ChainlinkOracleV2"
            },
            "warnings": [
              {
                "type": "not_whitelisted",
                "level": "YELLOW"
              },
              {
                "type": "sustained_low_liquidity",
                "level": "RED"
              }
            ],
            "state": {
              "timestamp": 1786701899,
              "blockNumber": 25752560,
              "supplyAssets": "38048867806321451",
              "supplyAssetsUsd": 0.03800257623636805,
              "borrowAssets": "38048867806321451",
              "borrowAssetsUsd": 0.03800257623636805,
              "collateralAssets": 10,
              "collateralAssetsUsd": 0.006272175694435756,
              "liquidityAssets": 0,
              "liquidityAssetsUsd": 0,
              "utilization": 1,
              "fee": 0,
              "supplyApy": 2979.9579868427436,
              "netSupplyApy": 2979.9579868427436,
              "borrowApy": 2979.9579868427436,
              "netBorrowApy": 2979.9579868427436,
              "apyAtTarget": 6.389056098807342,
              "rewards": []
            }
          },
          {
            "marketId": "0x0f9563442d64ab3bd3bcb27058db0b0d4046a4c46f0acd811dacae9551d2b129",
            "lltv": "915000000000000000",
            "listed": false,
            "irmAddress": "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
            "creationTimestamp": 1738726607,
            "reallocatableLiquidityAssets": 0,
            "chain": {
              "id": 1,
              "network": "Ethereum"
            },
            "loanAsset": {
              "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995782519202298
              }
            },
            "collateralAsset": {
              "address": "0x5C5b196aBE0d54485975D1Ec29617D42D9198326",
              "symbol": "sdeUSD",
              "decimals": 18,
              "price": {
                "usd": 1.0705667285e-08
              }
            },
            "oracle": {
              "address": "0x65F9f6d537C2D628D1c2663896436817440eDB72",
              "type": "ChainlinkOracleV2"
            },
            "warnings": [
              {
                "type": "custom",
                "level": "RED"
              },
              {
                "type": "not_whitelisted",
                "level": "YELLOW"
              },
              {
                "type": "oracle_unusable",
                "level": "RED"
              },
              {
                "type": "sustained_low_liquidity",
                "level": "RED"
              }
            ],
            "state": {
              "timestamp": 1786701899,
              "blockNumber": 25752560,
              "supplyAssets": 2758717383446517,
              "supplyAssetsUsd": 2757553899.6874194,
              "borrowAssets": 2758717383446517,
              "borrowAssetsUsd": 2757553899.6874194,
              "collateralAssets": "8944788405981167225560721",
              "collateralAssetsUsd": 0.09575992860915988,
              "liquidityAssets": 0,
              "liquidityAssetsUsd": 0,
              "utilization": 1,
              "fee": 0,
              "supplyApy": 2979.9579868427436,
              "netSupplyApy": 2979.9579868427436,
              "borrowApy": 2979.9579868427436,
              "netBorrowApy": 2979.9579868427436,
              "apyAtTarget": 6.389056098807342,
              "rewards": []
            }
          }
        ]
      }
    },
    "extensions": {
      "complexity": 1170,
      "maximumComplexity": 1000000
    }
  };

export const MORPHO_CHAINS: unknown = {
    "data": {
      "chains": [
        {
          "id": 1,
          "network": "Ethereum",
          "currency": "ETH",
          "blockTimeMs": 12000
        },
        {
          "id": 8453,
          "network": "Base",
          "currency": "ETH",
          "blockTimeMs": 2000
        },
        {
          "id": 747474,
          "network": "Katana",
          "currency": "ETH",
          "blockTimeMs": 1000
        },
        {
          "id": 999,
          "network": "HyperEVM",
          "currency": "HYPE",
          "blockTimeMs": 1000
        },
        {
          "id": 42161,
          "network": "Arbitrum One",
          "currency": "ETH",
          "blockTimeMs": 250
        },
        {
          "id": 137,
          "network": "Polygon",
          "currency": "POL",
          "blockTimeMs": 2000
        },
        {
          "id": 130,
          "network": "Unichain",
          "currency": "ETH",
          "blockTimeMs": 1000
        },
        {
          "id": 10,
          "network": "OP Mainnet",
          "currency": "ETH",
          "blockTimeMs": 2000
        },
        {
          "id": 480,
          "network": "World Chain",
          "currency": "ETH",
          "blockTimeMs": 2000
        },
        {
          "id": 143,
          "network": "Monad",
          "currency": "MON",
          "blockTimeMs": 400
        },
        {
          "id": 988,
          "network": "Stable",
          "currency": "gUSDT",
          "blockTimeMs": 700
        },
        {
          "id": 4217,
          "network": "Tempo Mainnet",
          "currency": "USD",
          "blockTimeMs": 500
        },
        {
          "id": 4663,
          "network": "Robinhood Chain",
          "currency": "ETH",
          "blockTimeMs": 250
        },
        {
          "id": 5042,
          "network": "Arc",
          "currency": "USDC",
          "blockTimeMs": 500
        }
      ]
    },
    "extensions": {
      "complexity": 50,
      "maximumComplexity": 1000000
    }
  };
