/**
 * Pendle DASHBOARD-POSITIONS fixtures — captured VERBATIM from the live keyless
 * Pendle core API on 2026-07-27. Numeric and structural truth is byte-exact.
 *
 * NO SANITISATION WAS NEEDED INSIDE THESE BODIES, and that is a verified fact
 * rather than an assumption: `GET /v1/dashboard/positions/database/{user}`
 * takes the wallet in the PATH and never echoes it into the response. Every
 * 0x value below is a public market, SY or reward-token contract. The probed
 * holders are referred to here only by the synthetic labels
 * `0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e` (wallet A) and
 * `0xfb0dfb0dfb0dfb0dfb0dfb0dfb0dfb0dfb0dfb0d` (wallet B); their real addresses are
 * deliberately not recorded (rules/06 data minimisation).
 *
 * Regenerate (free and keyless):
 *   curl -s 'https://api-v2.pendle.finance/core/v1/dashboard/positions/database/<wallet A>'
 *   curl -s 'https://api-v2.pendle.finance/core/v1/dashboard/positions/database/<wallet B>'
 *   curl -s 'https://api-v2.pendle.finance/core/v1/dashboard/positions/database/<wallet A>?filterUsd=10'
 *
 * WHY THESE TWO WALLETS. Between them they carry every field family the frozen
 * money-path validator drops on the floor, each NON-EMPTY:
 *
 *   Wallet A — four MATURED chain-1 markets with live balances: a matured PT
 *     (the G-18 case the redeem product exists for), matured LP legs with
 *     `activeBalance` well below `balance`, `claimTokenAmounts` on the LP legs,
 *     `closedPositions`, and `updatedAt` of 2025-07-28 — 364 days stale at
 *     capture, the staleness the corpus measured at 47 days and we now know is
 *     unbounded.
 *
 *   Wallet B — four chains, five NON-ZERO YT legs (the leg the current projector
 *     validates and then discards entirely), `claimTokenAmounts` on YT,
 *     `syPositions` on three chains, an LP whose `activeBalance` is 40% of its
 *     `balance`, and `updatedAt` of 2026-06-01 — 56 days stale.
 *
 * SHAPE FACTS these bodies pin:
 *   - `crossPtPositions` is a key on EACH `openPositions[]` ENTRY, not on the
 *     chain entry. It was EMPTY on all 326 wallets probed — see the fixture gap
 *     noted in the position-projector tests; no non-empty sample exists.
 *   - The chain entry carries `totalOpen`, `totalClosed`, `totalSy`,
 *     `closedPositions` and `updatedAt` beyond the `openPositions` the money
 *     path reads.
 *   - `activeBalance` appears on LP legs only, and is routinely a FRACTION of
 *     `balance` — the staked-vs-wallet split.
 *   - A leg with a zero balance still carries `valuation: 0`; absence of a
 *     position is expressed as `balance: "0"`, not as a missing leg.
 *   - `filterUsd` is applied server-side and REMOVES rows: wallet A's four
 *     open positions (all under $10) become zero at `filterUsd=10`.
 */

