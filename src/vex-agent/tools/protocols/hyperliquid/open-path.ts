/** Policy-only selector for the two validated client entry capabilities. */
export function selectPerpOpenPath(requireStopLoss: boolean, hasStopLoss: boolean): "normalTpsl" | "plain" {
  return requireStopLoss || hasStopLoss ? "normalTpsl" : "plain";
}
