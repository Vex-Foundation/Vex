/**
 * JsonTree invariants: values render as classed React text (never HTML),
 * containers collapse to previews and expand on demand, and copy-raw writes
 * the pretty-printed source.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonTree } from "../json-tree.js";

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(cleanup);

const DATA = {
  amount: "1.5",
  ok: true,
  legs: [{ token: "ETH" }, { token: "USDC" }],
};

describe("JsonTree", () => {
  it("renders the top level expanded with keys, classed values and no HTML sink", () => {
    const { container } = render(<JsonTree data={DATA} />);
    expect(container.textContent).toContain("amount");
    expect(container.querySelector(".vex-code-string")?.textContent).toBe('"1.5"');
    expect(container.querySelector(".vex-code-keyword")?.textContent).toBe("true");
    // A nested container collapses to a one-line preview, not its full rows:
    // only the root's group is expanded.
    expect(container.querySelectorAll('[role="group"]').length).toBe(1);
  });

  it("expands a collapsed child on its expander and collapses it again", () => {
    const { container, getAllByLabelText } = render(<JsonTree data={DATA} />);
    fireEvent.click(getAllByLabelText("Expand JSON node")[0] as Element);
    expect(container.textContent).toContain("ETH");
    fireEvent.click(getAllByLabelText("Collapse JSON node")[1] as Element);
    // legs collapsed back to its bracket preview: token rows fold away as
    // full rows (the one-line preview may still name the first entries).
    expect(container.querySelectorAll('[role="group"]').length).toBe(1);
  });

  it("copy-raw writes the pretty-printed JSON source", async () => {
    const { getByLabelText } = render(<JsonTree data={DATA} />);
    fireEvent.click(getByLabelText("Copy raw JSON"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(JSON.stringify(DATA, null, 2)),
    );
  });
});
