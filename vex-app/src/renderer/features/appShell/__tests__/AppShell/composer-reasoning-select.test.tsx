/**
 * Composer reasoning-effort selector (S6/D4+D5, E2 source swap) — the quiet
 * Grok-slot control in the pill's right cluster, replacing the retired
 * REASON cycle chip. Real SessionComposer, lib/api hooks mocked (same
 * isolated harness as composer-console). Pins the full W2 contract:
 *   - capability source is the GLOBAL `useAvailableModels` query (E2), not a
 *     per-session query — welcome and an in-session composer share ONE
 *     mocked source here, matching production;
 *   - mount gate: `ModelOptionDto.reasoning !== null` AND an agent-stage
 *     session (mission sessions NEVER see it);
 *   - options = the normalized `supportedEfforts` VERBATIM (DTO order),
 *     "none" labelled "Off"; a mandatory set (no "none") shows no Off;
 *   - preselect = the shared tested `selectDefaultReasoningEffort` (never
 *     re-derived in the component);
 *   - D5 submit: capability non-null → the turn ALWAYS carries the
 *     effective selection (untouched → the computed default; explicit Off
 *     → "none" verbatim); capability null → the field is OMITTED entirely,
 *     even over a stale store value;
 *   - Retry resends the exact effort that rode the failed submit, even if
 *     the selector moved since.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import type { ModelsListAvailableResult } from "@shared/schemas/models.js";
import type { ReasoningCapability } from "@shared/schemas/reasoning.js";
import type { Result } from "@shared/ipc/result.js";
import { useUiStore } from "../../../../stores/uiStore.js";

vi.mock("@hugeicons/react", () => ({
  HugeiconsIcon: () => null,
}));

vi.mock("@hugeicons/core-free-icons", () => ({
  Add01Icon: "Add01Icon",
  CheckmarkCircle02Icon: "CheckmarkCircle02Icon",
  Download01Icon: "Download01Icon",
  ArrowDown01Icon: "ArrowDown01Icon",
  PercentSquareIcon: "PercentSquareIcon",
  FireIcon: "FireIcon",
  ChartLineData01Icon: "ChartLineData01Icon",
  AiBrain05Icon: "AiBrain05Icon",
  ArrowRight01Icon: "ArrowRight01Icon",
  ArrowUp01Icon: "ArrowUp01Icon",
  // Welcome Portfolio tab (BookPanel's welcome stage): handle + card icons.
  Wallet01Icon: "Wallet01Icon",
  MapPinIcon: "MapPinIcon",
  StopCircleIcon: "StopCircleIcon",
}));

// Brand-icon lib mocked per sibling suites — keeps this suite immune to
// transitive TokenIcon/ModelBrandIcon imports reaching "@thesvg/react".
vi.mock("@thesvg/react", () => ({
  Docker: () => null,
  Ethereum: () => null,
  Solana: () => null,
  Base: () => null,
  Robinhood: () => null,
  Polygon: () => null,
  Optimism: () => null,
  BnbChain: () => null,
  Tether: () => null,
  Circle: () => null,
  Chainlink: () => null,
  Postgresql: () => null,
  Bitcoin: () => null,
  Bnb: () => null,
  DaiStablecoin: () => null,
  Usdc: () => null,
  Anthropic: () => null,
  Claude: () => null,
  Cohere: () => null,
  Deepseek: () => null,
  Fireworks: () => null,
  Gemini: () => null,
  Google: () => null,
  Grok: () => null,
  Groq: () => null,
  HuggingFace: () => null,
  Meta: () => null,
  Mistral: () => null,
  Ollama: () => null,
  Openai: () => null,
  Openrouter: () => null,
  Perplexity: () => null,
  Qwen: () => null,
  Replicate: () => null,
  TogetherAi: () => null,
  Xai: () => null,
}));

const mockSubmitChat = {
  isPending: false,
  mutateAsync: vi.fn(),
  stop: vi.fn(),
};
vi.mock("../../../../lib/api/chat.js", () => ({
  useSubmitChat: () => mockSubmitChat,
}));
vi.mock("../../../../lib/api/messages.js", () => ({
  useTranscriptInfinite: () => ({ data: undefined, isSuccess: false }),
  flattenTranscriptPages: () => [],
}));
vi.mock("../../../../lib/api/runtime.js", () => ({
  useRuntimeState: () => ({ data: { ok: true, data: { status: null } } }),
  useRequestStop: () => ({ mutateAsync: async () => undefined }),
}));

const mockUseAvailableModels = vi.fn();
vi.mock("../../../../lib/api/models.js", () => ({
  useAvailableModels: (...a: unknown[]) => mockUseAvailableModels(...a),
}));

const { SessionComposer } = await import("../../SessionComposer.js");

const SESSION = "00000000-0000-4000-8000-00000000cc01";

function agentRow(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: SESSION,
    mode: "agent",
    permission: "restricted",
    title: "Reasoning selector",
    initialGoal: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
    ...over,
  };
}

/** Normalized capability fixture — mirrors `normalizeReasoningCapability`
 * output shapes (final set already includes/excludes "none"). */
