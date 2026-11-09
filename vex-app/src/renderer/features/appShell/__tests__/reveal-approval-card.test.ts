/**
 * Review takes you to the card (row S6b-07, docs/design/H3-DESKTOP.md
 * sections 1.5 and A.3): `revealApprovalCard` brings the waiting approval's
 * card into view and focuses it, preferring the chat's full card over any
 * copy, waiting frame by frame for a card a just-opened chat has not painted
 * yet, and giving up quietly. It never presses a key.
 *
 * The frame clock is injected, so each frame is stepped by hand; jsdom has no
 * `scrollIntoView`, so it is stubbed on the prototype where a case needs it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { findApprovalCard, rejectKeyOf, revealApprovalCard } from "../ApprovalCard/reveal-approval-card.js";
// Loaded with the file, not inside a case: the console's module graph is
// large, and loading it in a test body spends that test's timeout on imports.
import { openNeedsYouItem } from "../../vex/VexSidebar.js";
import { useUiStore } from "../../../stores/uiStore.js";

/** A frame clock stepped by hand. */
function manualFrames(): {
  readonly schedule: (callback: () => void) => number;
  readonly unschedule: (handle: number) => void;
  readonly step: () => void;
  readonly pending: () => number;
} {
  let next = 1;
  const queue = new Map<number, () => void>();
  return {
    schedule: (callback) => {
      const handle = next++;
      queue.set(handle, callback);
      return handle;
    },
    unschedule: (handle) => {
      queue.delete(handle);
    },
    step: () => {
      const due = [...queue.values()];
      queue.clear();
      for (const callback of due) callback();
    },
    pending: () => queue.size,
  };
}

function card(id: string, layout: "card" | "row" = "card"): HTMLElement {
  const node = document.createElement("section");
  node.setAttribute("data-vex-area", "approval-card");
  node.setAttribute("data-vex-approval-layout", layout);
  node.setAttribute("data-approval-id", id);
  node.tabIndex = -1;
  return node;
}

function inChat(node: HTMLElement): HTMLElement {
  const panel = document.createElement("div");
  panel.setAttribute("data-vex-area", "session-panel");
  panel.appendChild(node);
  return panel;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("findApprovalCard", () => {
  it("prefers the chat's full card over a panel copy that comes first in the document", () => {
    const panelCopy = card("appr-1");
    const chatCard = card("appr-1");
    document.body.append(panelCopy, inChat(chatCard));
    expect(findApprovalCard("appr-1")).toBe(chatCard);
  });

  it("prefers any full card over a folded row", () => {
    const row = card("appr-1", "row");
    const full = card("appr-1");
    document.body.append(row, full);
    expect(findApprovalCard("appr-1")).toBe(full);
  });

  it("matches the id as data, so no id can break the lookup", () => {
    const odd = card('appr"]-1');
    document.body.append(card("appr-2"), odd);
    expect(findApprovalCard('appr"]-1')).toBe(odd);
    expect(findApprovalCard("missing")).toBeNull();
  });
});

describe("revealApprovalCard", () => {
  it("scrolls the card to the centre and focuses it without a second scroll", () => {
    const target = card("appr-1");
    document.body.append(inChat(target));
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    const focus = vi.spyOn(target, "focus");
    const frames = manualFrames();
    revealApprovalCard("appr-1", frames);
    // Nothing happens before the first frame: the caller has just changed the chat.
    expect(scroll).not.toHaveBeenCalled();
    frames.step();
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(target);
  });

  it("waits frame by frame for a card the opened chat paints late", () => {
    const frames = manualFrames();
    revealApprovalCard("appr-1", frames);
    frames.step();
    frames.step();
    expect(frames.pending()).toBe(1);
    const late = card("appr-1");
    document.body.append(inChat(late));
    frames.step();
    expect(document.activeElement).toBe(late);
    expect(frames.pending()).toBe(0);
  });

  it("gives up quietly after its frames, focusing nothing", () => {
    const before = document.activeElement;
    const frames = manualFrames();
    revealApprovalCard("never", { ...frames, maxFrames: 3 });
    for (let index = 0; index < 5; index += 1) frames.step();
    expect(frames.pending()).toBe(0);
    expect(document.activeElement).toBe(before);
  });

  it("can be cancelled while it still waits", () => {
    const frames = manualFrames();
    const cancel = revealApprovalCard("appr-1", frames);
    cancel();
    document.body.append(inChat(card("appr-1")));
    frames.step();
    expect(document.activeElement).toBe(document.body);
  });

  it("is what the console's Review calls: it opens the chat, then focuses the card", () => {
    const session = "00000000-0000-4000-8000-00000000ab01";
    const target = card("appr-review");
    document.body.append(inChat(target));
    // Run each frame at once: the helper's default clock is the browser's.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      callback(0);
      return 1;
    });
    openNeedsYouItem({
      key: "approval:appr-review",
      kind: "approval",
      title: "Swap 200 USDC for ETH on Base.",
      metaLead: "Base, real funds · expires",
      metaTime: "14:39 UTC",
      go: "Review",
      where: "Swap chat",
      groupKey: session,
      sessionId: session,
      projectId: null,
      approvalId: "appr-review",
      createdAt: null,
      expiresAt: null,
    });
    expect(useUiStore.getState().activeSessionId).toBe(session);
    expect(document.activeElement).toBe(target);
    vi.unstubAllGlobals();
  });

  it("opens a Studio project's approval on its own card in the Needs you page", () => {
    // With several waiting, the page must open the one Review named, not the
    // first (the page focuses its Reject on `approvalId`).
    useUiStore.setState({ shellRoute: { kind: "none" } });
    openNeedsYouItem({
      key: "approval:appr-studio",
      kind: "approval",
      title: "Send 1.5 ETH.",
      metaLead: "Ethereum, real funds · since",
      metaTime: "14:39 UTC",
      go: "Review",
      where: "vault-tools",
      groupKey: "project:vault-tools",
      sessionId: null,
      projectId: "55555555-5555-4555-8555-555555555555",
      approvalId: "appr-studio",
      createdAt: null,
      expiresAt: null,
    });
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "needsYou",
      origin: null,
      approvalId: "appr-studio",
    });
  });

  it("presses nothing: focus is all it moves", () => {
    const target = card("appr-1");
    const reject = document.createElement("button");
    const click = vi.fn();
    reject.addEventListener("click", click);
    target.appendChild(reject);
    document.body.append(inChat(target));
    const frames = manualFrames();
    revealApprovalCard("appr-1", frames);
    frames.step();
    expect(click).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(target);
  });
});

