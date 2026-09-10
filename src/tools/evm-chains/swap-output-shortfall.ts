import type { Address, Hex } from "viem";

export interface SwapOutputCallClient {
  call(request: { account: Address; to: Address; data: Hex; value: bigint;
    requestOptions: { signal: AbortSignal } }): Promise<{ data?: Hex }>;
}

export interface SwapOutputObservation {
  readonly quotedOutputRaw: string;
  readonly approvedMinimumOutputRaw: string;
  readonly simulatedOutputRaw?: string;
}

export function swapOutputEvidence(observation: SwapOutputObservation): {
  quotedOutputRaw: string; approvedMinimumOutputRaw: string; simulatedOutputRaw: string | null; shortfallRaw: string | null;
  simulationReference: "post_refusal_eth_call" | "unavailable";
} {
  const quoted = BigInt(observation.quotedOutputRaw);
  const output = observation.simulatedOutputRaw === undefined ? null : BigInt(observation.simulatedOutputRaw);
  return { quotedOutputRaw: observation.quotedOutputRaw, approvedMinimumOutputRaw: observation.approvedMinimumOutputRaw,
    simulatedOutputRaw: output?.toString() ?? null,
    simulationReference: output === null ? "unavailable" : "post_refusal_eth_call",
    shortfallRaw: output === null ? null : (quoted > output ? quoted - output : 0n).toString() };
}

/** A string-only router revert does not reveal an exact output. Report that limit explicitly. */
export function describeSwapOutputShortfall(observation: SwapOutputObservation): string {
  const quoted = BigInt(observation.quotedOutputRaw);
  const minimum = BigInt(observation.approvedMinimumOutputRaw);
  if (observation.simulatedOutputRaw !== undefined) {
    const output = BigInt(observation.simulatedOutputRaw);
    const shortfall = swapOutputEvidence(observation).shortfallRaw;
    return `Quoted output ${quoted}, simulated output ${output}, shortfall ${shortfall} raw output-token units; approved floor ${minimum}. `
      + "The output was measured by a separate read-only diagnostic after refusal; the approved transaction remains refused and unchanged. ";
  }
  return `Quoted output ${quoted}; approved floor ${minimum} raw output-token units. `
    + "The simulation reverted without returning an output amount, so the exact simulated output and shortfall are unavailable. ";
}