function capability(over: Partial<ReasoningCapability> = {}): ReasoningCapability {
  return {
    supportedEfforts: ["low", "medium", "high", "none"],
    defaultEffort: null,
    defaultEnabled: null,
    mandatory: false,
    ...over,
  };
}

function modelsState(
  reasoning: ReasoningCapability | null,
): { data: Result<ModelsListAvailableResult> } {
  const result: ModelsListAvailableResult = {
    source: "global_default",
    fetchedAt: null,
    models: [
      {
        providerId: "openrouter",
        modelId: "anthropic/claude-sonnet-4",
        displayName: "anthropic/claude-sonnet-4",
        brand: "openrouter",
        contextLength: null,
        pricingInputPerMillion: null,
        pricingOutputPerMillion: null,
        reasoning,
      },
    ],
  };
  return { data: { ok: true, data: result } };
}

function selector(): HTMLElement | null {
  return screen.queryByRole("combobox", { name: "Reasoning effort" });
}

function openSelector(): HTMLElement {
  const trigger = screen.getByRole("combobox", { name: "Reasoning effort" });
  fireEvent.click(trigger);
  return trigger;
}

function pick(optionLabel: string): void {
  openSelector();
  fireEvent.click(screen.getByRole("option", { name: optionLabel }));
}

async function submitText(text: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("Session draft"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(mockSubmitChat.mutateAsync).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSubmitChat.isPending = false;
  mockSubmitChat.mutateAsync.mockResolvedValue({
    ok: true,
    data: {
      text: "ok",
      toolCallsMade: 0,
      pendingApprovals: [],
      stopReason: null,
      missionStatus: null,
      treatedAsInitialGoal: false,
    },
  });
  mockUseAvailableModels.mockReturnValue(modelsState(capability()));
  useUiStore.setState({
    createSessionInitialTurn: null,
    reasoningEffortBySession: {},
  });
});

