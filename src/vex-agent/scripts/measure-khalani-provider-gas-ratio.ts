/**
 * Measures how far a Khalani deposit plan's own gas figure sits above Vex's
 * fresh `eth_estimateGas` for the SAME call — the evidence behind
 * `GAS_LIMIT_PROVIDER_CEILING_PERCENT` in
 * `src/tools/evm-chains/gas-limit-headroom.ts`.
 *
 * READ-ONLY AND FREE. Quote (`POST /v1/quotes`), deposit build
 * (`POST /v1/deposit/build`) and `eth_estimateGas` cost nothing and change
 * nothing. This script never signs, never broadcasts, never spends, and holds
 * no key material. The addresses it quotes for are PUBLIC, well-known Base
 * accounts used only as estimation subjects — nothing is ever sent to or from
 * them.
 *
 * Results and derivation:
 * `src/tools/evm-chains/gas-limit-provider-ceiling-measurement.md`.
 * Re-run this before changing the ceiling, and update that file's table with
 * the new numbers rather than editing the constant alone.
 *
 *     pnpm run measure:khalani-gas-ratio
 *     KHALANI_API_URL=… BASE_RPC_URL=… pnpm run measure:khalani-gas-ratio
 */

import { encodeAbiParameters, keccak256, pad, parseAbiParameters, toHex } from "viem";

const KHALANI_API = process.env.KHALANI_API_URL ?? "https://api.hyperstream.dev";
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";

const BASE_CHAIN_ID = 8453;
const ARBITRUM_CHAIN_ID = 42161;
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * Public Base accounts holding native ETH, used READ-ONLY as `eth_estimateGas`
 * subjects. A native-token route is the one shape whose deposit leg can be
 * estimated without an existing ERC-20 allowance, which is why the measurement
 * uses it.
 */
const SUBJECTS: ReadonlyArray<readonly [string, string]> = [
  ["coinbase-hot-4663", "0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A"],
  ["base-fee-vault", "0x4200000000000000000000000000000000000016"],
];

/** Two sizes, because a route's gas can depend on the amount it settles. */
const AMOUNTS_WEI = ["3000000000000000", "30000000000000000"] as const;

