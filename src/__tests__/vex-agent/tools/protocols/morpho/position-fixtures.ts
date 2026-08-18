/**
 * Morpho POSITION and ACTIVITY GraphQL fixtures - captured VERBATIM from the
 * live keyless endpoint `https://api.morpho.org/graphql` on 2026-08-14. Nothing
 * is synthesized; numeric and structural truth is byte-exact as returned. Bodies
 * were TRIMMED to fewer items but never edited.
 *
 * ONE NAMED SANITISATION, and only one. Every address below is public on-chain
 * data - token contracts, market ids, vault contracts, and the wallet addresses
 * that appear in Morpho's own public API responses and in every block explorer.
 * The two THIRD-PARTY WALLETS that carry a position or a transaction history in
 * these bodies are nonetheless the identity of real people's accounts, so the
 * `MORPHO_POSITIONS_SANITISED_WALLETS` map records exactly which real addresses
 * they are and they are left as captured: rewriting them would break the
 * checksum-cased `id` strings that are themselves part of the shape under test.
 * They are recorded here so a reader knows the choice was made deliberately
 * rather than overlooked, per rules/06.
 *
 * Regenerate (keyless; POST with `Content-Type: application/json`). The exact
 * documents are in `src/tools/morpho/queries-positions.ts` and
 * `src/tools/morpho/queries-activity.ts`:
 *
 *   MORPHO_MARKET_POSITIONS_PAGE   query VexMorphoMarketPositions, variables
 *     {"first":3,"skip":0,"orderBy":"HealthFactor","orderDirection":"Asc",
 *      "where":{"userAddress_in":["0x2A315c59a6a95AEEec085c73Badac801C2F4209F"],"collateral_gte":"1"}}
 *   MORPHO_VAULT_POSITIONS_PAGE    query VexMorphoVaultPositions, variables
 *     {"first":3,"skip":0,"orderDirection":"Desc",
 *      "where":{"userAddress_in":["0x2A315c59a6a95AEEec085c73Badac801C2F4209F"],"shares_gte":"1"}}
 *   MORPHO_VAULT_V2_POSITION       query VexMorphoVaultV2Position, variables
 *     {"userAddress":"0x9B746dBC5269e1DF6e4193Bcb441C0FbBF1CeCEe",
 *      "vaultAddress":"0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9","chainId":8453}
 *   MORPHO_ACTIVITY_MIXED_PAGE     query VexMorphoMarketTransactions, variables
 *     {"first":4,"skip":0,"orderBy":"Timestamp","orderDirection":"Desc","where":{"chainId_in":[1]}}
 *   MORPHO_ACTIVITY_LIQUIDATION_PAGE  same query, variables
 *     {"first":3,"skip":0,"orderBy":"Timestamp","orderDirection":"Desc","where":{"type_in":["Liquidation"]}}
 *   MORPHO_ACTIVITY_WALLET_PAGE    same query, variables
 *     {"first":3,"skip":0,"orderBy":"Timestamp","orderDirection":"Desc",
 *      "where":{"userAddress_in":["0x2A315c59a6a95AEEec085c73Badac801C2F4209F"]}}
 *
 * SHAPE FACTS these bodies pin, each of which shaped a decision in the code:
 *
 *   - A LIVE POSITION CAN SIT FAR BELOW LIQUIDATION. The first row of
 *     `MORPHO_MARKET_POSITIONS_PAGE` reads `healthFactor: 0.3053054108729547` on
 *     an UNLISTED Ethereum market carrying `bad_debt_unrealized` at RED. This is
 *     why the positions tool includes unlisted markets and why the health-factor
 *     bands treat anything at or below 1 as already taken.
 *
 *   - SIGNED BigInt FIELDS EXIST. `margin: -23633633` and
 *     `borrowPnl: -24648763` arrive as NEGATIVE JSON numbers, which the unsigned
 *     money reader refuses by design. They forced `readSignedBigIntString`.
 *
 *   - THE `BigInt` SCALAR STILL ARRIVES IN TWO FORMS, and inside a single row:
 *     one liquidation carries `repaidAssets: 12004` (number) beside
 *     `seizedAssets: "38708708374333048"` (string).
 *
 *   - A LIQUIDATION'S TWO LEGS ARE IN DIFFERENT ASSETS AT DIFFERENT SCALES.
 *     `repaidAssets` is the LOAN asset (USDC, 6 decimals) and `seizedAssets` the
 *     COLLATERAL asset (WLD, 18 decimals) in the same row. Reading either with
 *     the other's scale is a twelve-order-of-magnitude error.
 *
 *   - `data` IS A UNION KEYED BY `__typename`. Three members appear across these
 *     bodies: `MarketTransactionTransferData` (assets + shares),
 *     `MarketTransactionCollateralTransferData` (assets only, NO shares) and
 *     `MarketTransactionLiquidationData`.
 *
 *   - USER ADDRESSES COME BACK CHECKSUM-CASED, while every filter matched them
 *     case-insensitively (the checksummed and lowercased forms of the same
 *     address both returned 22 rows).
 *
 *   - `pageInfo.count` CAN BE LESS THAN `limit` MID-LIST.
 *     `MORPHO_ACTIVITY_WALLET_PAGE` was fetched with `first: 3` and came back
 *     with `count: 2` against `countTotal: 220`, so a short page is NOT proof of
 *     the end of a list and `hasMore` is derived from skip plus returned.
 */