describe("SessionComposer reasoning selector — mount gate", () => {
  it("mounts for an agent session whose model reports a capability", () => {
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    // Preselect (no upstream default, "medium" in set) → Medium.
    expect(selector()?.textContent).toContain("Medium");
  });

  it("stays hidden for a MISSION session even when the model has a capability, and the submit omits the field", async () => {
    render(
      <SessionComposer
        activeSession={agentRow({ mode: "mission" })}
        activeSessionId={SESSION}
      />,
    );
    expect(selector()).toBeNull();
    // Mission ingress ignores per-turn options (plan D4 v1 scope) — the
    // composer must not ride a choice the engine would silently drop.
    await submitText("mission goal");
    const input = mockSubmitChat.mutateAsync.mock.calls[0]![0] as object;
    expect("reasoningEffort" in input).toBe(false);
  });

  it("stays hidden when reasoning is null, and while the query is unresolved a quiet placeholder fills the slot instead", () => {
    // Resolved, but the model has no reasoning capability.
    mockUseAvailableModels.mockReturnValue(modelsState(null));
    const first = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    expect(selector()).toBeNull();
    first.unmount();

    // Unresolved query (loading/error) — no data at all. The real selector
    // still never mounts, but the INERT placeholder does (E3 welcome
    // pending slot — applies to any agent-stage composer, not only welcome).
    mockUseAvailableModels.mockReturnValue({ data: undefined });
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    expect(selector()).toBeNull();
    expect(
      container.querySelector("[data-vex-reasoning-placeholder]"),
    ).not.toBeNull();
  });

  it("welcome stage counts as agent: shows the selector with the DEFAULT selection when capability data exists", () => {
    // E2: welcome sources capability from the SAME global query as an
    // in-session composer (already mocked resolved in beforeEach) — the
    // gate itself treats no-session as agent-stage.
    render(<SessionComposer activeSession={null} activeSessionId={null} />);
    expect(selector()?.textContent).toContain("Medium");
  });

  it("stays hidden for a selected but UNRESOLVED session even when the model capability has already resolved (blocker 2)", () => {
    // `SessionPanel` represents a loading/errored session detail as
    // `activeSession = null` while `activeSessionId` stays set. The model
    // capability query is keyed on `sessionId` alone, so it can resolve
    // BEFORE the session detail does — for an existing MISSION session,
    // that used to flash the selector on (and forward a value main/ingress
    // silently drops) until the detail query caught up. A selected-but-
    // unresolved session must never be treated as agent-stage.
    render(<SessionComposer activeSession={null} activeSessionId={SESSION} />);
    expect(selector()).toBeNull();
  });
});

describe("SessionComposer reasoning selector — options", () => {
  it("lists supportedEfforts VERBATIM in DTO order with none labelled Off", () => {
    mockUseAvailableModels.mockReturnValue(
      modelsState(
        capability({ supportedEfforts: ["high", "medium", "low", "none"] }),
      ),
    );
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    openSelector();
    expect(
      screen.getAllByRole("option").map((o) => o.textContent),
    ).toEqual(["High", "Medium", "Low", "Off"]);
  });

  it("shows no Off for a mandatory capability (final set has no none)", () => {
    mockUseAvailableModels.mockReturnValue(
      modelsState(
        capability({ supportedEfforts: ["max", "high"], mandatory: true }),
      ),
    );
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    openSelector();
    expect(
      screen.getAllByRole("option").map((o) => o.textContent),
    ).toEqual(["Max", "High"]);
    expect(screen.queryByRole("option", { name: "Off" })).toBeNull();
  });
});

describe("SessionComposer reasoning selector — preselect (selectDefaultReasoningEffort)", () => {
  it("preselects the upstream defaultEffort when it is in the final set", () => {
    mockUseAvailableModels.mockReturnValue(
      modelsState(capability({ defaultEffort: "high" })),
    );
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    expect(selector()?.textContent).toContain("High");
  });

  it("preselects Off when defaultEnabled is false on a non-mandatory model", () => {
    mockUseAvailableModels.mockReturnValue(
      modelsState(capability({ defaultEnabled: false })),
    );
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    expect(selector()?.textContent).toContain("Off");
  });

  it("preselects the only positive effort for a mandatory single-level model", () => {
    mockUseAvailableModels.mockReturnValue(
      modelsState(
        capability({ supportedEfforts: ["high"], mandatory: true }),
      ),
    );
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    expect(selector()?.textContent).toContain("High");
  });
});

