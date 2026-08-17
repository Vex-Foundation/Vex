/**
 * Merkl REWARD fixtures - captured VERBATIM from the live keyless endpoint
 * `https://api.merkl.xyz` on 2026-08-14. Nothing is synthesized; numeric and
 * structural truth is byte-exact as returned. The body was TRIMMED (to three
 * reward rows, two breakdowns each) and the `proofs` array was removed, but no
 * value was edited.
 *
 * WHY `proofs` IS GONE rather than trimmed: each row carried twenty Merkle
 * proof hashes, which are the input to an on-chain CLAIM. Vex does not claim in
 * this batch, the validator never reads them, and a fixture is not the place to
 * carry the material for a transaction nothing here performs.
 *
 * ONE NAMED SANITISATION, and only one: NONE was applied. Every address below is
 * public on-chain data - token contracts, campaign hashes, and one third-party
 * wallet that appears in Merkl's own public API response and in every block
 * explorer. `MERKL_REWARDS_CAPTURED_WALLET` records exactly whose it is, and it
 * is left as captured because the checksum casing is part of the shape under
 * test. Recorded here so a reader knows the choice was deliberate rather than
 * overlooked, per rules/06.
 *
 * Regenerate (keyless; GET, no auth header):
 *
 *   MERKL_USER_REWARDS_BASE
 *     curl -s -H 'User-Agent: Vex-Agent/1.0 (+https://vexlabs.ai)' \
 *       'https://api.merkl.xyz/v4/users/0x1A364E522A5Af6187Dc50b6DE9e41458F413C3B5/rewards?chainId=8453'
 *
 *   MERKL_OPPORTUNITY_MORPHO / MERKL_OPPORTUNITY_MOONWELL
 *     curl -s -H 'User-Agent: Vex-Agent/1.0 (+https://vexlabs.ai)' \
 *       'https://api.merkl.xyz/v4/opportunities/9836065204209028807'
 *     curl -s -H 'User-Agent: Vex-Agent/1.0 (+https://vexlabs.ai)' \
 *       'https://api.merkl.xyz/v4/opportunities/7346841169498192596'
 *
 * SHAPE FACTS these bodies pin, each of which shaped a decision in the code:
 *
 *   - `amount` IS LIFETIME ACCRUAL, NOT A CLAIMABLE BALANCE. The WELL row reads
 *     `amount: "27159256967843778403797"` against
 *     `claimed: "26977794427478008954964"`. The claim is the DIFFERENCE, about
 *     181 WELL, which is under one percent of the headline. This single pair of
 *     numbers is why `claimable` is computed rather than read.
 *
 *   - `pending` IS REAL AND IS NOT CLAIMABLE. The same row carries
 *     `pending: "50123183238199030734"`, accrual Merkl has computed but not yet
 *     published into a root. Adding it to the claim would promise money no
 *     transaction can currently move.
 *
 *   - EVERY RAW AMOUNT IS A STRING, including values far above 2^53, and the
 *     validator refuses a number form rather than parsing a double.
 *
 *   - ONE WALLET'S ROWS SPAN SEVERAL PROTOCOLS. The WELL and MORPHO rows point
 *     at opportunity `9836065204209028807` (protocol id `morpho`), while the
 *     USDC row points at `7346841169498192596` (protocol id `moonwell`). A
 *     Morpho-only default would have hidden a claimable USDC balance that the
 *     very same claim delivers.
 *
 *   - A REWARD ROW NAMES NO PROTOCOL. Attribution is only reachable through the
 *     opportunity lookup, which is why an unresolved opportunity is reported as
 *     UNKNOWN rather than as not-Morpho.
 *
 *   - DECIMALS DIFFER INSIDE ONE ANSWER: WELL and MORPHO are 18, USDC is 6.
 *     Reading one row at the other's scale is a twelve-order-of-magnitude error.
 *
 *   - UNKNOWN FIELDS ARRIVE. The MORPHO row's breakdowns carry `subCampaignId`,
 *     which Vex does not model. The tolerant reader ignores it rather than
 *     failing, and this fixture keeps it so that stays true.
 */

/** The real third-party wallet these bodies belong to. Left unsanitised, deliberately. */
export const MERKL_REWARDS_CAPTURED_WALLET = "0x1A364E522A5Af6187Dc50b6DE9e41458F413C3B5";

