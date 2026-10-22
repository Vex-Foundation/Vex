/**
 * The model picker's brand marks must read on both papers. The owner saw
 * "OpenAI: GPT-6 Luna" with no visible logo: the package's default OpenAI
 * mark paints its path `#fff`, white on the light paper. One-ink marks are
 * drawn in their `currentColor` variant (the row's ink token); this pins
 * that no one-ink mark keeps a hard-coded fill or stroke.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ModelBrandIcon } from "../ModelBrandIcon.js";

afterEach(() => cleanup());

/** Every painted colour inside the svg, the root's own fill included. */
function paints(svg: SVGSVGElement): string[] {
  const out: string[] = [];
  for (const node of [svg, ...svg.querySelectorAll("*")]) {
    for (const attr of ["fill", "stroke"]) {
      const value = node.getAttribute(attr);
      if (value !== null && value !== "none") out.push(value);
    }
  }
  return out;
}

describe("ModelBrandIcon", () => {
  it.each([
    ["openai/gpt-6-luna"],
    ["openrouter/auto"],
    ["x-ai/grok-5"],
    ["xai/grok-5"],
    ["grok/grok-5"],
    ["ollama/llama"],
    ["qwen/qwen3"],
    ["replicate/model"],
    ["cohere/command"],
  ])("draws the one-ink mark of %s in currentColor only", (modelId) => {
    const { container } = render(<ModelBrandIcon modelId={modelId} size={16} />);
    const svg = container.querySelector("svg");
    if (svg === null) throw new Error("no mark");
    expect(svg.getAttribute("data-vex-brand-mark")).not.toBeNull();
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(new Set(paints(svg))).toEqual(new Set(["currentColor"]));
  });

  it("falls back to the generic glyph where the package has no readable mark", () => {
    const { container } = render(<ModelBrandIcon modelId="together/model" size={16} />);
    expect(container.querySelector("svg[data-vex-brand-mark]")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