describe("SessionComposer reasoning selector — D5 submit contract", () => {
  it("a pick updates the per-session store and rides the next submit", async () => {
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    pick("Low");
    expect(useUiStore.getState().reasoningEffortBySession[SESSION]).toBe("low");
    expect(selector()?.textContent).toContain("Low");
    await submitText("Deep dive on the TAO thesis");
    expect(mockSubmitChat.mutateAsync).toHaveBeenCalledWith({
      sessionId: SESSION,
      message: "Deep dive on the TAO thesis",
      reasoningEffort: "low",
    });
  });

  it("an UNTOUCHED selector still carries the computed dynamic default", async () => {
    mockUseAvailableModels.mockReturnValue(
      modelsState(capability({ defaultEffort: "high" })),
    );
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    await submitText("untouched default");
    expect(mockSubmitChat.mutateAsync).toHaveBeenCalledWith({
      sessionId: SESSION,
      message: "untouched default",
      reasoningEffort: "high",
    });
  });

  it("an explicit Off pick submits none verbatim", async () => {
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    pick("Off");
    await submitText("no reasoning please");
    expect(mockSubmitChat.mutateAsync).toHaveBeenCalledWith({
      sessionId: SESSION,
      message: "no reasoning please",
      reasoningEffort: "none",
    });
  });

  it("a stored pick no longer in the model's final set falls back to the preselect", async () => {
    mockUseAvailableModels.mockReturnValue(
      modelsState(
        capability({ supportedEfforts: ["high", "none"], defaultEffort: "high" }),
      ),
    );
    // Stale pick from a previous model whose set included "low".
    useUiStore.setState({ reasoningEffortBySession: { [SESSION]: "low" } });
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    expect(selector()?.textContent).toContain("High");
    await submitText("validated at read");
    expect(mockSubmitChat.mutateAsync).toHaveBeenCalledWith({
      sessionId: SESSION,
      message: "validated at read",
      reasoningEffort: "high",
    });
  });

  it("OMITS reasoningEffort entirely when reasoning is null — even over a stale store value", async () => {
    mockUseAvailableModels.mockReturnValue(modelsState(null));
    useUiStore.setState({ reasoningEffortBySession: { [SESSION]: "high" } });
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    await submitText("hello");
    expect(mockSubmitChat.mutateAsync).toHaveBeenCalledWith({
      sessionId: SESSION,
      message: "hello",
    });
    const input = mockSubmitChat.mutateAsync.mock.calls[0]![0] as object;
    expect("reasoningEffort" in input).toBe(false);
  });
});

describe("SessionComposer reasoning selector — retry preserves the ridden effort", () => {
  it("Retry resends the exact value that rode the failed submit, even after the selector changes", async () => {
    mockSubmitChat.mutateAsync.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "provider.unavailable",
        domain: "chat",
        message: "No inference provider is available.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "c",
      },
    });
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);

    // First submit rides the untouched default ("medium").
    await submitText("do the thing");
    expect(mockSubmitChat.mutateAsync).toHaveBeenCalledWith({
      sessionId: SESSION,
      message: "do the thing",
      reasoningEffort: "medium",
    });
    const retry = await screen.findByRole("button", {
      name: "Retry sending the message",
    });

    // Move the selector to High AFTER the failure — the retry must ignore it.
    pick("High");
    expect(selector()?.textContent).toContain("High");

    fireEvent.click(retry);
    await waitFor(() =>
      expect(mockSubmitChat.mutateAsync).toHaveBeenCalledTimes(2),
    );
    expect(mockSubmitChat.mutateAsync).toHaveBeenLastCalledWith({
      sessionId: SESSION,
      message: "do the thing",
      reasoningEffort: "medium",
    });
  });
});

describe("SessionComposer reasoning selector — a11y (SelectMenu contract)", () => {
  it("is a combobox that toggles aria-expanded and lists options with aria-selected", () => {
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    const trigger = screen.getByRole("combobox", { name: "Reasoning effort" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("listbox", { name: "Reasoning effort" }),
    ).toBeTruthy();
    // Effective selection ("Medium") is the aria-selected option.
    expect(
      screen
        .getByRole("option", { name: "Medium" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("option", { name: "Off" }).getAttribute("aria-selected"),
    ).toBe("false");
  });
});
