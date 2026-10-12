/**
 * The gutter's spread caption (docs/design/V10-SPREAD.md section 5): three
 * groups that only ever REPEAT what the running head, the session and the
 * profile foot already say, in an `aria-hidden` drag column that folds away
 * under the spread.
 */

import { render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TapeState } from "../DeskRuleTapeState.js";

const tapeMock = vi.fn<(sessionId: string | null) => TapeState | null>();
vi.mock("../DeskRuleTapeState.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../DeskRuleTapeState.js")>()),
  useTapeState: (sessionId: string | null) => tapeMock(sessionId),
}));

const sessionMock = vi.fn();
vi.mock("../../../lib/api/sessions.js", () => ({
  useSession: (id: string | null) => sessionMock(id),
}));

const projectMock = vi.fn();
vi.mock("../../../lib/api/projects.js", () => ({
  useProject: (id: string | null) => projectMock(id),
}));

const healthMock = vi.fn();
vi.mock("../../../lib/api/system.js", () => ({
  useSystemHealth: () => healthMock(),
}));

vi.mock("../SidebarProfile.js", () => ({
  getRuntimeStatus: ({ loading, result }: { loading: boolean; result: unknown }) => ({
    label: loading || result === undefined ? "Connecting" : "Connected",
  }),
}));

const { ShellGutter, SpreadCaptionFold, useSpreadCaption } = await import("../ShellGutter.js");

const SESSION = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  tapeMock.mockReset();
  tapeMock.mockReturnValue(null);
  sessionMock.mockReset();
  sessionMock.mockReturnValue({ data: undefined });
  projectMock.mockReset();
  projectMock.mockReturnValue({ data: undefined });
  healthMock.mockReset();
  healthMock.mockReturnValue({ isLoading: false, data: { ok: true, data: { overall: "ok" } } });
});

function caption(
  runtimeMode: "agent" | "studio" | "lighter",
  activeSessionId: string | null,
  activeProjectId: string | null = null,
) {
  return renderHook(() =>
    useSpreadCaption({ runtimeMode, activeSessionId, activeProjectId }),
  ).result.current;
}

describe("useSpreadCaption", () => {
  it("on the welcome stage reads the mode, the date and the connection", () => {
    const result = caption("agent", null);
    expect(result.context).toBe("Agent");
    expect(result.state).toMatch(/^[A-Z][a-z]+day · [A-Z][a-z]{2} \d{1,2}$/);
    expect(result.fill).toBeNull();
    expect(result.connection).toBe("Connected");
    expect(tapeMock).toHaveBeenCalledWith(null);
  });

  it("in a session repeats the permission seat and the running head's tape word", () => {
    tapeMock.mockReturnValue("live");
    sessionMock.mockReturnValue({ data: { ok: true, data: { permission: "restricted" } } });
    const result = caption("agent", SESSION);
    expect(result).toEqual({
      context: "Agent · Restricted",
      state: "Live",
      fill: "done",
      connection: "Connected",
    });
    expect(tapeMock).toHaveBeenCalledWith(SESSION);
  });

  it.each([
    ["idle", "Idle", "idle"],
    ["sleeping", "Sleeping", "idle"],
    ["live", "Live", "done"],
    ["running", "Running", "ongoing"],
    ["awaiting", "Awaiting", "warning"],
    ["paused", "Paused", "draft"],
  ] as const)("draws %s as the word %s on the %s fill", (state, word, fill) => {
    tapeMock.mockReturnValue(state);
    const result = caption("agent", SESSION);
    expect(result.state).toBe(word);
    expect(result.fill).toBe(fill);
  });

  it("names full access the way the composer seat does", () => {
    sessionMock.mockReturnValue({ data: { ok: true, data: { permission: "full" } } });
    expect(caption("agent", SESSION).context).toBe("Agent · Full access");
  });

  it("in Studio reads the open project and never the agent session", () => {
    projectMock.mockReturnValue({
      data: { ok: true, data: { name: "vex-core", permission: "full" } },
    });
    const result = caption("studio", SESSION, "p-1");
    expect(result.context).toBe("vex-core");
    expect(result.state).toBe("Full access");
    expect(result.fill).toBeNull();
    expect(tapeMock).toHaveBeenCalledWith(null);
    expect(sessionMock).toHaveBeenCalledWith(null);
    expect(projectMock).toHaveBeenCalledWith("p-1");
  });

  it("says Studio with no project open", () => {
    expect(caption("studio", null).context).toBe("Studio");
  });

  it("says Connecting while the health read has not answered", () => {
    healthMock.mockReturnValue({ isLoading: true, data: undefined });
    expect(caption("agent", null).connection).toBe("Connecting");
  });
});

describe("ShellGutter", () => {
  const SOURCE = { runtimeMode: "agent", activeSessionId: SESSION, activeProjectId: null } as const;

  beforeEach(() => {
    tapeMock.mockReturnValue("live");
    sessionMock.mockReturnValue({ data: { ok: true, data: { permission: "restricted" } } });
  });

  it("is an aria-hidden drag column with the three groups in order", () => {
    const view = render(<ShellGutter {...SOURCE} width={36} />);
    const gutter = view.container.querySelector<HTMLElement>("[data-vex-area='shell-gutter']");
    expect(gutter?.getAttribute("aria-hidden")).toBe("true");
    expect(gutter?.classList.contains("vex-drag")).toBe(true);
    expect(gutter?.getAttribute("data-vex-gutter")).toBe("full");
    const groups = Array.from(gutter?.children ?? []).map((g) => g.getAttribute("data-caption"));
    expect(groups).toEqual(["Agent · Restricted", "Live", "Connected"]);
    // Painted, not written: the page's text holds each word once.
    expect(gutter?.textContent).toBe("");
    expect(gutter?.querySelector(".vex-gutter__swatch")?.getAttribute("data-s")).toBe("done");
  });

  it("draws no swatch beside a date", () => {
    tapeMock.mockReturnValue(null);
    const view = render(<ShellGutter {...SOURCE} activeSessionId={null} width={36} />);
    expect(view.container.querySelector(".vex-gutter__swatch")).toBeNull();
  });

  it("sets the small caption in the 22px gutter beside a spine", () => {
    const view = render(<ShellGutter {...SOURCE} width={22} />);
    expect(
      view.container.querySelector("[data-vex-area='shell-gutter']")?.getAttribute("data-vex-gutter"),
    ).toBe("small");
  });

  it("folds to nothing under the spread, and reads nothing while folded", () => {
    tapeMock.mockClear();
    const view = render(<ShellGutter {...SOURCE} width={0} />);
    const gutter = view.container.querySelector("[data-vex-area='shell-gutter']");
    expect(gutter?.getAttribute("data-vex-gutter")).toBe("folded");
    expect(gutter?.children).toHaveLength(0);
    expect(tapeMock).not.toHaveBeenCalled();
  });

  it("folds its context into the running head, painted and hidden like the gutter", () => {
    const view = render(<SpreadCaptionFold {...SOURCE} />);
    const fold = view.container.querySelector("[data-vex-running-head-fold]");
    expect(fold?.getAttribute("data-caption")).toBe("Agent · Restricted");
    expect(fold?.getAttribute("aria-hidden")).toBe("true");
    expect(fold?.textContent).toBe("");
  });
});