/**
 * Third-party wallets appearing verbatim in these fixtures, and why.
 *
 * Both are ordinary public EVM accounts whose Morpho activity is already served
 * by Morpho's own public API and visible in any block explorer. They are kept as
 * captured because the position `id` strings embed them in checksum case, and a
 * rewritten address would silently change the shape the validators are tested
 * against.
 */
export const MORPHO_POSITIONS_SANITISED_WALLETS = {
  borrower: "0x2A315c59a6a95AEEec085c73Badac801C2F4209F",
  vaultV2Depositor: "0x9B746dBC5269e1DF6e4193Bcb441C0FbBF1CeCEe",
} as const;

export const MORPHO_MARKET_POSITIONS_PAGE = {
  "data": {
    "marketPositions": {
      "pageInfo": {
        "countTotal": 22,
        "count": 3,
        "limit": 3,
        "skip": 0
      },
      "items": [
        {
          "id": "1-0x8e7cc042d739a365c43d0a52d5f24160fa7ae9b7e7c9a479bd02a56041d4cf77-0x2A315c59a6a95AEEec085c73Badac801C2F4209F",
          "healthFactor": 0.3053054108729547,
          "listed": false,
          "priceVariationToLiquidationPrice": 2.2754087035035395,
          "user": {
            "address": "0x2A315c59a6a95AEEec085c73Badac801C2F4209F"
          },
          "market": {
            "marketId": "0x8e7cc042d739a365c43d0a52d5f24160fa7ae9b7e7c9a479bd02a56041d4cf77",
            "lltv": "915000000000000000",
            "listed": false,
            "chain": {
              "id": 1,
              "network": "Ethereum"
            },
            "loanAsset": {
              "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995589300744074
              }
            },
            "collateralAsset": {
              "address": "0x66a1E37c9b0eAddca17d3662D6c05F4DECf3e110",
              "symbol": "USR",
              "decimals": 18,
              "price": {
                "usd": 0.12389773884752878
              }
            },
            "warnings": [
              {
                "type": "bad_debt_unrealized",
                "level": "RED"
              },
              {
                "type": "not_whitelisted",
                "level": "YELLOW"
              },
              {
                "type": "sustained_low_liquidity",
                "level": "RED"
              }
            ]
          },
          "state": {
            "timestamp": 1786707437,
            "collateral": "11834574329029519386",
            "collateralUsd": 1.4662769995897675,
            "supplyAssets": 0,
            "supplyAssetsUsd": 0,
            "supplyShares": 0,
            "borrowAssets": 35468207,
            "borrowAssetsUsd": 35.45256304057761,
            "borrowShares": 2174948184673,
            "margin": -23633633,
            "marginUsd": -33.98628604098784,
            "borrowPnl": -24648763,
            "borrowPnlUsd": -24.63789117193764,
            "borrowRoe": -2.278191492852266
          }
        },
        {
          "id": "8453-0x34f676bd8db106d6cdc90d0fb44145cea2f393310a794812cb1c5a8726b60913-0x2A315c59a6a95AEEec085c73Badac801C2F4209F",
          "healthFactor": 0.9608663786026637,
          "listed": false,
          "priceVariationToLiquidationPrice": 0.040727433354725395,
          "user": {
            "address": "0x2A315c59a6a95AEEec085c73Badac801C2F4209F"
          },
          "market": {
            "marketId": "0x34f676bd8db106d6cdc90d0fb44145cea2f393310a794812cb1c5a8726b60913",
            "lltv": "860000000000000000",
            "listed": false,
            "chain": {
              "id": 8453,
              "network": "Base"
            },
            "loanAsset": {
              "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995589300744074
              }
            },
            "collateralAsset": {
              "address": "0xDEc933e2392AD908263e70A386fbF34e703Ffe8F",
              "symbol": "wbCOIN",
              "decimals": 18,
              "price": {
                "usd": 152.075
              }
            },
            "warnings": [
              {
                "type": "bad_debt_realized",
                "level": "YELLOW"
              },
              {
                "type": "not_whitelisted",
                "level": "YELLOW"
              }
            ]
          },
          "state": {
            "timestamp": 1786707437,
            "collateral": "3166930215860322982",
            "collateralUsd": 481.6109125769586,
            "supplyAssets": 0,
            "supplyAssetsUsd": 0,
            "supplyShares": 0,
            "borrowAssets": 432258748,
            "borrowAssetsUsd": 432.0680916661829,
            "borrowShares": 301185825690113,
            "margin": 50698109,
            "marginUsd": 49.542820910775674,
            "borrowPnl": -607861,
            "borrowPnlUsd": -0.6075928907939594,
            "borrowRoe": -0.001508416049447835
          }
        },
        {
          "id": "42161-0xa35d91efb3e284a0ab7098e8c5a65caf58ea0451073e36a544a821fd8f350953-0x2A315c59a6a95AEEec085c73Badac801C2F4209F",
          "healthFactor": 0.9881971791568921,
          "listed": false,
          "priceVariationToLiquidationPrice": 0.011943791271674886,
          "user": {
            "address": "0x2A315c59a6a95AEEec085c73Badac801C2F4209F"
          },
          "market": {
            "marketId": "0xa35d91efb3e284a0ab7098e8c5a65caf58ea0451073e36a544a821fd8f350953",
            "lltv": "770000000000000000",
            "listed": false,
            "chain": {
              "id": 42161,
              "network": "Arbitrum One"
            },
            "loanAsset": {
              "address": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995589300744074
              }
            },
            "collateralAsset": {
              "address": "0xdF03EEd325b82bC1d4Db8b49c30ecc9E05104b96",
              "symbol": "GLV [WBTC-USDC]",
              "decimals": 18,
              "price": {
                "usd": 1.3370302467568997
              }
            },
            "warnings": [
              {
                "type": "not_whitelisted",
                "level": "YELLOW"
              }
            ]
          },
          "state": {
            "timestamp": 1786707437,
            "collateral": "11378807740076374338",
            "collateralUsd": 15.213810120513635,
            "supplyAssets": 0,
            "supplyAssetsUsd": 0,
            "supplyShares": 0,
            "borrowAssets": 11837706,
            "borrowAssetsUsd": 11.832484743895392,
            "borrowShares": 10971654306935,
            "margin": 3354485,
            "marginUsd": 3.3813253766182427,
            "borrowPnl": -42610,
            "borrowPnlUsd": -0.042591206010470506,
            "borrowRoe": -0.020830027012014037
          }
        }
      ]
    }
  },
  "extensions": {
    "complexity": 1485,
    "maximumComplexity": 1000000
  }
} as const;