/** Wallet A — matured PT + matured LP legs, claimables, 364-day stale `updatedAt`. */
export const PENDLE_DASHBOARD_MATURED: unknown = {
    "positions": [
      {
        "chainId": 1,
        "totalOpen": 4,
        "totalClosed": 3,
        "totalSy": 1,
        "openPositions": [
          {
            "marketId": "1-0xafdc922d0059147486cc1f0f32e3a2354b0d35cc",
            "pt": {
              "valuation": 1.0198843562633857,
              "balance": "1056635259419805288"
            },
            "yt": {
              "valuation": 0,
              "balance": "18117721582359052161",
              "claimTokenAmounts": []
            },
            "lp": {
              "valuation": 5.059808449406191,
              "balance": "2565304199423659860",
              "activeBalance": "1026121679769463944",
              "claimTokenAmounts": [
                {
                  "token": "1-0x808507121b80c02388fad14726482e061b8da827",
                  "amount": "12899077924144508"
                }
              ]
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x048680f64d6dff1748ba6d9a01f578433787e24b",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0",
              "claimTokenAmounts": []
            },
            "lp": {
              "valuation": 1.9159132430304648,
              "balance": "967016389612833372",
              "activeBalance": "386806555845133348",
              "claimTokenAmounts": [
                {
                  "token": "1-0x808507121b80c02388fad14726482e061b8da827",
                  "amount": "1326780407260871"
                }
              ]
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x81f3a11db1de16f4f9ba8bf46b71d2b168c64899",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0",
              "claimTokenAmounts": []
            },
            "lp": {
              "valuation": 1.9550298791074934,
              "balance": "1033299988942040744",
              "activeBalance": "413319995576816297",
              "claimTokenAmounts": [
                {
                  "token": "1-0x808507121b80c02388fad14726482e061b8da827",
                  "amount": "2186829648056394"
                }
              ]
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xf8094570485b124b4f2abe98909a87511489c162",
            "pt": {
              "valuation": 0.41316173334597367,
              "balance": "428049761343350871"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          }
        ],
        "closedPositions": [
          {
            "marketId": "1-0x00b321d89a8c36b3929f20b7955080baed706d1b",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "157118344109602950050"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x22a72b0c504cbb7f8245208f84d8f035c311adec",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xb9b7840ec34094ce1269c38ba7a6ac7407f9c4e3",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "24596627293929171771",
              "claimTokenAmounts": [
                {
                  "token": "1-0x86e2a16a5abc67467ce502e3dab511c909c185a8",
                  "amount": "1948892902844918521"
                }
              ]
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0",
              "claimTokenAmounts": []
            },
            "crossPtPositions": []
          }
        ],
        "syPositions": [
          {
            "syId": "1-0x47bce1bb5d9a9072161ec25009bcd6e8d367b7d3",
            "balance": "2000000000000000000"
          }
        ],
        "updatedAt": "2025-07-28T18:40:22.368Z"
      }
    ]
  };

/** Wallet B — non-zero YT legs, SY positions, activeBalance split, 56-day stale. */
export const PENDLE_DASHBOARD_ACTIVE_YT: unknown = {
    "positions": [
      {
        "chainId": 1,
        "totalOpen": 2,
        "totalClosed": 18,
        "totalSy": 1,
        "openPositions": [
          {
            "marketId": "1-0x9eaaeda23177b7168c55a3a0f937f67919733449",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0",
              "claimTokenAmounts": []
            },
            "lp": {
              "valuation": 33.169990999072795,
              "balance": "13784740827710356437",
              "activeBalance": "5513896331084142574",
              "claimTokenAmounts": [
                {
                  "token": "1-0x808507121b80c02388fad14726482e061b8da827",
                  "amount": "50196354558232228"
                }
              ]
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x487e1cef7805cf0225dec3dd0f3044fe0fb70611",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "737241999785414107004",
              "claimTokenAmounts": [
                {
                  "token": "1-0xa36ecca8b7624d224f01cd6649c8afad3da12c3d",
                  "amount": "4979528302499125531"
                }
              ]
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0",
              "claimTokenAmounts": []
            },
            "crossPtPositions": []
          }
        ],
        "closedPositions": [
          {
            "marketId": "1-0xa9355a5d306c67027c54de0e5a72df76befa5694",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x038c1b03dab3b891afbca4371ec807edaa3e6eb6",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xd3bb297264bd6115ae163db4153038a79d78acba",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "934576623373669398"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x6010676bc2534652ad1ef5fa8073dcf9ad7ebfbe",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "757874825863690975"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x7c7fbb2d11803c35aa3e283985237ad27f64406b",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x7e0209ab6fa3c7730603b68799bbe9327dab7e88",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "1215005477632307616779"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xebf5c58b74a836f1e51d08e9c909c4a4530afd41",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "1848416"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xc387ad871d94990e073f1bd0b759ffdb5e0313aa",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "11335550936998541"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xdace1121e10500e9e29d071f01593fd76b000f08",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "14022797910381341225"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x2353193fa14a6477a4523e2c078e4063022fcf66",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xebf7fd1ec45f505175d92db4d180b8f323c17875",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x07b1711d4af74af661dde3b774741993b79fc59c",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xb6ac3d5da138918ac4e84441e924a20daa60dbdd",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xf4c449d6a2d1840625211769779ada42857d04dd",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "870869340963472446725"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x307c15f808914df5a5dbe17e5608f84953ffa023",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xe0938446e04f24217491e07719507cf7333a6c2f",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xa83174f1dd8475378abca9d676dad3ce97409e0a",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          }
        ],
        "syPositions": [
          {
            "syId": "1-0xb1b9150f2085f6a553b547099977181ca802752a",
            "balance": "0"
          }
        ],
        "updatedAt": "2026-06-01T11:00:11.000Z"
      },
      {
        "chainId": 999,
        "totalOpen": 4,
        "totalClosed": 0,
        "totalSy": 4,
        "openPositions": [
          {
            "marketId": "999-0x97d985a71131afc02c320b636a268df34c6f42a4",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "13837716019917814786",
              "claimTokenAmounts": [
                {
                  "token": "999-0x0fcde5a369c0d71ac932840c8654db03681912dd",
                  "amount": "53073188775924470"
                }
              ]
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0",
              "claimTokenAmounts": []
            },
            "crossPtPositions": []
          },
          {
            "marketId": "999-0xab9b8a04d21c9fb1fee7b7d219cab9e725a86b0a",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "889510591",
              "claimTokenAmounts": [
                {
                  "token": "999-0x642135ff98c15cba7fcf1766502bd493be4d3492",
                  "amount": "4587393705002495526"
                }
              ]
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0",
              "claimTokenAmounts": []
            },
            "crossPtPositions": []
          },
          {
            "marketId": "999-0x25e8a59e7b42fd3e805edfaddd2e558bb6394682",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "17495494645364693682",
              "claimTokenAmounts": [
                {
                  "token": "999-0x8608cc009e64d0ebe6ae071a3c6107e0124eff41",
                  "amount": "3685371556707541"
                }
              ]
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0",
              "claimTokenAmounts": []
            },
            "crossPtPositions": []
          },
          {
            "marketId": "999-0x74bd27939416bbe5d184d9a974d2c7358f637433",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "663827212",
              "claimTokenAmounts": [
                {
                  "token": "999-0x0e7fb0315ee061c407fa3fc3ad2eaf610aeaace5",
                  "amount": "407895782464238132"
                }
              ]
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0",
              "claimTokenAmounts": []
            },
            "crossPtPositions": []
          }
        ],
        "closedPositions": [],
        "syPositions": [
          {
            "syId": "999-0x0e7fb0315ee061c407fa3fc3ad2eaf610aeaace5",
            "balance": "407895782464238132"
          },
          {
            "syId": "999-0x0fcde5a369c0d71ac932840c8654db03681912dd",
            "balance": "53073188775924470"
          },
          {
            "syId": "999-0x642135ff98c15cba7fcf1766502bd493be4d3492",
            "balance": "4587393705002495526"
          },
          {
            "syId": "999-0x8608cc009e64d0ebe6ae071a3c6107e0124eff41",
            "balance": "3685371556707541"
          }
        ],
        "updatedAt": "2026-06-01T10:55:06.114Z"
      },
      {
        "chainId": 8453,
        "totalOpen": 0,
        "totalClosed": 2,
        "totalSy": 0,
        "openPositions": [],
        "closedPositions": [
          {
            "marketId": "8453-0x727cebacfb10ffd353fc221d06a862b437ec1735",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "1913456"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "8453-0xe15578523937ed7f08e8f7a1fa8a021e07025a08",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "791605011901236831026"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          }
        ],
        "syPositions": [],
        "updatedAt": "2026-06-01T10:55:06.114Z"
      },
      {
        "chainId": 42161,
        "totalOpen": 1,
        "totalClosed": 11,
        "totalSy": 4,
        "openPositions": [
          {
            "marketId": "42161-0x22d95cec2b962c142fff9be88cfc7ef15043419f",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0",
              "claimTokenAmounts": []
            },
            "lp": {
              "valuation": 47.99265948370754,
              "balance": "19892543",
              "activeBalance": "19892543",
              "claimTokenAmounts": [
                {
                  "token": "42161-0x0c880f6761f1af8d9aa9c466984b80dab9a8c9e8",
                  "amount": "169743377916326002"
                }
              ]
            },
            "crossPtPositions": []
          }
        ],
        "closedPositions": [
          {
            "marketId": "42161-0xe11f9786b06438456b044b3e21712228adcaa0d1",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "1459533482894835327"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "42161-0x6f02c88650837c8dfe89f66723c4743e9cf833cd",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "42161-0x5e03c94fc5fb2e21882000a96df0b63d2c4312e2",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "42161-0x952083cde7aaa11ab8449057f7de23a970aa8472",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "1534731227952652868"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "42161-0x6ae79089b2cf4be441480801bb741a531d94312b",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "769506586068631234"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "42161-0x2dfaf9a5e4f293bceede49f2dba29aacdd88e0c4",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "3979075192012433897801"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "42161-0xf9f9779d8ff604732eba9ad345e6a27ef5c2a9d6",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "1333214165348820158"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "42161-0x35f3db08a6e9cb4391348b0b404f493e7ae264c0",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "822924444978513585"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "42161-0xed99fc8bdb8e9e7b8240f62f69609a125a0fbf14",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "136237327256529344"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "42161-0x4ed09847377c30aa4e74ad071e719c5814ad9ead",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "747576443"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "42161-0xfad63f0a2ff618edde23561dff212edfeddbe89d",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          }
        ],
        "syPositions": [
          {
            "syId": "42161-0x0de802e3d6cc9145a150bbdc8da9f988a98c5202",
            "balance": "0"
          },
          {
            "syId": "42161-0xa6c895eb332e91c5b3d00b7baeeaae478cc502da",
            "balance": "0"
          },
          {
            "syId": "42161-0xc32e96b4c7eb7959b6a92f3f7ed5d2321e6ed3d4",
            "balance": "0"
          },
          {
            "syId": "42161-0xf176fb51f4eb826136a54fdc71c50fcd2202e272",
            "balance": "0"
          }
        ],
        "updatedAt": "2026-06-01T10:55:06.114Z"
      }
    ]
  };

