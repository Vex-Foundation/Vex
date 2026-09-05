/**
 * Khalani bridge-executor unit coverage — RE-PINNED for the Phase-2 W3a staged
 * rewrite (`src/tools/khalani/bridge-executor.ts`).
 *
 * The pre-W3a executor exposed a monolithic `executeDepositPlan` (+ its
 * `executeEvm*` / `executeSolana*` / `executeTransfer*` internals) that signed
 * AND broadcast AND submitted in one call. W3a removed all of those in favour of
 * two primitives: the pure planner `planKhalaniDepositLegs` and the staged
 * per-leg signer `signStageKhalaniLeg`. This suite keeps the still-valid pure
 * coverage and re-pins the executor-level intents that the new green suites do
 * NOT already own.
 *
 * WHERE EACH REMOVED `executeDepositPlan` TEST WENT (no coverage lost silently):
 *   - "blocks PERMIT2"                     → executor-staged-leg.test.ts "blocks PERMIT2"
 *   - "routes EVM CONTRACT_CALL"           → executor-staged-leg.test.ts "classifies roles" + "stages hash BEFORE broadcast, then confirms"
 *   - "submits the hash from deposit=true" → executor-staged-leg.test.ts "classifies roles" (isDeposit == 1) + staged-execute-safety.test.ts happy path (submits depositTxHash)
 *   - "never submits a reverted deposit"   → staged-execute-safety.test.ts "reverted deposit → fails the leg + aborts, no submit"
 *   - "routes Solana CONTRACT_CALL"        → executor-staged-leg.test.ts "Solana staged leg" (executor signs) + staged-execute-safety.test.ts "Solana source is refused" (handler refusal)
 *   - "no deposit txHash (only switch)"    → executor-staged-leg.test.ts "skips a wallet_switchEthereumChain approval" + "requires exactly one deposit leg"
 *   - "omits deposit=true"                 → executor-staged-leg.test.ts "requires exactly one deposit leg"
 *   - "EVM source + Solana signer guard"   → executor-staged-leg.test.ts "family mismatch fails closed (Solana leg, EVM signer)" (same guard, mirror direction)
 *   - "broadcast-only approval no-wait"    → DELETED (obsolete by design): W3a's staged discipline (R4) ALWAYS waits a bounded receipt per leg; the old conditional `waitForReceipt:false` fast-path no longer exists.
 *
 * RE-PINNED HERE (planner intents the green suites do not cover): the
 * `wallet_switchEthereumChain` CHAIN_MISMATCH guard, TRANSFER-plan planning
 * (EVM ERC20, EVM native, Solana-not-implemented), and the unsupported-method
 * rejection — all now expressed against the pure `planKhalaniDepositLegs`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "viem";
import { VexError, ErrorCodes } from "../../errors.js";
import { parseBigintish, planKhalaniDepositLegs } from "@tools/khalani/bridge-executor.js";
import type {
  ContractCallDepositPlan,
  KhalaniChain,
  TransferDepositPlan,
} from "@tools/khalani/types.js";

const ETH_CHAIN: KhalaniChain = {
  type: "eip155",
  id: 1,
  name: "Ethereum",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://eth.example"] } },
  blockExplorers: { default: { name: "Etherscan", url: "https://etherscan.io" } },
};

const SOL_CHAIN: KhalaniChain = {
  type: "solana",
  id: 20011000000,
  name: "Solana",
  nativeCurrency: { name: "Sol", symbol: "SOL", decimals: 9 },
  rpcUrls: { default: { http: ["https://solana.example"] } },
};

const TOKEN = "0x4444444444444444444444444444444444444444";
const DEPOSIT_ADDR = "0x3333333333333333333333333333333333333333";

/**
 * The origin binding the planner needs. No plan in this suite carries an
 * approval leg, so it is never the subject; it names the token and the amount
 * the TRANSFER plans below move.
 */
const ORIGIN = {
  fromToken: TOKEN,
  wallet: "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA",
  bridgedAmountRaw: "1000000",
};

/** Assert a synchronous `planKhalaniDepositLegs` call throws a `VexError` with `code`. */
function expectPlanThrowsCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(VexError);
  if (caught instanceof VexError) {
    expect(caught.code).toBe(code);
  }
}

describe("parseBigintish", () => {
  it("returns undefined for null/undefined", () => {
    expect(parseBigintish(null, "test")).toBeUndefined();
    expect(parseBigintish(undefined, "test")).toBeUndefined();
  });

  it("parses bigint directly", () => {
    expect(parseBigintish(42n, "test")).toBe(42n);
  });

  it("parses number", () => {
    expect(parseBigintish(42, "test")).toBe(42n);
  });

  it("parses string", () => {
    expect(parseBigintish("42", "test")).toBe(42n);
  });

  it("parses hex string", () => {
    expect(parseBigintish("0x2a", "test")).toBe(42n);
  });

  it("throws for invalid string", () => {
    expect(() => parseBigintish("abc", "test")).toThrow("Invalid bigint");
  });
});