interface ProbeRow {
  readonly subject: string;
  readonly amountWei: string;
  readonly route: string;
  readonly role: "deposit" | "approval";
  readonly providerGas: bigint | null;
  readonly ownEstimate: bigint | null;
  readonly note?: string;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${url} returned ${response.status}: ${text.slice(0, 200)}`);
  }
}

async function estimateGas(call: { to: string; data?: string; value?: string }, from: string): Promise<bigint | null> {
  const raw = await postJson(BASE_RPC, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_estimateGas",
    params: [{ from, to: call.to, data: call.data, ...(call.value ? { value: call.value } : {}) }],
  }) as { result?: string };
  return typeof raw.result === "string" ? BigInt(raw.result) : null;
}

async function probeSubject(label: string, from: string): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  for (const amountWei of AMOUNTS_WEI) {
    const quote = await postJson(`${KHALANI_API}/v1/quotes`, {
      tradeType: "EXACT_INPUT",
      fromChainId: BASE_CHAIN_ID,
      fromToken: NATIVE,
      toChainId: ARBITRUM_CHAIN_ID,
      toToken: USDC_ARBITRUM,
      amount: amountWei,
      fromAddress: from,
    }) as { quoteId?: string; routes?: ReadonlyArray<{ routeId: string }> };

    for (const route of quote.routes ?? []) {
      const plan = await postJson(`${KHALANI_API}/v1/deposit/build`, {
        from,
        quoteId: quote.quoteId,
        routeId: route.routeId,
        depositMethod: "CONTRACT_CALL",
      }) as { approvals?: ReadonlyArray<{ deposit?: boolean; request?: { method?: string; params?: unknown[] } }> };

      for (const approval of plan.approvals ?? []) {
        if (approval.request?.method !== "eth_sendTransaction") continue;
        const call = approval.request.params?.[0] as { to: string; data?: string; value?: string; gas?: string };
        rows.push({
          subject: label,
          amountWei,
          route: route.routeId,
          role: approval.deposit === true ? "deposit" : "approval",
          providerGas: call.gas ? BigInt(call.gas) : null,
          ownEstimate: await estimateGas(call, from),
        });
      }
    }
  }
  return rows;
}

function ratio(row: ProbeRow): string {
  if (row.providerGas === null) return "— (no provider gas field)";
  if (row.ownEstimate === null || row.ownEstimate === 0n) return "— (no own estimate)";
  return `${(Number(row.providerGas) / Number(row.ownEstimate)).toFixed(3)}x`;
}

/**
 * USDC's `allowed` mapping lives at storage slot 10 (FiatTokenV1 layout, which
 * the Base proxy inherits). Overriding it lets `eth_estimateGas` price an
 * ERC-20 deposit leg WITHOUT an allowance existing on chain — the only way to
 * measure the routes that quote a flat constant, and the measurement that
 * forced the ceiling's absolute exemption.
 */
const USDC_ALLOWANCE_STORAGE_SLOT = 10n;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function allowanceStorageSlot(owner: string, spender: string): string {
  const inner = keccak256(encodeAbiParameters(parseAbiParameters("address, uint256"), [
    owner as `0x${string}`,
    USDC_ALLOWANCE_STORAGE_SLOT,
  ]));
  return keccak256(encodeAbiParameters(parseAbiParameters("address, bytes32"), [spender as `0x${string}`, inner]));
}

/** The ERC-20 route, whose deposit leg cannot be estimated without an allowance. */
async function probeErc20Routes(label: string, from: string): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  const quote = await postJson(`${KHALANI_API}/v1/quotes`, {
    tradeType: "EXACT_INPUT",
    fromChainId: BASE_CHAIN_ID,
    fromToken: USDC_BASE,
    toChainId: ARBITRUM_CHAIN_ID,
    toToken: USDC_ARBITRUM,
    amount: "5000000",
    fromAddress: from,
  }) as { quoteId?: string; routes?: ReadonlyArray<{ routeId: string }> };

  for (const route of quote.routes ?? []) {
    const plan = await postJson(`${KHALANI_API}/v1/deposit/build`, {
      from, quoteId: quote.quoteId, routeId: route.routeId, depositMethod: "CONTRACT_CALL",
    }) as { approvals?: ReadonlyArray<{ deposit?: boolean; request?: { method?: string; params?: unknown[] } }> };

    const legs = (plan.approvals ?? []).filter((a) => a.request?.method === "eth_sendTransaction");
    const approval = legs.find((a) => a.deposit !== true)?.request?.params?.[0] as { data?: string } | undefined;
    const deposit = legs.find((a) => a.deposit === true)?.request?.params?.[0] as
      { to: string; data?: string; value?: string; gas?: string } | undefined;
    if (!deposit) continue;

    // The spender the approval authorises; fall back to the deposit target.
    const spender = approval?.data ? `0x${approval.data.slice(34, 74)}` : deposit.to;
    const override = {
      [USDC_BASE]: {
        stateDiff: { [allowanceStorageSlot(from, spender)]: pad(toHex(2n ** 255n), { size: 32 }) },
      },
    };
    const estimated = await postJson(BASE_RPC, {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_estimateGas",
      params: [
        { from, to: deposit.to, data: deposit.data, ...(deposit.value ? { value: deposit.value } : {}) },
        "latest",
        override,
      ],
    }) as { result?: string };

    rows.push({
      subject: `${label} (ERC-20, allowance overridden)`,
      amountWei: "5000000 (USDC atomic)",
      route: route.routeId,
      role: "deposit",
      providerGas: deposit.gas ? BigInt(deposit.gas) : null,
      ownEstimate: typeof estimated.result === "string" ? BigInt(estimated.result) : null,
    });
  }
  return rows;
}

const rows: ProbeRow[] = [];
for (const [label, address] of SUBJECTS) {
  rows.push(...await probeSubject(label, address));
}
rows.push(...await probeErc20Routes(SUBJECTS[0]![0], SUBJECTS[0]![1]));

console.log("| subject | amount (wei) | route | leg | provider gas | own eth_estimateGas | provider/own |");
console.log("|---|---|---|---|---|---|---|");
for (const row of rows) {
  console.log(
    `| ${row.subject} | ${row.amountWei} | ${row.route} | ${row.role} | `
      + `${row.providerGas ?? "none"} | ${row.ownEstimate ?? "unavailable"} | ${ratio(row)} |`,
  );
}

const observed = rows
  .filter((row) => row.providerGas !== null && row.ownEstimate !== null && row.ownEstimate > 0n)
  .map((row) => Number(row.providerGas) / Number(row.ownEstimate));
if (observed.length > 0) {
  console.log(`\nrows with a provider figure: ${observed.length}/${rows.length}`);
  console.log(`max provider/own ratio observed: ${Math.max(...observed).toFixed(3)}x`);
}
