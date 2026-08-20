/**
 * A13 — the hover copy key: an assistant row copies the PLAIN-TEXT projection
 * of its markdown, a user row copies its literal text, and the timestamp is
 * hover-revealed chrome inside a hover root.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptMessage } from "../../TranscriptMessage.js";
import type { TranscriptEntry } from "../../transcriptRowModel.js";

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(cleanup);

function row(
  variant: "assistant" | "user",
  content: string,
): TranscriptEntry {
  return {
    id: 1,
    variant,
    label: null,
    content,
    createdAt: "2026-08-20T10:00:00.000Z",
    reasoning: null,
  };
}

describe("copy-message", () => {
  it("copies an assistant row's markdown as plain text (markup stripped, words kept)", async () => {
    const { getByLabelText } = render(
      <TranscriptMessage
        row={row("assistant", "Swap **1.5 ETH** via [Kyber](https://kyber.network).")}
      />,
    );
    fireEvent.click(getByLabelText("Copy message"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Swap 1.5 ETH via Kyber."),
    );
  });

  it("copies a user row's literal text untouched", async () => {
    const { getByLabelText } = render(
      <TranscriptMessage row={row("user", "buy **the** dip")} />,
    );
    fireEvent.click(getByLabelText("Copy message"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("buy **the** dip"));
  });

  it("mounts the clock as hover-revealed chrome inside a hover root", () => {
    const { container } = render(
      <TranscriptMessage row={row("assistant", "hello")} />,
    );
    const root = container.querySelector("[data-time-hover-root]");
    expect(root).not.toBeNull();
    expect(root?.querySelector(".vex-time-reveal")).not.toBeNull();
  });
});