export const MORPHO_VAULT_POSITIONS_PAGE = {
  "data": {
    "vaultPositions": {
      "pageInfo": {
        "countTotal": 8,
        "count": 3,
        "limit": 3,
        "skip": 0
      },
      "items": [
        {
          "id": "8453-0x5435BC53f2C61298167cdB11Cdf0Db2BFa259ca0-0x2A315c59a6a95AEEec085c73Badac801C2F4209F",
          "listed": true,
          "user": {
            "address": "0x2A315c59a6a95AEEec085c73Badac801C2F4209F"
          },
          "vault": {
            "address": "0x5435BC53f2C61298167cdB11Cdf0Db2BFa259ca0",
            "name": "UltraYield USDC",
            "symbol": "edgeUSDC",
            "listed": true,
            "chain": {
              "id": 8453,
              "network": "Base"
            },
            "asset": {
              "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995589300744074
              }
            },
            "state": {
              "netApy": 0.059522374481243666,
              "apy": 0.059522374481243666
            }
          },
          "state": {
            "timestamp": 1786707459,
            "assets": 4734919,
            "assetsUsd": 4.732830569628983,
            "shares": "2283654496816304564",
            "pnl": 64736,
            "pnlUsd": 0.06470744689729684,
            "roe": 0.013861558286165292
          }
        },
        {
          "id": "8453-0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2-0x2A315c59a6a95AEEec085c73Badac801C2F4209F",
          "listed": true,
          "user": {
            "address": "0x2A315c59a6a95AEEec085c73Badac801C2F4209F"
          },
          "vault": {
            "address": "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2",
            "name": "Steakhouse Prime USDC",
            "symbol": "steakUSDC",
            "listed": true,
            "chain": {
              "id": 8453,
              "network": "Base"
            },
            "asset": {
              "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995589300744074
              }
            },
            "state": {
              "netApy": 0.03910871808149903,
              "apy": 0.04120892635271402
            }
          },
          "state": {
            "timestamp": 1786707459,
            "assets": 54625,
            "assetsUsd": 0.054600906555314514,
            "shares": "51885936675246242",
            "pnl": 584,
            "pnlUsd": 0.0005837424151634539,
            "roe": 0.010789503589926351
          }
        },
        {
          "id": "1-0x2ed10624315b74a78f11FAbedAa1A228c198aEfB-0x2A315c59a6a95AEEec085c73Badac801C2F4209F",
          "listed": true,
          "user": {
            "address": "0x2A315c59a6a95AEEec085c73Badac801C2F4209F"
          },
          "vault": {
            "address": "0x2ed10624315b74a78f11FAbedAa1A228c198aEfB",
            "name": "Gauntlet EURC Core",
            "symbol": "gteurcc",
            "listed": true,
            "chain": {
              "id": 1,
              "network": "Ethereum"
            },
            "asset": {
              "address": "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c",
              "symbol": "EURC",
              "decimals": 6,
              "price": {
                "usd": 1.15514466528373
              }
            },
            "state": {
              "netApy": 0.021668824337844048,
              "apy": 0.024105271117917337
            }
          },
          "state": {
            "timestamp": 1786707459,
            "assets": 17531,
            "assetsUsd": 0.02025084112708907,
            "shares": "16791968016790634",
            "pnl": 41,
            "pnlUsd": 4.736093127663293e-05,
            "roe": 0.00234435790062398
          }
        }
      ]
    }
  },
  "extensions": {
    "complexity": 1065,
    "maximumComplexity": 1000000
  }
} as const;

