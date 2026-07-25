import { describe, it, expect } from "vitest";

import { ctx } from "./_solana-jupiter-handlers-context.js";
import { SOLANA_JUPITER_HANDLERS } from "../../../vex-agent/tools/protocols/solana-jupiter/handlers.js";

// Lend-domain slice of the original combined solana-jupiter-handlers.test.ts.
describe("solana-jupiter handlers — lend", () => {
  it("solana.lend.deposit fails without required params", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.lend.deposit"]!(
      {},
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });
});