describe("Review lands on the card's Reject (C3-A-14, Cloud's decisionTarget)", () => {
  /** A card whose band is docked in the chat's dock, the way `ApprovalCard` draws it. */
  function dockedCard(id: string, keys: readonly string[], disabled = false): { card: HTMLElement; dock: HTMLElement } {
    const node = card(id);
    node.setAttribute("data-vex-decision-docked", "");
    node.setAttribute("aria-describedby", `approval-card-${id}-title`);
    const dock = document.createElement("div");
    dock.setAttribute("data-vex-area", "approval-dock");
    const foot = document.createElement("footer");
    foot.setAttribute("data-vex-area", "approval-foot");
    foot.setAttribute("data-docked", "");
    foot.setAttribute("aria-labelledby", `approval-card-${id}-title`);
    for (const name of keys) {
      const key = document.createElement("button");
      key.setAttribute("data-vex-key", name);
      key.disabled = disabled;
      foot.appendChild(key);
    }
    dock.appendChild(foot);
    return { card: node, dock };
  }

  it("focuses the docked Reject, never the approve key", () => {
    const other = dockedCard("appr-other", ["reject", "approve"]);
    const { card: target, dock } = dockedCard("appr-1", ["reject", "approve"]);
    const panel = inChat(target);
    panel.append(other.dock, dock);
    document.body.append(panel);
    const frames = manualFrames();
    revealApprovalCard("appr-1", frames);
    frames.step();
    const reject = dock.querySelector('[data-vex-key="reject"]');
    expect(document.activeElement).toBe(reject);
    expect(document.activeElement?.getAttribute("data-vex-key")).not.toBe("approve");
  });

  it("focuses Reject and send while a reason is typed: it is the reject key", () => {
    const { card: target, dock } = dockedCard("appr-1", ["clear", "send"]);
    document.body.append(inChat(target), dock);
    expect(rejectKeyOf(target)).toBe(dock.querySelector('[data-vex-key="send"]'));
  });

  it("focuses the Reject in the card's own footer when nothing is docked", () => {
    const target = card("appr-1");
    const foot = document.createElement("footer");
    foot.setAttribute("data-vex-area", "approval-foot");
    for (const name of ["reject", "approve"]) {
      const key = document.createElement("button");
      key.setAttribute("data-vex-key", name);
      foot.appendChild(key);
    }
    target.appendChild(foot);
    document.body.append(target);
    const frames = manualFrames();
    revealApprovalCard("appr-1", frames);
    frames.step();
    expect(document.activeElement?.getAttribute("data-vex-key")).toBe("reject");
  });

  it("focuses the card itself while its keys are held, and a folded row as before", () => {
    const { card: target, dock } = dockedCard("appr-1", ["reject", "approve"], true);
    document.body.append(inChat(target), dock);
    expect(rejectKeyOf(target)).toBeNull();
    const frames = manualFrames();
    revealApprovalCard("appr-1", frames);
    frames.step();
    expect(document.activeElement).toBe(target);
    document.body.innerHTML = "";
    const row = card("appr-2", "row");
    document.body.append(row);
    revealApprovalCard("appr-2", frames);
    frames.step();
    expect(document.activeElement).toBe(row);
  });

  it("finds the real docked card's Reject", async () => {
    const { render } = await import("@testing-library/react");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { createElement } = await import("react");
    const { ApprovalCard } = await import("../ApprovalCard.js");
    const dock = document.createElement("div");
    document.body.appendChild(dock);
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(ApprovalCard, {
          summary: {
            id: "appr-real",
            sessionId: "00000000-0000-4000-8000-00000000aa01",
            toolCallId: "call-1",
            toolName: "wallet:send",
            status: "pending",
            permissionAtEnqueue: "restricted",
            createdAt: "2026-05-28T10:00:00.000Z",
            resolvedAt: null,
            reasoningPreview: "",
            actionKind: "user_wallet_broadcast",
            riskLevel: "high",
            preview: { toolName: "send", namespace: "wallet", criticalArgs: { amount: "0.5" } },
            expiresAt: null,
            decision: null,
            decisionReason: null,
            executionStatus: null,
            origin: null,
            projectId: null,
            requestedByClient: null,
          },
          sessionId: "00000000-0000-4000-8000-00000000aa01",
          focusOnMount: false,
          decisionDock: dock,
        }),
      ),
    );
    const target = findApprovalCard("appr-real") as HTMLElement;
    const key = rejectKeyOf(target);
    expect(key?.getAttribute("data-vex-key")).toBe("reject");
    expect(dock.contains(key)).toBe(true);
  });
});