export const MORPHO_VAULT_V2_POSITION = {
  "data": {
    "vaultV2PositionByAddress": {
      "id": "8453-0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9-0x9B746dBC5269e1DF6e4193Bcb441C0FbBF1CeCEe",
      "shares": "197379361785910703481043231",
      "assets": 204641793666795,
      "assetsUsd": 204551532.32608923,
      "pnl": 1954820792498,
      "pnlUsd": 1953958.5798365062,
      "roe": 0.01932417858250232,
      "chain": {
        "id": 8453,
        "network": "Base"
      },
      "user": {
        "address": "0x9B746dBC5269e1DF6e4193Bcb441C0FbBF1CeCEe"
      },
      "vault": {
        "address": "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9",
        "name": "Steakhouse Prime USDC",
        "symbol": "steakUSDC",
        "listed": true,
        "asset": {
          "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "symbol": "USDC",
          "decimals": 6,
          "price": {
            "usd": 0.9995589300744074
          }
        },
        "netApy": 0.04121105646105577
      }
    }
  },
  "extensions": {
    "complexity": 740,
    "maximumComplexity": 1000000
  }
} as const;

export const MORPHO_ACTIVITY_MIXED_PAGE = {
  "data": {
    "marketTransactions": {
      "pageInfo": {
        "countTotal": 2838560,
        "count": 3,
        "limit": 4,
        "skip": 0
      },
      "items": [
        {
          "chain": {
            "id": 1,
            "network": "Ethereum"
          },
          "txHash": "0x54cab2dc6edbaac27cda56bdea4d6397d80889726036a1c1d1524a974d255886",
          "timestamp": 1786707383,
          "blockNumber": 25753017,
          "txIndex": 55,
          "logIndex": 273,
          "type": "WithdrawCollateral",
          "user": {
            "address": "0x7c4b5155B00fDe7DB026C187f93510c96DdF0CBE"
          },
          "market": {
            "marketId": "0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49",
            "lltv": "860000000000000000",
            "listed": true,
            "loanAsset": {
              "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995589300744074
              }
            },
            "collateralAsset": {
              "address": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
              "symbol": "WBTC",
              "decimals": 8,
              "price": {
                "usd": 62818.83130509506
              }
            }
          },
          "data": {
            "__typename": "MarketTransactionCollateralTransferData",
            "assets": 125900
          }
        },
        {
          "chain": {
            "id": 1,
            "network": "Ethereum"
          },
          "txHash": "0x4a73e0eac2c1e01b195a650c1ec188bf5a4852fc5a56ef24654f8f968b8c2965",
          "timestamp": 1786707383,
          "blockNumber": 25753017,
          "txIndex": 114,
          "logIndex": 401,
          "type": "Withdraw",
          "user": {
            "address": "0xB26E1c6E89fA002A0751d84C0e99D66657654186"
          },
          "market": {
            "marketId": "0xe3df58f9d3011b7481ff36b939fa5f8da642f34ea5792d25d3958dbf1efa26d7",
            "lltv": "915000000000000000",
            "listed": true,
            "loanAsset": {
              "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995589300744074
              }
            },
            "collateralAsset": {
              "address": "0x056B269Eb1f75477a8666ae8C7fE01b64dD55eCc",
              "symbol": "USD3",
              "decimals": 6,
              "price": {
                "usd": 1.1698228676898625
              }
            }
          },
          "data": {
            "__typename": "MarketTransactionTransferData",
            "assets": 2876108258,
            "shares": 2751899922746341
          }
        },
        {
          "chain": {
            "id": 1,
            "network": "Ethereum"
          },
          "txHash": "0x151f67541fadd0cc8de5fb9f5340a595e2d795a471770e44433e11a241048d6b",
          "timestamp": 1786707359,
          "blockNumber": 25753015,
          "txIndex": 363,
          "logIndex": 654,
          "type": "SupplyCollateral",
          "user": {
            "address": "0xf5EDD68857e6Dfd0d9c89fDCFD4f7912adF2f04b"
          },
          "market": {
            "marketId": "0x9a8dab6de1059e6dc66c34b358764b70effb289e514e237f3161ffb09eaaf24f",
            "lltv": "915000000000000000",
            "listed": true,
            "loanAsset": {
              "address": "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
              "symbol": "USDS",
              "decimals": 18,
              "price": {
                "usd": 0.9998844975924714
              }
            },
            "collateralAsset": {
              "address": "0xdC169AbE56461A2E0c034Da431Ac2a3ebf596094",
              "symbol": "PT-sUSDS-26NOV2026",
              "decimals": 18,
              "price": {
                "usd": 0.986730969154659
              }
            }
          },
          "data": {
            "__typename": "MarketTransactionCollateralTransferData",
            "assets": "5082584471990351782692"
          }
        }
      ]
    }
  },
  "extensions": {
    "complexity": 1660,
    "maximumComplexity": 1000000
  }
} as const;

