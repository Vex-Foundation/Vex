import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err as errResult, ok as okResult, type Result } from "@shared/ipc/result.js";
import type { UserMcpListDto, UserMcpToolDto } from "@shared/schemas/user-mcp.js";
import { UserMcpSection, USER_MCP_INTRO } from "../UserMcpSection.js";
import { requireValue } from "../../../../../../../../src/__tests__/helpers/require-value.js";

const SERVER = "11111111-2222-4333-8444-555555555555";

function tool(over: Partial<UserMcpToolDto>): UserMcpToolDto {
  return {
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    modelName: "mcp_t3f2504e04f8941d3",
    remoteName: "lookup",
    description: "Look a word up",
    readOnlyHint: true,
    enabled: false,
    autoRun: false,
    status: "active",
    unsupportedReason: null,
    schemaJson: '{\n  "type": "object"\n}',
    ...over,
  };
}

function list(tools: UserMcpToolDto[], status: "active" | "error" = "active"): UserMcpListDto {
  return {
    servers: [
      {
        id: SERVER,
        name: "Docs",
        endpoint: "https://mcp.example.com/mcp",
        networkScope: "public",
        hasToken: true,
        status,
        lastCheckedAt: "2026-10-24T00:00:00.000Z",
        lastError: status === "error" ? "unreachable" : null,
        tools,
      },
    ],
    enabledCount: tools.filter((t) => t.enabled).length,
    maxEnabled: 8,
    maxServers: 5,
  };
}

const ok = (data: UserMcpListDto): Result<UserMcpListDto> => okResult(data);
const refused = (message: string): Result<UserMcpListDto> =>
  errResult({
    code: "validation.invalid_input",
    domain: "settings",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId: "test",
    message,
  });

const settings = {
  listUserMcp: vi.fn(),
  addUserMcpServer: vi.fn(),
  removeUserMcpServer: vi.fn(),
  setUserMcpToken: vi.fn(),
  setUserMcpToolEnabled: vi.fn(),
  setUserMcpToolAutoRun: vi.fn(),
  recheckUserMcpServer: vi.fn(),
};

function renderSection(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UserMcpSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(settings)) fn.mockReset();
  Object.assign(window, { vex: { settings } });
});
afterEach(() => cleanup());

describe("UserMcpSection", () => {
  it("shows the intro, the server with its state word, and a tool off", async () => {
    settings.listUserMcp.mockResolvedValue(ok(list([tool({ remoteName: "write_note", readOnlyHint: false }), tool({})])));
    renderSection();
    expect(await screen.findByText("Docs")).not.toBeNull();
    expect(screen.getByText(USER_MCP_INTRO)).not.toBeNull();
    expect(screen.getByText("Connected")).not.toBeNull();
    expect(screen.getByText(/0 of 8 tools in use/)).not.toBeNull();
    // Run without asking is offered only for the tool the server declared read-only.
    expect(document.querySelector('[data-vex-user-mcp-autorun="lookup"]')).not.toBeNull();
    expect(document.querySelector('[data-vex-user-mcp-autorun="write_note"]')).toBeNull();
    expect((document.querySelector('[data-vex-user-mcp-autorun="lookup"]') as HTMLInputElement).disabled).toBe(true);
  });

  it("turns a tool on with the answer main gives, and shows a refusal in the row", async () => {
    settings.listUserMcp.mockResolvedValue(ok(list([tool({})])));
    settings.setUserMcpToolEnabled.mockResolvedValueOnce(ok(list([tool({ enabled: true })])));
    renderSection();
    await screen.findByText("Docs");
    fireEvent.click(requireValue(document.querySelector('[data-vex-user-mcp-enable="lookup"]')));
    await waitFor(() => expect(settings.setUserMcpToolEnabled).toHaveBeenCalledWith({ toolId: tool({}).id, enabled: true }));
    await waitFor(() => expect(screen.getByText(/1 of 8 tools in use/)).not.toBeNull());

    settings.setUserMcpToolAutoRun.mockResolvedValueOnce(refused("NOT_READ_ONLY: Only a tool its server declares read-only can run without asking."));
    fireEvent.click(requireValue(document.querySelector('[data-vex-user-mcp-autorun="lookup"]')));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Only a tool its server declares read-only can run without asking.");
  });

  it("marks a changed tool and an unsupported one, and offers Review again", async () => {
    settings.listUserMcp.mockResolvedValue(
      ok(
        list([
          tool({ status: "drifted" }),
          tool({ id: "4f2504e0-4f89-41d3-9a0c-0305e82c3302", remoteName: "weird", status: "unsupported", unsupportedReason: 'input: "oneOf" is not supported' }),
        ]),
      ),
    );
    settings.recheckUserMcpServer.mockResolvedValueOnce(ok(list([tool({})])));
    renderSection();
    expect(await screen.findByText("Changed by the server")).not.toBeNull();
    expect(screen.getByText(/Not supported: input: "oneOf" is not supported/)).not.toBeNull();
    expect((document.querySelector('[data-vex-user-mcp-enable="weird"]') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Review again" }));
    await waitFor(() =>
      expect(settings.recheckUserMcpServer).toHaveBeenCalledWith({ serverId: SERVER, reviewToolId: tool({}).id }),
    );
  });

  it("adds a server with a token and clears the form, keeping the token out of the page", async () => {
    settings.listUserMcp.mockResolvedValue(ok({ servers: [], enabledCount: 0, maxEnabled: 8, maxServers: 5 }));
    settings.addUserMcpServer.mockResolvedValueOnce(ok(list([tool({})])));
    renderSection();
    await screen.findByText(/0 of 8 tools in use/);
    const form = document.querySelector("[data-vex-user-mcp-add]") as HTMLFormElement;
    const inputs = form.querySelectorAll("input");
    fireEvent.change(requireValue(inputs[0]), { target: { value: "Docs" } });
    fireEvent.change(requireValue(inputs[1]), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.change(requireValue(inputs[2]), { target: { value: "s3cret" } });
    expect(requireValue(inputs[2]).getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    await waitFor(() =>
      expect(settings.addUserMcpServer).toHaveBeenCalledWith({ name: "Docs", endpoint: "https://mcp.example.com/mcp", token: "s3cret" }),
    );
    await waitFor(() => expect((inputs[2] as HTMLInputElement).value).toBe(""));
    expect(document.body.textContent).not.toContain("s3cret");
  });

  it("asks before removing a server", async () => {
    settings.listUserMcp.mockResolvedValue(ok(list([tool({})], "error")));
    settings.removeUserMcpServer.mockResolvedValueOnce(ok({ servers: [], enabledCount: 0, maxEnabled: 8, maxServers: 5 }));
    renderSection();
    expect(await screen.findByText("Not answering")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(settings.removeUserMcpServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Docs" }));
    await waitFor(() => expect(settings.removeUserMcpServer).toHaveBeenCalledWith({ serverId: SERVER }));
  });
});
