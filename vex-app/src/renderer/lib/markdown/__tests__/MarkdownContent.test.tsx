/**
 * MarkdownContent tests (stage 8-2a). Covers element rendering for the
 * supported subset and the security matrix: href allowlist (https only),
 * raw-HTML-stays-literal, image-as-alt-text, and table/unsupported fallback.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { MarkdownContent, safeHref, safeImgSrc } from "../MarkdownContent.js";

function renderMd(text: string) {
  return render(createElement(MarkdownContent, { text }));
}

const NUL = String.fromCharCode(0);

describe("safeHref", () => {
  it("allows absolute https URLs", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
  });

  it("rejects every non-https / unsafe form", () => {
    expect(safeHref("http://example.com")).toBeNull();
    expect(safeHref("mailto:a@b.com")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("/relative/path")).toBeNull();
    expect(safeHref("//protocol-relative.example")).toBeNull();
    expect(safeHref("   ")).toBeNull();
    expect(safeHref(`https://e${NUL}.com`)).toBeNull();
  });
});

describe("safeImgSrc", () => {
  it("returns null for a well-formed https URL - remote images disabled for launch (W1)", () => {
    // Remote images are DISABLED for launch to close the CSP img-src
    // exfiltration channel; every source (even a clean public https logo)
    // resolves to null so the caller renders alt text only.
    expect(safeImgSrc("https://cdn.example/logo.png")).toBeNull();
  });

  it("rejects every non-https / unsafe form", () => {
    expect(safeImgSrc("http://cdn.example/a.png")).toBeNull();
    expect(safeImgSrc("javascript:alert(1)")).toBeNull();
    expect(safeImgSrc("data:image/png;base64,AAAA")).toBeNull();
    expect(safeImgSrc("//cdn.example/a.png")).toBeNull(); // protocol-relative
    expect(safeImgSrc("https://user:pass@cdn.example/a.png")).toBeNull(); // creds
    expect(safeImgSrc("   ")).toBeNull();
    expect(safeImgSrc(`https://e${NUL}.com/a.png`)).toBeNull(); // control char
  });

  it("rejects localhost / loopback / private / link-local hosts", () => {
    expect(safeImgSrc("https://localhost/a.png")).toBeNull();
    expect(safeImgSrc("https://printer.local/a.png")).toBeNull();
    expect(safeImgSrc("https://127.0.0.1/a.png")).toBeNull();
    expect(safeImgSrc("https://10.1.2.3/a.png")).toBeNull();
    expect(safeImgSrc("https://172.16.0.1/a.png")).toBeNull();
    expect(safeImgSrc("https://192.168.1.1/a.png")).toBeNull();
    expect(safeImgSrc("https://169.254.1.1/a.png")).toBeNull();
    expect(safeImgSrc("https://[::1]/a.png")).toBeNull();
    expect(safeImgSrc("https://[fc00::1]/a.png")).toBeNull();
    expect(safeImgSrc("https://[fe80::1]/a.png")).toBeNull();
    expect(safeImgSrc("https://[::ffff:127.0.0.1]/a.png")).toBeNull(); // IPv4-mapped IPv6
    // A public IP / host is now ALSO rejected — remote images disabled (W1).
    expect(safeImgSrc("https://8.8.8.8/a.png")).toBeNull();
  });
});

describe("MarkdownContent", () => {
  it("renders inline emphasis + inline code as elements", () => {
    const { container } = renderMd("**bold** and *em* and `code`");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("em");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("renders headings, lists, blockquotes and fenced code blocks", () => {
    const { container } = renderMd(
      "# Title\n\n- a\n- b\n\n1. x\n\n> quote\n\n```\ncode()\n```",
    );
    expect(container.querySelector("ul")).not.toBeNull();
    expect(container.querySelector("ol")).not.toBeNull();
    expect(container.querySelector("blockquote")).not.toBeNull();
    expect(container.querySelector("pre code")?.textContent).toContain("code()");
  });

  it("renders an https link as a safe blank-target anchor", () => {
    const { container } = renderMd("[ok](https://a.example/b)");
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://a.example/b");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("never renders a javascript: or http: link as an anchor (text only)", () => {
    const { container } = renderMd("[x](javascript:alert(1)) [y](http://a.b)");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("x");
    expect(container.textContent).toContain("y");
  });

  it("renders raw HTML inside markdown as literal text, never as elements", () => {
    const { container } = renderMd('<img src=x onerror="alert(1)"> <b>nope</b>');
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain('onerror="alert(1)"');
  });

  it("renders a well-formed https image as alt text only, never an <img> (remote images disabled for launch, W1)", () => {
    const { container } = renderMd("![the alt](https://a.b/c.png)");
    // Remote images are DISABLED for launch: even a clean https source renders
    // its alt text via the existing fallback branch — no <img> reaches the DOM,
    // closing the CSP img-src exfiltration channel.
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("the alt");
  });

  it("falls back to alt text (no <img>) for every image source, including well-formed public https", () => {
    const cases = [
      "![a](http://a.b/c.png)", // wrong scheme
      "![b](javascript:alert(1))",
      "![c](//a.b/c.png)", // protocol-relative
      "![d](https://u:p@a.b/c.png)", // embedded credentials
      "![e](https://localhost/c.png)", // localhost
      "![g](https://cdn.example/logo.png)", // clean public https - still disabled for launch (W1)
    ];
    for (const md of cases) {
      const { container } = renderMd(md);
      expect(container.querySelector("img")).toBeNull();
    }
    // A control-char source: build the markdown with an embedded NUL.
    const { container } = renderMd(`![f](https://a${NUL}.b/c.png)`);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("f");
  });

  it("renders a GFM table as a semantic <table> with header + body cells", () => {
    const { container } = renderMd(
      "| Asset | Amount |\n| --- | ---: |\n| ETH | 1.5 |\n| SOL | 20 |",
    );
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    const headers = Array.from(container.querySelectorAll("th")).map(
      (th) => th.textContent,
    );
    expect(headers).toEqual(["Asset", "Amount"]);
    const bodyRows = container.querySelectorAll("tbody tr");
    expect(bodyRows).toHaveLength(2);
    expect(container.querySelectorAll("tbody td")[0]?.textContent).toBe("ETH");
    // Right-aligned column carries the alignment class, not an inline style.
    const amountCell = container.querySelectorAll("tbody td")[1];
    expect(amountCell?.className).toContain("text-right");
    expect(amountCell?.getAttribute("style")).toBeNull();
  });

  it("renders inline markup inside table cells (still escaped, no HTML sink)", () => {
    const { container } = renderMd(
      "| k | v |\n| - | - |\n| **bold** | `<img src=x>` |",
    );
    expect(container.querySelector("td strong")?.textContent).toBe("bold");
    // Raw-HTML-looking cell text stays literal — no <img> element.
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x>");
  });

  it("renders a GFM task list with disabled checkboxes reflecting state, no literal marker", () => {
    const { container } = renderMd("- [x] done\n- [ ] todo");
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
    // Non-interactive display: disabled (and thus non-focusable), not interactive.
    expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
    expect(container.textContent).toContain("done");
    expect(container.textContent).toContain("todo");
    // The marked `checkbox` token is dropped — no doubled `[x]`/`[ ]` marker.
    expect(container.textContent).not.toContain("[x]");
    expect(container.textContent).not.toContain("[ ]");
  });
});

describe("article variant protocol-entry headings (owner correction 2026-07-20)", () => {
  const PROTOCOL_MD = "### ![Uniswap](/protocols/uniswap.png) Uniswap";

  it("renders a leading local logo as a 44px rounded card head with a serif name", () => {
    const { container } = render(
      createElement(MarkdownContent, { text: PROTOCOL_MD, variant: "article" }),
    );
    const heading = container.querySelector("h3");
    expect(heading).not.toBeNull();
    const logo = heading?.querySelector("img");
    // Local bundled asset passes the article gate; decorative (alt "") —
    // the serif name beside it carries the accessible heading text.
    expect(logo?.getAttribute("src")).toBe("/protocols/uniswap.png");
    expect(logo?.className).toContain("h-11");
    expect(logo?.className).toContain("rounded-lg");
    const name = heading?.querySelector("span");
    expect(name?.className).toContain("font-serif");
    expect(name?.textContent).toContain("Uniswap");
  });

  it("keeps the chat variant image-free for the same markdown (alt text only)", () => {
    const { container } = renderMd(PROTOCOL_MD);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Uniswap");
  });

  it("falls back to the plain heading when the leading image source is rejected", () => {
    const { container } = render(
      createElement(MarkdownContent, {
        text: "### ![X](https://evil.example/x.png) Name",
        variant: "article",
      }),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("h3")?.textContent).toContain("Name");
  });
});
