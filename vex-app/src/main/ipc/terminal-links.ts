import { clipboard, shell, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { domainToUnicode } from "node:url";
import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  answerTerminalLinkInputSchema,
  cancelTerminalLinkInputSchema,
  openTerminalLinkInputSchema,
  openTerminalLinkValueSchema,
  TERMINAL_LINK_MAX_LENGTH,
  TERMINAL_LINK_PROPOSAL_TTL_MS,
  type OpenTerminalLinkValue,
  type TerminalLinkHost,
  type TerminalLinkProposal,
  type TerminalLinkRefusal,
} from "@shared/schemas/terminal-links.js";
import { isUserOpenableTerminalLink } from "../security/url.js";
import { globalCleanup } from "../lifecycle/cleanup-registry.js";
import { registerHandler } from "./register-handler.js";

const REMEMBERED_HOSTS_PER_WINDOW = 128;
const PENDING_PER_WINDOW = 32;
const PROPOSAL_RECORD_LIMIT = 1024;

type ClosedReason = "terminal_link_proposal_expired" | "terminal_link_proposal_already_answered" | "terminal_link_proposal_cancelled";
type ProposalRecord = {
  readonly windowId: number;
} & (
  | { readonly kind: "pending"; readonly proposal: TerminalLinkProposal; readonly timer: ReturnType<typeof setTimeout> }
  | { readonly kind: "closed"; readonly reason: ClosedReason }
);
interface WindowAuthority {
  readonly trusted: Set<string>;
  readonly pending: Set<string>;
  readonly generation: () => number;
  readonly dispose: () => void;
}

/** Main alone owns both proposals and remembered trust. Closed records contain no URL. */
const proposals = new Map<string, ProposalRecord>();
const windows = new Map<number, WindowAuthority>();

function refused(reason: TerminalLinkRefusal): Result<OpenTerminalLinkValue> {
  return ok({ kind: "refused", reason });
}

function closeProposal(id: string, reason: ClosedReason): void {
  const record = proposals.get(id);
  if (record?.kind !== "pending") return;
  clearTimeout(record.timer);
  windows.get(record.windowId)?.pending.delete(id);
  proposals.set(id, { kind: "closed", windowId: record.windowId, reason });
}

function authorityFor(sender: WebContents): WindowAuthority {
  const existing = windows.get(sender.id);
  if (existing !== undefined) return existing;
  const trusted = new Set<string>();
  const pending = new Set<string>();
  let generation = 0;
  const clear = (): void => {
    generation += 1;
    for (const id of pending) closeProposal(id, "terminal_link_proposal_cancelled");
    trusted.clear();
  };
  const navigate = (_event: Electron.Event, _url: string, _inPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame) clear();
  };
  const destroyed = (): void => {
    clear();
    windows.delete(sender.id);
  };
  sender.on("did-start-navigation", navigate);
  sender.once("destroyed", destroyed);
  const authority: WindowAuthority = {
    trusted, pending, generation: () => generation,
    dispose: () => {
      clear();
      sender.removeListener("did-start-navigation", navigate);
      sender.removeListener("destroyed", destroyed);
    },
  };
  windows.set(sender.id, authority);
  return authority;
}

/** Release timers and listeners as well as trust, including in test teardown. */
export function __resetTerminalLinkTrustForTests(): void {
  for (const authority of windows.values()) authority.dispose();
  windows.clear();
  proposals.clear();
}