/** Wallet A again with `filterUsd=10` — proves the server-side filter removes rows. */
export const PENDLE_DASHBOARD_FILTERED: unknown = {
    "positions": [
      {
        "chainId": 1,
        "totalOpen": 0,
        "totalClosed": 7,
        "totalSy": 1,
        "openPositions": [],
        "closedPositions": [
          {
            "marketId": "1-0x00b321d89a8c36b3929f20b7955080baed706d1b",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "157118344109602950050"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xafdc922d0059147486cc1f0f32e3a2354b0d35cc",
            "pt": {
              "valuation": 1.0198843562633857,
              "balance": "1056635259419805288"
            },
            "yt": {
              "valuation": 0,
              "balance": "18117721582359052161",
              "claimTokenAmounts": []
            },
            "lp": {
              "valuation": 5.059808449406191,
              "balance": "2565304199423659860",
              "activeBalance": "1026121679769463944",
              "claimTokenAmounts": [
                {
                  "token": "1-0x808507121b80c02388fad14726482e061b8da827",
                  "amount": "12899077924144508"
                }
              ]
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x048680f64d6dff1748ba6d9a01f578433787e24b",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0",
              "claimTokenAmounts": []
            },
            "lp": {
              "valuation": 1.9159132430304648,
              "balance": "967016389612833372",
              "activeBalance": "386806555845133348",
              "claimTokenAmounts": [
                {
                  "token": "1-0x808507121b80c02388fad14726482e061b8da827",
                  "amount": "1326780407260871"
                }
              ]
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x22a72b0c504cbb7f8245208f84d8f035c311adec",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0x81f3a11db1de16f4f9ba8bf46b71d2b168c64899",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "0",
              "claimTokenAmounts": []
            },
            "lp": {
              "valuation": 1.9550298791074934,
              "balance": "1033299988942040744",
              "activeBalance": "413319995576816297",
              "claimTokenAmounts": [
                {
                  "token": "1-0x808507121b80c02388fad14726482e061b8da827",
                  "amount": "2186829648056394"
                }
              ]
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xb9b7840ec34094ce1269c38ba7a6ac7407f9c4e3",
            "pt": {
              "valuation": 0,
              "balance": "0"
            },
            "yt": {
              "valuation": 0,
              "balance": "24596627293929171771",
              "claimTokenAmounts": [
                {
                  "token": "1-0x86e2a16a5abc67467ce502e3dab511c909c185a8",
                  "amount": "1948892902844918521"
                }
              ]
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0",
              "claimTokenAmounts": []
            },
            "crossPtPositions": []
          },
          {
            "marketId": "1-0xf8094570485b124b4f2abe98909a87511489c162",
            "pt": {
              "valuation": 0.41316173334597367,
              "balance": "428049761343350871"
            },
            "yt": {
              "valuation": 0,
              "balance": "0"
            },
            "lp": {
              "valuation": 0,
              "balance": "0",
              "activeBalance": "0"
            },
            "crossPtPositions": []
          }
        ],
        "syPositions": [
          {
            "syId": "1-0x47bce1bb5d9a9072161ec25009bcd6e8d367b7d3",
            "balance": "2000000000000000000"
          }
        ],
        "updatedAt": "2025-07-28T18:40:22.368Z"
      }
    ]
  };
