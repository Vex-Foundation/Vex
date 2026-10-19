/**
 * MarkdownContent fallback (stage 8-2a). When the lexer throws, the
 * component must render the original text verbatim (escaped) instead of
 * blanking the message. The lexer is mocked here to force the throw path.
 */

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";

vi.mock("../lexer.js", () => ({
  lexMarkdown: () => {
    throw new Error("boom");
  },
}));

const { MarkdownContent } = await import("../MarkdownContent.js");

describe("MarkdownContent fallback", () => {
  it("renders the original text verbatim when tokenizing throws", () => {
    const { container } = render(
      createElement(MarkdownContent, { text: "raw **text** stays" }),
    );
    expect(container.textContent).toBe("raw **text** stays");
    expect(container.querySelector("strong")).toBeNull();
  });
});
