import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const migration = readFileSync(
  path.join(root, "src/vex-agent/db/migrations/039_hyperliquid_execution_intents.sql"),
  "utf8",
);

describe("039 Hyperliquid execution intent migration", () => {
  it("extends the existing execution audit with an intent-to-outcome lifecycle", () => {
    expect(migration).toMatch(/ALTER TABLE protocol_executions/i);
    expect(migration).toMatch(/execution_status TEXT NOT NULL DEFAULT 'succeeded'/i);
    expect(migration).toMatch(/CHECK \(execution_status IN \('intent', 'succeeded', 'failed'\)\)/i);
  });
});
