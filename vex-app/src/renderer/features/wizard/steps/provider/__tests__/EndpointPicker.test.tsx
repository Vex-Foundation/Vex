import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProviderEndpointOption } from "@shared/schemas/provider-endpoints.js";
import { EndpointPicker } from "../EndpointPicker.js";
import { formatEndpointMeta } from "../formatEndpointMeta.js";

const ENDPOINTS: ReadonlyArray<ProviderEndpointOption> = [
  {
    tag: "anthropic",
    providerName: "Anthropic",
    contextLength: 1_000_000,
    quantization: "unknown",
    pricingInputPerMillion: 3,
    pricingOutputPerMillion: 15,
    pricingCacheReadPerMillion: 0.3,
    pricingCacheWritePerMillion: 3.75,
  },
  {
    // Same DISPLAY name as another tag in the live catalogue — the row must be
    // keyed and reported by `tag`, never by `providerName`.
    tag: "amazon-bedrock/eu-west-1",
    providerName: "Amazon Bedrock",
    contextLength: 200_000,
    quantization: "fp8",
    pricingInputPerMillion: 3,
    pricingOutputPerMillion: 15,
    pricingCacheReadPerMillion: null,
    pricingCacheWritePerMillion: null,
  },
];

function renderPicker(
  overrides: Partial<React.ComponentProps<typeof EndpointPicker>> = {},
) {
  const onChange = vi.fn();
  const onRetry = vi.fn();
  render(
    <EndpointPicker
      id="endpoint-picker"
      value={null}
      endpoints={ENDPOINTS}
      loading={false}
      failed={false}
      onChange={onChange}
      onRetry={onRetry}
      {...overrides}
    />,
  );
  return { onChange, onRetry };
}

afterEach(cleanup);

describe("EndpointPicker", () => {
  it("defaults to Auto and reports `null` when Auto is chosen", () => {
    const { onChange } = renderPicker({ value: "anthropic" });
    const auto = screen.getByText("Auto (recommended)").closest("button")!;
    expect(auto.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(auto);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("marks Auto selected when no pin is set", () => {
    renderPicker();
    const auto = screen.getByText("Auto (recommended)").closest("button")!;
    expect(auto.getAttribute("aria-checked")).toBe("true");
  });

  it("emits the endpoint TAG, not the display name", () => {
    const { onChange } = renderPicker();
    fireEvent.click(screen.getByText("amazon-bedrock/eu-west-1").closest("button")!);
    expect(onChange).toHaveBeenCalledWith("amazon-bedrock/eu-west-1");
  });

  it("renders provider name, base prices, cache marker, context and quantization", () => {
    renderPicker();
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(
      screen.getByText("1m ctx · $3 in / $15 out per 1M (base) · caching priced"),
    ).toBeTruthy();
    expect(
      screen.getByText("200k ctx · $3 in / $15 out per 1M (base) · fp8"),
    ).toBeTruthy();
  });

  it("states the filter honestly — tool calling, not general compatibility", () => {
    renderPicker();
    const copy = screen.getByText(/support tool calling/);
    expect(copy.textContent).toContain("base rates");
    expect(copy.textContent).not.toMatch(/require.?parameters/i);
  });

  it("shows a loading state without any endpoint rows", () => {
    renderPicker({ loading: true });
    expect(screen.getByText("Loading providers for this model…")).toBeTruthy();
    expect(screen.queryByText("Auto (recommended)")).toBeNull();
  });

  it("offers retry on failure and says Auto still works", () => {
    const { onRetry } = renderPicker({ failed: true });
    expect(
      screen.getByText("Provider list unavailable. Auto routing still works."),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("disables every row while the step is submitting", () => {
    renderPicker({ disabled: true });
    for (const row of screen.getAllByRole("radio")) {
      expect((row as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe("formatEndpointMeta", () => {
  it("omits pricing entirely rather than implying a free endpoint", () => {
    expect(
      formatEndpointMeta({
        tag: "unknown",
        providerName: "Unknown",
        contextLength: null,
        quantization: null,
        pricingInputPerMillion: null,
        pricingOutputPerMillion: null,
        pricingCacheReadPerMillion: null,
        pricingCacheWritePerMillion: null,
      }),
    ).toBe("");
  });
});
