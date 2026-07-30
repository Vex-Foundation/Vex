/**
 * `ConfiguredProviderPanel` — the "Provider is configured" screen.
 *
 * The behaviour that matters:
 *   - three status rows are DISPLAYED (key status, model, routing) and the
 *     key row is a status word only — there is no key material to show;
 *   - "Edit configuration" reveals pickers PREFILLED with the live values;
 *   - saving with a blank replace-key field OMITS `apiKey` from the persist
 *     payload — that is the whole point: no re-typing the key to change a
 *     model;
 *   - typing a replacement key DOES send it, and the input is cleared;
 *   - the "changes apply next start" semantic stays visible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX } from "react";
import type { ProviderPersistInput } from "@shared/schemas/provider.js";

const mockPersistProvider = vi.fn();
const mockInvalidate = vi.fn();
const mockUseProviderModels = vi.fn();
const mockUseProviderEndpoints = vi.fn();
const mockOnContinue = vi.fn();
const mockOnReconfigure = vi.fn();

vi.mock("../../../../../lib/api/provider.js", () => ({
  persistProvider: (input: ProviderPersistInput) => mockPersistProvider(input),
  useInvalidateEnvStateAfterProviderWrite: () => mockInvalidate,
  useProviderModels: (enabled: boolean) => mockUseProviderModels(enabled),
  useProviderEndpoints: (modelId: string | null) =>
    mockUseProviderEndpoints(modelId),
}));

const { ConfiguredProviderPanel } = await import(
  "../ConfiguredProviderPanel.js"
);

const ACTIVE_MODEL = "anthropic/claude-sonnet-4.5";

const CATALOGUE_MODEL = {
  modelId: ACTIVE_MODEL,
  displayName: "Claude Sonnet 4.5",
  providerId: "anthropic",
  contextLength: 200_000,
  pricingInputPerMillion: 3,
  pricingOutputPerMillion: 15,
};

const ENDPOINT = {
  tag: "anthropic/2",
  providerName: "Anthropic (second pool)",
  contextLength: 200_000,
  quantization: null,
  pricingInputPerMillion: 3,
  pricingOutputPerMillion: 15,
  pricingCacheReadPerMillion: 0.3,
  pricingCacheWritePerMillion: 3.75,
  pricingReasoningPerMillion: null,
  uptimeLast5mPercent: 99.5,
  uptimeLast30mPercent: 99.6,
  uptimeLast1dPercent: 99.7,
  statusCode: 0,
  isDeranked: false,
  availabilityScore: 99.56,
};

function queryResult(data: unknown): Record<string, unknown> {
  return { data, isLoading: false, isError: false, refetch: vi.fn() };
}

function renderPanel(
  overrides: Partial<
    Parameters<typeof ConfiguredProviderPanel>[0]
  > = {},
): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = (): JSX.Element => (
    <QueryClientProvider client={client}>
      <ConfiguredProviderPanel
        providerName="openrouter"
        activeModel={ACTIVE_MODEL}
        activeEndpointTag={null}
        flowMode="back-edit"
        onContinue={mockOnContinue}
        onReconfigure={mockOnReconfigure}
        continuePending={false}
        advanceError={null}
        {...overrides}
      />
    </QueryClientProvider>
  );
  return render(<Wrapper />);
}

beforeEach(() => {
  mockPersistProvider.mockReset();
  mockInvalidate.mockReset();
  mockUseProviderModels.mockReset();
  mockUseProviderEndpoints.mockReset();
  mockOnContinue.mockReset();
  mockOnReconfigure.mockReset();
  mockUseProviderModels.mockReturnValue(
    queryResult({ ok: true, data: { models: [CATALOGUE_MODEL] } }),
  );
  mockUseProviderEndpoints.mockReturnValue(
    queryResult({
      ok: true,
      data: {
        modelId: ACTIVE_MODEL,
        endpoints: [ENDPOINT],
        suggestedEndpointTag: ENDPOINT.tag,
      },
    }),
  );
  mockPersistProvider.mockResolvedValue({
    ok: true,
    data: {
      fieldsWritten: ["AGENT_MODEL", "AGENT_PROVIDER"],
      verifiedLatencyMs: 42,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("status view", () => {
  it("shows key status, model and Auto routing without any key material", () => {
    const { container, getByText } = renderPanel();

    expect(
      container.querySelector('[data-vex-provider-status="apiKey"]'),
    ).not.toBeNull();
    expect(getByText("Configured")).toBeTruthy();
    expect(getByText(ACTIVE_MODEL)).toBeTruthy();
    expect(getByText("Auto (recommended)")).toBeTruthy();
    // Status only — no password input is rendered before Edit.
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("keeps the 'changes apply next start' semantic visible", () => {
    const { getByText } = renderPanel();
    expect(
      getByText(/Changes apply the next time the agent starts/i),
    ).toBeTruthy();
  });

  it("resolves a pinned endpoint to its display name", () => {
    const { getByText } = renderPanel({ activeEndpointTag: "anthropic/2" });
    expect(getByText("Anthropic (second pool)")).toBeTruthy();
  });

  it("falls back to the raw tag when the endpoint catalogue is unavailable", () => {
    mockUseProviderEndpoints.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    const { getByText } = renderPanel({ activeEndpointTag: "some/tag" });
    expect(getByText("some/tag")).toBeTruthy();
  });

  it("does not fetch the model catalogue until the operator edits", () => {
    renderPanel();
    expect(mockUseProviderModels).toHaveBeenCalledWith(false);
  });
});

describe("edit + delta save", () => {
  function openEditor(): ReturnType<typeof render> {
    const view = renderPanel();
    fireEvent.click(view.getByText("Edit configuration"));
    return view;
  }

  it("prefills the model picker with the active model", () => {
    const { container } = openEditor();
    const input = container.querySelector<HTMLInputElement>(
      "#vex-provider-edit-model",
    );
    expect(input?.value).toBe(ACTIVE_MODEL);
    expect(mockUseProviderModels).toHaveBeenCalledWith(true);
  });

  it("prefills the endpoint pin with the active one", () => {
    const view = renderPanel({ activeEndpointTag: "anthropic/2" });
    fireEvent.click(view.getByText("Edit configuration"));
    const pinned = view.container.querySelector(
      '[data-vex-provider-endpoint="anthropic/2"]',
    );
    expect(pinned?.getAttribute("aria-checked")).toBe("true");
  });

  it("offers an OPTIONAL replace-key field that says blank keeps the key", () => {
    const { container, getByText } = openEditor();
    expect(
      container.querySelector("#vex-provider-replace-key"),
    ).not.toBeNull();
    expect(getByText(/Leave blank to keep the current key/i)).toBeTruthy();
  });

  it("OMITS apiKey from the payload when the replace field is blank", async () => {
    const { container, getByText } = openEditor();

    fireEvent.click(getByText("Save changes"));

    await waitFor(() => {
      expect(mockPersistProvider).toHaveBeenCalledTimes(1);
    });
    const payload = mockPersistProvider.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("apiKey");
    expect(payload).toEqual({
      provider: "openrouter",
      model: ACTIVE_MODEL,
    });
    expect(container).toBeTruthy();
  });

  it("sends a changed model with the key still omitted", async () => {
    const { container, getByText } = openEditor();
    const input = container.querySelector<HTMLInputElement>(
      "#vex-provider-edit-model",
    )!;
    fireEvent.change(input, { target: { value: "openai/gpt-5.2" } });
    fireEvent.click(getByText("Save changes"));

    await waitFor(() => {
      expect(mockPersistProvider).toHaveBeenCalledWith({
        provider: "openrouter",
        model: "openai/gpt-5.2",
      });
    });
  });

  it("sends a pinned endpoint on a delta save", async () => {
    const view = renderPanel({ activeEndpointTag: "anthropic/2" });
    fireEvent.click(view.getByText("Edit configuration"));
    fireEvent.click(view.getByText("Save changes"));

    await waitFor(() => {
      expect(mockPersistProvider).toHaveBeenCalledWith({
        provider: "openrouter",
        model: ACTIVE_MODEL,
        endpointTag: "anthropic/2",
      });
    });
  });

  it("INCLUDES apiKey when a replacement is typed, and clears the input", async () => {
    const { container, getByText } = openEditor();
    const keyInput = container.querySelector<HTMLInputElement>(
      "#vex-provider-replace-key",
    )!;
    fireEvent.change(keyInput, { target: { value: "  sk-or-new-key  " } });

    fireEvent.click(getByText("Save changes"));

    await waitFor(() => {
      expect(mockPersistProvider).toHaveBeenCalledWith({
        provider: "openrouter",
        model: ACTIVE_MODEL,
        apiKey: "sk-or-new-key",
      });
    });
    expect(keyInput.value).toBe("");
  });

  it("returns to the status view and reports verification on success", async () => {
    const { container, getByText } = openEditor();
    fireEvent.click(getByText("Save changes"));

    await waitFor(() => {
      expect(
        container.querySelector('[data-vex-provider-success="true"]'),
      ).not.toBeNull();
    });
    expect(mockInvalidate).toHaveBeenCalled();
    expect(
      container.querySelector('[data-vex-provider-status="apiKey"]'),
    ).not.toBeNull();
  });

  it("renders fixed copy for a rejected delta save and stays in the editor", async () => {
    mockPersistProvider.mockResolvedValue({
      ok: false,
      error: {
        code: "provider.api_key_required",
        correlationId: "corr-1",
        details: {},
      },
    });
    const { container, getByText } = openEditor();
    fireEvent.click(getByText("Save changes"));

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-vex-provider-error="provider.api_key_required"]',
        ),
      ).not.toBeNull();
    });
    expect(getByText("API key needed")).toBeTruthy();
    expect(
      container.querySelector("#vex-provider-replace-key"),
    ).not.toBeNull();
  });

  it("Cancel restores the status view without persisting", () => {
    const { container, getByText } = openEditor();
    fireEvent.click(getByText("Cancel"));

    expect(mockPersistProvider).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-vex-provider-status="model"]'),
    ).not.toBeNull();
  });
});

describe("navigation actions", () => {
  it("Continue and Reconfigure delegate to the hosting step", () => {
    const { getByText } = renderPanel({ flowMode: "first-pass" });

    fireEvent.click(getByText("Continue"));
    expect(mockOnContinue).toHaveBeenCalledTimes(1);

    fireEvent.click(getByText("Reconfigure"));
    expect(mockOnReconfigure).toHaveBeenCalledTimes(1);
  });
});
