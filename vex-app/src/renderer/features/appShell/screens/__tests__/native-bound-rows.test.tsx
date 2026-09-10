import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AgentScanRow } from "../agent-scan/AgentScanRow.js";
import { EntryRow } from "../token-history/TokenHistoryRow.js";
import { entry } from "./_agent-scan-fixtures.js";
import { swapEntry } from "./_token-history-fixtures.js";

afterEach(cleanup);
const value = "170141183460469231731.687303715884105727";

it.each(["activity", "token"])("keeps the full native bound visible in the %s row", kind => {
  if (kind === "activity") {
    const row = entry({ id: "native-bound" });
    render(<AgentScanRow entry={{ ...row, input: { ...row.input, address: null, symbol: "ETH", displaySymbol: "ETH",
      decimals: 18, displayAmount: value, amountBasis: "lower_bound" } }} />);
  } else {
    const row = swapEntry({ id: "native-bound" });
    if (row.kind !== "swap") throw new Error("Expected the swap row fixture");
    render(<EntryRow entry={{ ...row, input: { ...row.input, token: null, symbol: "ETH", localSymbol: "ETH",
      amount: { value, unitProvenance: "human", basis: "lower_bound" } } }} />);
  }
  const quantity = screen.getByText(new RegExp(`^at least ${value.replaceAll(".", "\\.")}`));
  expect(quantity.textContent).toContain(`at least ${value}`);
  // A full helper string is insufficient if its row still hides overflow.
  for (let node: HTMLElement | null = quantity; node !== null; node = node.parentElement) {
    expect(node.classList.contains("truncate")).toBe(false);
    expect(node.classList.contains("overflow-hidden")).toBe(false);
  }
});