function describeHost(ascii: string): TerminalLinkHost {
  return { ascii, display: domainToUnicode(ascii) || ascii };
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function propose(sender: WebContents, url: string, host: TerminalLinkHost): Result<OpenTerminalLinkValue> {
  const authority = authorityFor(sender);
  if (authority.pending.size >= PENDING_PER_WINDOW) return refused("terminal_link_proposal_limit");
  // Evict only closed diagnostics. A live proposal never disappears to admit another.
  if (proposals.size >= PROPOSAL_RECORD_LIMIT) {
    for (const [id, record] of proposals) {
      if (record.kind === "closed") {
        proposals.delete(id);
        break;
      }
    }
    if (proposals.size >= PROPOSAL_RECORD_LIMIT) return refused("terminal_link_proposal_limit");
  }
  const proposal: TerminalLinkProposal = {
    id: randomUUID(), url, host, expiresAt: Date.now() + TERMINAL_LINK_PROPOSAL_TTL_MS,
  };
  const timer = setTimeout(() => closeProposal(proposal.id, "terminal_link_proposal_expired"), TERMINAL_LINK_PROPOSAL_TTL_MS);
  timer.unref();
  proposals.set(proposal.id, { kind: "pending", windowId: sender.id, proposal, timer });
  authority.pending.add(proposal.id);
  return ok({ kind: "pending", proposal });
}

function resolveProposal(id: string, windowId: number): TerminalLinkProposal | TerminalLinkRefusal {
  const record = proposals.get(id);
  if (record === undefined) return "terminal_link_proposal_unknown";
  if (record.windowId !== windowId) return "terminal_link_proposal_other_window";
  if (record.kind === "closed") return record.reason;
  if (Date.now() >= record.proposal.expiresAt) {
    closeProposal(id, "terminal_link_proposal_expired");
    return "terminal_link_proposal_expired";
  }
  return record.proposal;
}

async function openUrl(url: string, host: TerminalLinkHost, asked: boolean): Promise<Result<OpenTerminalLinkValue>> {
  try {
    await shell.openExternal(url);
    return ok({ kind: "opened", host, asked });
  } catch {
    // An OS handler failure may include a private URL or local path.
    return refused("terminal_link_open_failed");
  }
}

export function registerTerminalLinkHandlers(): Array<() => void> {
  const unregisterCleanup = globalCleanup.add(__resetTerminalLinkTrustForTests, "terminal-link-authority");
  return [
    () => { __resetTerminalLinkTrustForTests(); void unregisterCleanup(); },
    registerHandler({
      channel: CH.terminal.openLink, domain: "studio",
      inputSchema: openTerminalLinkInputSchema, outputSchema: openTerminalLinkValueSchema,
      handle: async (input, ctx): Promise<Result<OpenTerminalLinkValue>> => {
        if (ctx.event.sender.isDestroyed() || ctx.signal.aborted) return ok({ kind: "cancelled" });
        const decision = isUserOpenableTerminalLink(input.url, TERMINAL_LINK_MAX_LENGTH);
        if (decision.kind === "refused") return refused(decision.reason);
        const host = describeHost(decision.asciiHost);
        const authority = authorityFor(ctx.event.sender);
        if (isLoopback(host.ascii) || authority.trusted.has(host.ascii)) {
          return openUrl(decision.url, host, false);
        }
        return propose(ctx.event.sender, decision.url, host);
      },
    }),
    registerHandler({
      channel: CH.terminal.answerLink, domain: "studio",
      inputSchema: answerTerminalLinkInputSchema, outputSchema: openTerminalLinkValueSchema,
      handle: async (input, ctx): Promise<Result<OpenTerminalLinkValue>> => {
        const proposal = resolveProposal(input.proposalId, ctx.event.sender.id);
        if (typeof proposal === "string") return refused(proposal);
        if (ctx.event.sender.isDestroyed() || ctx.signal.aborted) {
          closeProposal(input.proposalId, "terminal_link_proposal_cancelled");
          return ok({ kind: "cancelled" });
        }
        // Consume before the first await: simultaneous answers have one decision slot.
        closeProposal(input.proposalId, "terminal_link_proposal_already_answered");
        if (input.choice === "cancel") return ok({ kind: "declined", host: proposal.host });
        if (input.choice === "copy") {
          try {
            clipboard.writeText(proposal.url);
            return ok({ kind: "copied", host: proposal.host });
          } catch {
            return refused("terminal_link_copy_failed");
          }
        }
        const decision = isUserOpenableTerminalLink(proposal.url, TERMINAL_LINK_MAX_LENGTH);
        if (decision.kind === "refused") return refused(decision.reason);
        const authority = windows.get(ctx.event.sender.id);
        const generation = authority?.generation();
        const result = await openUrl(proposal.url, proposal.host, true);
        if (result.ok && result.data.kind === "opened" && input.rememberHost &&
            !ctx.signal.aborted && !ctx.event.sender.isDestroyed() &&
            authority !== undefined && authority.generation() === generation &&
            windows.get(ctx.event.sender.id) === authority &&
            authority.trusted.size < REMEMBERED_HOSTS_PER_WINDOW) {
          authority.trusted.add(proposal.host.ascii);
        }
        return result;
      },
    }),
    registerHandler({
      channel: CH.terminal.cancelLink, domain: "studio",
      inputSchema: cancelTerminalLinkInputSchema, outputSchema: openTerminalLinkValueSchema,
      handle: async (input, ctx): Promise<Result<OpenTerminalLinkValue>> => {
        const proposal = resolveProposal(input.proposalId, ctx.event.sender.id);
        if (typeof proposal === "string") return refused(proposal);
        closeProposal(input.proposalId, "terminal_link_proposal_cancelled");
        return ok({ kind: "cancelled" });
      },
    }),
  ];
}