export const MORPHO_ACTIVITY_LIQUIDATION_PAGE = {
  "data": {
    "marketTransactions": {
      "items": [
        {
          "chain": {
            "id": 480,
            "network": "World Chain"
          },
          "txHash": "0xae44e0f76b7976f5f3b03e8de519dc18183673789c311c5cf132977658b7ea40",
          "timestamp": 1786706069,
          "blockNumber": 33685215,
          "txIndex": 4,
          "logIndex": 35,
          "type": "Liquidation",
          "user": {
            "address": "0xf07eD89Ab33b64901cF9A299871e58f79f42bf45"
          },
          "market": {
            "marketId": "0xba0ae12a5cdbf9a458566be68055f30c859771612950b5e43428a51becc6f6e9",
            "lltv": "770000000000000000",
            "loanAsset": {
              "address": "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995589300744074
              }
            },
            "collateralAsset": {
              "address": "0x2cFc85d8E48F8EAB294be644d9E25C3030863003",
              "symbol": "WLD",
              "decimals": 18,
              "price": {
                "usd": 0.3339863073900787
              }
            }
          },
          "data": {
            "__typename": "MarketTransactionLiquidationData",
            "liquidator": "0x6cf59693571329dB4A613f9A398205E6dE04d05f",
            "repaidAssets": 12004,
            "repaidShares": 11341045182,
            "seizedAssets": "38708708374333048",
            "badDebtAssets": 0,
            "badDebtShares": 0
          }
        },
        {
          "chain": {
            "id": 480,
            "network": "World Chain"
          },
          "txHash": "0x45be2025165f0e1e5ce7bd08e3bc99502e069dabc2304e9f6c440db76cea8eb1",
          "timestamp": 1786705299,
          "blockNumber": 33684830,
          "txIndex": 4,
          "logIndex": 33,
          "type": "Liquidation",
          "user": {
            "address": "0x9c5bAbB1a3e7DD9e645fB9bE271b6a350Cc6c5d0"
          },
          "market": {
            "marketId": "0xba0ae12a5cdbf9a458566be68055f30c859771612950b5e43428a51becc6f6e9",
            "lltv": "770000000000000000",
            "loanAsset": {
              "address": "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995589300744074
              }
            },
            "collateralAsset": {
              "address": "0x2cFc85d8E48F8EAB294be644d9E25C3030863003",
              "symbol": "WLD",
              "decimals": 18,
              "price": {
                "usd": 0.3339863073900787
              }
            }
          },
          "data": {
            "__typename": "MarketTransactionLiquidationData",
            "liquidator": "0xf8E00eD238692b5f5b2A05a5d4B6672272e396A9",
            "repaidAssets": 457681,
            "repaidShares": 432412302742,
            "seizedAssets": "1471854038038645783",
            "badDebtAssets": 0,
            "badDebtShares": 0
          }
        },
        {
          "chain": {
            "id": 4663,
            "network": "Robinhood Chain"
          },
          "txHash": "0x3286778e0c5a947e6260852c29c18a326257a3ddea5f355f8558c50b2954d571",
          "timestamp": 1786704333,
          "blockNumber": 36191159,
          "txIndex": 3,
          "logIndex": 6,
          "type": "Liquidation",
          "user": {
            "address": "0xEB392f4277a92b1792a8419Cedda98c69cB911c9"
          },
          "market": {
            "marketId": "0xaba3ac501ce4c6b80c08ed0dba19e1ac0de495f17af3ed692a38e92d176a6c9e",
            "lltv": "385000000000000000",
            "loanAsset": {
              "address": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
              "symbol": "USDG",
              "decimals": 6,
              "price": {
                "usd": 0.9999018329853188
              }
            },
            "collateralAsset": {
              "address": "0x39dBED3a2bd333467115dE45665cC57F813C4571",
              "symbol": "PONS",
              "decimals": 18,
              "price": {
                "usd": 0.03867159582336628
              }
            }
          },
          "data": {
            "__typename": "MarketTransactionLiquidationData",
            "liquidator": "0x7A7CdD9a168660920c2B96E90956E4539CdE480f",
            "repaidAssets": 1302670,
            "repaidShares": 1302595418331,
            "seizedAssets": "39434579721506770433",
            "badDebtAssets": 0,
            "badDebtShares": 0
          }
        }
      ],
      "pageInfo": {
        "countTotal": 192991,
        "count": 3,
        "limit": 3,
        "skip": 0
      }
    }
  },
  "extensions": {
    "complexity": 1215,
    "maximumComplexity": 1000000
  }
} as const;

