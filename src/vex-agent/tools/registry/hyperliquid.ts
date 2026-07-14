/** Always-visible internal Hyperliquid workspace entry point. */

import type { ToolDef } from "../types.js";

export const HYPERLIQUID_INTERNAL_TOOLS: readonly ToolDef[] = [
  {
    name: "hyperliquid_enter",
    kind: "internal",
    mutating: false,
    pressureSafety: "safe_at_barrier",
    actionKind: "local_write",
    description:
      "Enter the Hyperliquid trading workspace (Hypervexing). Use when the user asks for Hypervexing/HL mode or clearly wants to trade Hyperliquid perps. If the workspace is already active, this is a no-op.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];