/** `GET /v4/users/{wallet}/rewards?chainId=8453`, verbatim minus `proofs`. */
export const MERKL_USER_REWARDS_BASE: unknown = [
    {
      "chain": {
        "id": 8453,
        "name": "Base"
      },
      "rewards": [
        {
          "root": "0x9d68f70676538b2f1482e7844a31d71a1fe46f67b8cec3a75b0c08b4d9ec1268",
          "distributionChainId": 8453,
          "recipient": "0x1A364E522A5Af6187Dc50b6DE9e41458F413C3B5",
          "amount": "27159256967843778403797",
          "claimed": "26977794427478008954964",
          "pending": "50123183238199030734",
          "token": {
            "chainId": 8453,
            "address": "0xA88594D404727625A9437C3f886C7643872296AE",
            "decimals": 18,
            "symbol": "WELL",
            "price": 0.0028379543901550374
          },
          "breakdowns": [
            {
              "root": "0x9d68f70676538b2f1482e7844a31d71a1fe46f67b8cec3a75b0c08b4d9ec1268",
              "distributionChainId": 8453,
              "reason": "ERC20_0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca",
              "amount": "996222242436832244304",
              "claimed": "996222242436832244304",
              "pending": "0",
              "campaignId": "0xec43a3d75ae25c5255eb06b3aac6b79ccb2cdb6b99740ea13553661b0f06b756",
              "opportunityId": "9836065204209028807"
            },
            {
              "root": "0x9d68f70676538b2f1482e7844a31d71a1fe46f67b8cec3a75b0c08b4d9ec1268",
              "distributionChainId": 8453,
              "reason": "ERC20_0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca",
              "amount": "9503669248735987133779",
              "claimed": "9503669248735987133779",
              "pending": "0",
              "campaignId": "0xee68c35c1c17447274efb3be7cb2cb37c31b3ed0d2beff6c7c0e4e5aef418853",
              "opportunityId": "9836065204209028807"
            }
          ]
        },
        {
          "root": "0x9d68f70676538b2f1482e7844a31d71a1fe46f67b8cec3a75b0c08b4d9ec1268",
          "distributionChainId": 8453,
          "recipient": "0x1A364E522A5Af6187Dc50b6DE9e41458F413C3B5",
          "amount": "101024796835927682293",
          "claimed": "101005398751678088668",
          "pending": "0",
          "token": {
            "chainId": 8453,
            "address": "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842",
            "decimals": 18,
            "symbol": "MORPHO",
            "price": 1.921721638761285
          },
          "breakdowns": [
            {
              "root": "0x9d68f70676538b2f1482e7844a31d71a1fe46f67b8cec3a75b0c08b4d9ec1268",
              "distributionChainId": 8453,
              "reason": "MultiLogProcessor_13164798418381406545~17091557224648086245_MorphoVault_ERC20_0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca",
              "amount": "857655009115115859",
              "claimed": "857655009115115859",
              "pending": "0",
              "campaignId": "0xae57399065d33921b158d9e876e7bc56e024470aa7257b050ac9e922618f557c",
              "subCampaignId": "17091557224648086245",
              "opportunityId": "9836065204209028807"
            },
            {
              "root": "0x9d68f70676538b2f1482e7844a31d71a1fe46f67b8cec3a75b0c08b4d9ec1268",
              "distributionChainId": 8453,
              "reason": "MultiLogProcessor_13164798418381406545~8141989068094467243_MorphoVault_ERC20_0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca",
              "amount": "850032914072907187",
              "claimed": "850032914072907187",
              "pending": "0",
              "campaignId": "0x24f7aba820a0c04bd149c9a69035dec2c340eb213ffa392190e9a15f87f5a569",
              "subCampaignId": "8141989068094467243",
              "opportunityId": "9836065204209028807"
            }
          ]
        },
        {
          "root": "0x9d68f70676538b2f1482e7844a31d71a1fe46f67b8cec3a75b0c08b4d9ec1268",
          "distributionChainId": 8453,
          "recipient": "0x1A364E522A5Af6187Dc50b6DE9e41458F413C3B5",
          "amount": "100807396",
          "claimed": "100616483",
          "pending": "0",
          "token": {
            "chainId": 8453,
            "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "decimals": 6,
            "symbol": "USDC",
            "price": 0.9995920227463039
          },
          "breakdowns": [
            {
              "root": "0x9d68f70676538b2f1482e7844a31d71a1fe46f67b8cec3a75b0c08b4d9ec1268",
              "distributionChainId": 8453,
              "reason": "MultiLogProcessor_11982020389348696789",
              "amount": "64906944",
              "claimed": "64906944",
              "pending": "0",
              "campaignId": "0x55c67bd9b51b6f14418bf7e17592916412257de679a30f7939111250eace95a6",
              "opportunityId": "7346841169498192596"
            },
            {
              "root": "0x9d68f70676538b2f1482e7844a31d71a1fe46f67b8cec3a75b0c08b4d9ec1268",
              "distributionChainId": 8453,
              "reason": "MultiLogProcessor_11982020389348696789",
              "amount": "25255116",
              "claimed": "25064203",
              "pending": "0",
              "campaignId": "0x4d37727870f86281654762cd0ca48f12f5e0d37c613aa52ec6098621d6489427",
              "opportunityId": "7346841169498192596"
            }
          ]
        }
      ]
    }
  ];

/** `GET /v4/opportunities/9836065204209028807`, the attribution fields only. */
export const MERKL_OPPORTUNITY_MORPHO: unknown = {
  id: "9836065204209028807",
  chainId: 8453,
  type: "MORPHOVAULT",
  name: "Supply to the Moonwell Flagship USDC vault on Morpho on Base",
  action: "LEND",
  protocol: {
    id: "morpho",
    name: "Morpho",
    tags: ["LENDING", "drip"],
    description: "Open infrastructure for onchain loans",
  },
};

/**
 * `GET /v4/opportunities/7346841169498192596`. The NON-Morpho opportunity in the
 * same wallet's rewards, and the reason this lane reports every token row.
 */
export const MERKL_OPPORTUNITY_MOONWELL: unknown = {
  id: "7346841169498192596",
  chainId: 8453,
  type: "ERC20_MULTI_TOKEN_CROSS_CHAIN",
  name: "Deposit USDC on Mamo via the Base App",
  action: "HOLD",
  protocol: {
    id: "moonwell",
    name: "Moonwell",
    tags: ["LENDING"],
    description: "",
  },
};