export const MORPHO_ACTIVITY_WALLET_PAGE = {
  "data": {
    "marketTransactions": {
      "pageInfo": {
        "countTotal": 220,
        "count": 2,
        "limit": 3,
        "skip": 0
      },
      "items": [
        {
          "chain": {
            "id": 1,
            "network": "Ethereum"
          },
          "txHash": "0xefc84bf49ee6f73415045111857444cbb945f0ef59c215fe512f6385b0588915",
          "timestamp": 1786631507,
          "blockNumber": 25746714,
          "txIndex": 88,
          "logIndex": 259,
          "type": "Borrow",
          "user": {
            "address": "0x2A315c59a6a95AEEec085c73Badac801C2F4209F"
          },
          "market": {
            "marketId": "0xae60b71b407e0517ead445b7113a7ffa07ea4a9379d526ade541a3e9ec777cb4",
            "lltv": "915000000000000000",
            "listed": false,
            "loanAsset": {
              "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995589300744074
              }
            },
            "collateralAsset": {
              "address": "0x08EFCC2F3e61185D0EA7F8830B3FEc9Bfa2EE313",
              "symbol": "sNUSD",
              "decimals": 18,
              "price": {
                "usd": 1.062019281117235
              }
            }
          },
          "data": {
            "__typename": "MarketTransactionTransferData",
            "assets": 626335441,
            "shares": 605500417579286
          }
        },
        {
          "chain": {
            "id": 1,
            "network": "Ethereum"
          },
          "txHash": "0xefc84bf49ee6f73415045111857444cbb945f0ef59c215fe512f6385b0588915",
          "timestamp": 1786631507,
          "blockNumber": 25746714,
          "txIndex": 88,
          "logIndex": 257,
          "type": "SupplyCollateral",
          "user": {
            "address": "0x2A315c59a6a95AEEec085c73Badac801C2F4209F"
          },
          "market": {
            "marketId": "0xae60b71b407e0517ead445b7113a7ffa07ea4a9379d526ade541a3e9ec777cb4",
            "lltv": "915000000000000000",
            "listed": false,
            "loanAsset": {
              "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
              "symbol": "USDC",
              "decimals": 6,
              "price": {
                "usd": 0.9995589300744074
              }
            },
            "collateralAsset": {
              "address": "0x08EFCC2F3e61185D0EA7F8830B3FEc9Bfa2EE313",
              "symbol": "sNUSD",
              "decimals": 18,
              "price": {
                "usd": 1.062019281117235
              }
            }
          },
          "data": {
            "__typename": "MarketTransactionCollateralTransferData",
            "assets": "643480983561289349276"
          }
        }
      ]
    }
  },
  "extensions": {
    "complexity": 1245,
    "maximumComplexity": 1000000
  }
} as const;

/**
 * A nonexistent MARKET id, captured live on 2026-08-14 with
 *   {"marketId":"0x00...01","chainId":1}
 *
 * Byte-for-byte the same envelope Morpho uses for a removed FIELD: HTTP 200,
 * `data: null`, and `errors[{status: "NOT_FOUND"}]`. That collision is why the
 * client needs an explicit `notFound` hook per read - without one, an agent that
 * mistyped an id was told "Morpho rejected the GraphQL query" and went looking
 * for a schema fault it could not fix.
 */
export const MORPHO_MARKET_NOT_FOUND = {
  "errors": [
    {
      "message": "No results matching given parameters",
      "status": "NOT_FOUND",
      "extensions": {
        "description": "cannot find market config for chainId=1 marketId=0x0000000000000000000000000000000000000000000000000000000000000001"
      }
    }
  ],
  "data": null,
  "extensions": {
    "complexity": 20,
    "maximumComplexity": 1000000
  }
} as const;
