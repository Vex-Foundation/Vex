import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProviderEndpointOption } from "@shared/schemas/provider-endpoints.js";
import { EndpointPicker } from "../EndpointPicker.js";
import { formatEndpointMeta } from "../formatEndpointMeta.js";

function endpointOption(
  overrides: Partial<ProviderEndpointOption> = {},
): ProviderEndpointOption {
  return {
    tag: "anthropic",
    providerName: "Anthropic",
    contextLength: 1_000_000,
    quantization: "unknown",
    pricingInputPerMillion: 3,
    pricingOutputPerMillion: 15,
    pricingCacheReadPerMillion: 0.3,
    pricingCacheWritePerMillion: 3.75,
    pricingReasoningPerMillion: null,
    uptimeLast5mPercent: 99.5,
    uptimeLast30mPercent: 99.5,
    uptimeLast1dPercent: 99.5,
    statusCode: 0,
    isDeranked: false,
    availabilityScore: 99.5,
    ...overrides,
  };
}

const ENDPOINTS: ReadonlyArray<ProviderEndpointOption> = [
  endpointOption(),
  // Same DISPLAY name as another tag in the live catalogue — the row must be
  // keyed and reported by `tag`, never by `providerName`.
  endpointOption({
    tag: "amazon-bedrock/eu-west-1",
    providerName: "Amazon Bedrock",
    contextLength: 200_000,
    quantization: "fp8",
    pricingCacheReadPerMillion: null,
    pricingCacheWritePerMillion: null,
    pricingReasoningPerMillion: null,
    uptimeLast5mPercent: 98,
    uptimeLast30mPercent: 98,
    uptimeLast1dPercent: 98,
    availabilityScore: 98,
  }),
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

  it("renders uptime first, then base prices, cache marker, context and quantization", () => {
    renderPicker();
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(
      screen.getByText(
        "99.5% uptime · 1m ctx · $3 in / $15 out per 1M (base) · caching priced",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("98.0% uptime · 200k ctx · $3 in / $15 out per 1M (base) · fp8"),
    ).toBeTruthy();
  });

  it("states the filter honestly - tool calling, not general compatibility", () => {
    renderPicker();
    const copy = screen.getByText(/support tool calling/);
    expect(copy.textContent).toContain("base rates");
    expect(copy.textContent).toContain("recent uptime");
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

describe("EndpointPicker - availability", () => {
  it("badges the suggested endpoint, and only that one", () => {
    renderPicker({ suggestedEndpointTag: "anthropic" });
    const badges = screen.getAllByText("Suggested");
    expect(badges).toHaveLength(1);
    expect(badges[0]!.closest("button")!.dataset.vexProviderEndpoint).toBe(
      "anthropic",
    );
  });

  it("treats the suggestion as a HINT - it never selects the row", () => {
    const { onChange } = renderPicker({
      value: null,
      suggestedEndpointTag: "anthropic",
    });
    // Auto stays selected and nothing was emitted just because a row is badged.
    expect(
      screen.getByText("Auto (recommended)").closest("button")!.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByText("Anthropic").closest("button")!.getAttribute("aria-checked"),
    ).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders no badge when there is nothing honest to suggest", () => {
    renderPicker({ suggestedEndpointTag: null });
    expect(screen.queryByText("Suggested")).toBeNull();
  });

  it("renders an honest absence for an endpoint with no uptime data", () => {
    renderPicker({
      endpoints: [
        endpointOption({
          tag: "no-data",
          providerName: "No Data",
          uptimeLast5mPercent: null,
          uptimeLast30mPercent: null,
          uptimeLast1dPercent: null,
          availabilityScore: null,
        }),
      ],
    });
    expect(screen.getByText(/uptime unknown/)).toBeTruthy();
    // Never a fabricated perfect score.
    expect(screen.queryByText(/100(\.0)?% uptime/)).toBeNull();
  });

  it("marks a deranked endpoint so the row does not read as healthy", () => {
    renderPicker({
      endpoints: [
        endpointOption({ tag: "sick", providerName: "Sick", isDeranked: true, statusCode: -2 }),
      ],
    });
    expect(screen.getByText(/deranked by OpenRouter/)).toBeTruthy();
  });

  it("puts the rows in a bounded scroll container so the page itself need not scroll", () => {
    renderPicker();
    const list = document.querySelector<HTMLElement>(
      "[data-vex-provider-endpoint-list]",
    );
    expect(list).not.toBeNull();
    expect(list!.className).toContain("overflow-y-auto");
    // Bounded to roughly five rows.
    expect(list!.className).toMatch(/max-h-\[[\d.]+rem\]/);
  });

  it("scrolls a selected endpoint into view on mount", () => {
    const scrollIntoView = vi.fn();
    // jsdom does not implement scrollIntoView; the component feature-checks it.
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    renderPicker({ value: "amazon-bedrock/eu-west-1" });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    const target = scrollIntoView.mock.instances[0] as HTMLElement;
    expect(target.dataset.vexProviderEndpoint).toBe("amazon-bedrock/eu-west-1");

    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("does not scroll anything when the selection is Auto", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    renderPicker({ value: null });

    expect(scrollIntoView).not.toHaveBeenCalled();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});

describe("formatEndpointMeta", () => {
  it("omits pricing entirely rather than implying a free endpoint", () => {
    expect(
      formatEndpointMeta(
        endpointOption({
          tag: "unknown",
          providerName: "Unknown",
          contextLength: null,
          quantization: null,
          pricingInputPerMillion: null,
          pricingOutputPerMillion: null,
          pricingCacheReadPerMillion: null,
          pricingCacheWritePerMillion: null,
          pricingReasoningPerMillion: null,
          uptimeLast5mPercent: null,
          uptimeLast30mPercent: null,
          uptimeLast1dPercent: null,
          availabilityScore: null,
        }),
      ),
      // An unmeasured, unpriced endpoint says so rather than rendering blank.
    ).toBe("uptime unknown");
  });
});