describe("planKhalaniDepositLegs — planner-level guards (staged rewrite)", () => {
  it("throws CHAIN_MISMATCH when wallet_switchEthereumChain requests a different chain", () => {
    const plan: ContractCallDepositPlan = {
      kind: "CONTRACT_CALL",
      approvals: [
        {
          type: "eip1193_request",
          request: {
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x89" }], // 137 = polygon, but route is ETH chain 1
          },
        },
      ],
    };
    expectPlanThrowsCode(() => planKhalaniDepositLegs(plan, ETH_CHAIN, null, ORIGIN), ErrorCodes.CHAIN_MISMATCH);
  });

  it("rejects an unsupported EVM approval method", () => {
    const plan: ContractCallDepositPlan = {
      kind: "CONTRACT_CALL",
      approvals: [
        {
          type: "eip1193_request",
          request: { method: "personal_sign", params: [] },
        },
      ],
    };
    expectPlanThrowsCode(() => planKhalaniDepositLegs(plan, ETH_CHAIN, null, ORIGIN), ErrorCodes.KHALANI_DEPOSIT_FAILED);
  });

  it("plans an EVM ERC20 TRANSFER as a single bridge_deposit leg with transfer calldata", () => {
    const plan: TransferDepositPlan = {
      kind: "TRANSFER",
      depositAddress: DEPOSIT_ADDR,
      amount: "1000000",
      token: TOKEN,
      chainId: 1,
    };
    const legs = planKhalaniDepositLegs(plan, ETH_CHAIN, null, ORIGIN);
    expect(legs).toHaveLength(1);
    const leg = legs[0]!;
    expect(leg.role).toBe("bridge_deposit");
    expect(leg.isDeposit).toBe(true);
    expect(leg.kind).toBe("evm");
    if (leg.kind !== "evm") throw new Error("expected an EVM leg");
    // ERC20 transfer → contract call (data set), never a native value transfer.
    expect(leg.tx.to).toBe(getAddress(TOKEN));
    expect(leg.tx.data).toBeDefined();
    expect(leg.tx.value).toBeUndefined();
  });

  it("plans an EVM native TRANSFER (zero-address token) as a value transfer, no calldata", () => {
    const plan: TransferDepositPlan = {
      kind: "TRANSFER",
      depositAddress: DEPOSIT_ADDR,
      amount: "1000000",
      token: "0x0000000000000000000000000000000000000000",
      chainId: 1,
    };
    const legs = planKhalaniDepositLegs(plan, ETH_CHAIN, null, ORIGIN);
    expect(legs).toHaveLength(1);
    const leg = legs[0]!;
    expect(leg.role).toBe("bridge_deposit");
    expect(leg.kind).toBe("evm");
    if (leg.kind !== "evm") throw new Error("expected an EVM leg");
    expect(leg.tx.to).toBe(getAddress(DEPOSIT_ADDR));
    expect(leg.tx.value).toBe(1000000n);
    expect(leg.tx.data).toBeUndefined();
  });

  it("rejects a Solana TRANSFER plan (not implemented)", () => {
    const plan: TransferDepositPlan = {
      kind: "TRANSFER",
      depositAddress: "11111111111111111111111111111111",
      amount: "1000000",
      token: "native",
      chainId: 20011000000,
    };
    expectPlanThrowsCode(() => planKhalaniDepositLegs(plan, SOL_CHAIN, null, ORIGIN), ErrorCodes.KHALANI_DEPOSIT_FAILED);
  });
});

describe("bridge-executor source-family signer regression", () => {
  /**
   * Walks the FOLDER, not just the facade. `bridge-executor.ts` became a
   * re-export surface when the 749-line module was split into
   * `bridge-executor/`; asserting only against the facade would have made this
   * regression pass vacuously the moment the implementation moved.
   */
  it("no bridge-executor module imports the zero-arg signer primitives", () => {
    const root = join(process.cwd(), "src/tools/khalani");
    const files = [
      join(root, "bridge-executor.ts"),
      ...readdirSync(join(root, "bridge-executor"))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(root, "bridge-executor", name)),
    ];
    // The split must not have emptied the walk — a folder that stops matching
    // would silently turn this assertion into a no-op.
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      expect(
        /\brequireEvmWallet\b/.test(src) || /\brequireSolanaWallet\b/.test(src),
        `${file} imports a zero-arg signer primitive`,
      ).toBe(false);
    }
  });
});
