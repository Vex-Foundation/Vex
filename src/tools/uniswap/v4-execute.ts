/** Versioned UniversalRouter v4 encoding behind buildSwapTx. No signed permits. */
import { encodeAbiParameters, encodeFunctionData, decodeAbiParameters, decodeFunctionData, parseAbiParameters, zeroAddress, type Hex } from "viem";
import type { BuildSwapArgs, BuiltSwapTx } from "./execute.js";
import { assertV4Binding, v4Refusal } from "./v4-pool.js";
import { UNIVERSAL_ROUTER_ABI, V4_ACTIONS_PARAMS, V4_SWAP_PARAMS_20, V4_SWAP_PARAMS_211 } from "./v4-abis.js";

const ROUTER = "0x0000000000000000000000000000000000000002";
const BALANCE = 1n << 255n;
const payment = parseAbiParameters("address,uint256");
const sweep = parseAbiParameters("address,address,uint256");
const settle = parseAbiParameters("address,uint256,bool");
const transfer = parseAbiParameters("address,address,uint160");

export function buildV4SwapTx(args: BuildSwapArgs): BuiltSwapTx {
  const { route, deployment, amountIn, minAmountOut, recipient } = args;
  if (route.version !== "v4") throw v4Refusal("not a v4 route");
  assertV4Binding(deployment, route.v4);
  if (amountIn <= 0n || amountIn >= 1n << 127n || minAmountOut <= 0n || minAmountOut >= 1n << 128n) throw v4Refusal("amount outside the exact-input domain");
  const b = route.v4;
  const input = b.zeroForOne ? b.poolKey.currency0 : b.poolKey.currency1;
  const output = b.zeroForOne ? b.poolKey.currency1 : b.poolKey.currency0;
  if (route.path.length !== 2 || route.path[0]?.toLowerCase() !== input.toLowerCase() || route.path[1]?.toLowerCase() !== output.toLowerCase()) throw v4Refusal("route direction differs from the bound key");
  const wrapsInput = args.tokenInIsNative && input !== zeroAddress;
  const unwrapsInput = !args.tokenInIsNative && input === zeroAddress;
  const unwrapsOutput = args.tokenOutIsNative && output !== zeroAddress;
  const wrapsOutput = !args.tokenOutIsNative && output === zeroAddress;
  if ((wrapsInput && input.toLowerCase() !== deployment.weth.toLowerCase()) || (unwrapsOutput && output.toLowerCase() !== deployment.weth.toLowerCase())) throw v4Refusal("native transition is not the canonical wrapper");
  let commands = "0x";
  const inputs: Hex[] = [];
  const add = (command: string, data: Hex): void => { commands += command; inputs.push(data); };
  if (wrapsInput) add("0b", encodeAbiParameters(payment, [ROUTER, amountIn]));
  if (unwrapsInput) {
    add("02", encodeAbiParameters(transfer, [deployment.weth, ROUTER, amountIn]));
    add("0c", encodeAbiParameters(payment, [ROUTER, amountIn]));
  }
  const swap = { poolKey: b.poolKey, zeroForOne: b.zeroForOne, amountIn, amountOutMinimum: minAmountOut, hookData: "0x" as Hex };
  let swapData: Hex;
  switch (b.universalRouterVersion) {
    case "2.0": swapData = encodeAbiParameters(V4_SWAP_PARAMS_20, [swap]); break;
    case "2.1.1": swapData = encodeAbiParameters(V4_SWAP_PARAMS_211, [{ ...swap, minHopPriceX36: 0n }]); break;
    default: throw v4Refusal("unsupported router version");
  }
  // Explicit bounds cover the full debt and credit. Router-funded transitions
  // use SETTLE with OPEN_DELTA, because SETTLE_ALL always selects the user payer.
  const routerPays = wrapsInput || unwrapsInput;
  const custodyOutput = unwrapsOutput || wrapsOutput;
  const actions = `0x06${routerPays ? "0b" : "0c"}${custodyOutput ? "0e" : "0f"}` as Hex;
  add("10", encodeAbiParameters(V4_ACTIONS_PARAMS, [actions, [
    swapData,
    routerPays ? encodeAbiParameters(settle, [input, 0n, false]) : encodeAbiParameters(payment, [input, amountIn]),
    custodyOutput ? encodeAbiParameters(sweep, [output, ROUTER, 0n]) : encodeAbiParameters(payment, [output, minAmountOut]),
  ]]));
  if (unwrapsOutput) add("0c", encodeAbiParameters(payment, [recipient, minAmountOut]));
  if (wrapsOutput) add("0b", encodeAbiParameters(payment, [recipient, BALANCE]));
  if (wrapsInput) add("0c", encodeAbiParameters(payment, [recipient, 0n]));
  if (unwrapsInput) add("0b", encodeAbiParameters(payment, [recipient, BALANCE]));
  add("04", encodeAbiParameters(sweep, [zeroAddress, recipient, 0n]));
  return { to: b.universalRouter, value: args.tokenInIsNative ? amountIn : 0n,
    data: encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: "execute", args: [commands as Hex, inputs, args.deadline] }) };
}

/** Meaning check independent of the transaction-integrity comparison. */
export function decodeV4SwapFloor(data: Hex, version: "2.0" | "2.1.1"): bigint | null {
  try {
    const outer = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data });
    const commands: string[] = outer.args[0].slice(2).match(/.{2}/g) ?? [];
    if (commands.length !== outer.args[1].length || commands.filter(c => c === "10").length !== 1) return null;
    if (commands.some(c => !["02", "04", "0b", "0c", "10"].includes(c))) return null;
    const v4 = outer.args[1][commands.indexOf("10")];
    if (!v4) return null;
    const [actions, params] = decodeAbiParameters(V4_ACTIONS_PARAMS, v4);
    if (!["0x060c0f", "0x060b0f", "0x060c0e", "0x060b0e"].includes(actions) || params.length !== 3 || !params[0]) return null;
    const [swap] = version === "2.0" ? decodeAbiParameters(V4_SWAP_PARAMS_20, params[0]) : decodeAbiParameters(V4_SWAP_PARAMS_211, params[0]);
    if (actions.endsWith("0f")) {
      if (!params[2] || decodeAbiParameters(payment, params[2])[1] !== swap.amountOutMinimum) return null;
    }
    return swap.amountOutMinimum;
  } catch { return null; }
}
