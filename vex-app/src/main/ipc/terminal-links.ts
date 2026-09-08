import { clipboard, shell, type BrowserWindow, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { domainToUnicode } from "node:url";
import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  answerTerminalLinkInputSchema, openTerminalLinkInputSchema, openTerminalLinkValueSchema,
  TERMINAL_LINK_MAX_LENGTH, TERMINAL_LINK_PROPOSAL_TTL_MS,
  type OpenTerminalLinkValue, type TerminalLinkHost, type TerminalLinkProposal, type TerminalLinkRefusal,
} from "@shared/schemas/terminal-links.js";
import { isUserOpenableTerminalLink } from "../security/url.js";
import { createTerminalLinkConsentWindow } from "../windows/terminal-link-consent.js";
import { globalCleanup } from "../lifecycle/cleanup-registry.js";
import { registerHandler } from "./register-handler.js";

const REMEMBERED_HOSTS_PER_WINDOW = 128;
const PENDING_PER_WINDOW = 32;
const PROPOSAL_RECORD_LIMIT = 1024;
type ClosedReason = "terminal_link_proposal_expired" | "terminal_link_proposal_already_answered" | "terminal_link_proposal_cancelled";
type Pending = {
  readonly kind: "pending";
  readonly windowId: number;
  readonly consentId: number;
  readonly parent: WebContents;
  readonly proposal: TerminalLinkProposal;
  readonly window: BrowserWindow;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly releaseAbort: () => void;
  readonly settle: (result: Result<OpenTerminalLinkValue>) => void;
};
type RecordValue = Pending | { readonly kind: "closed"; readonly windowId: number; readonly consentId: number; readonly reason: ClosedReason };
interface WindowAuthority {
  readonly trusted: Set<string>;
  readonly pending: Set<string>;
  readonly generation: () => number;
  readonly dispose: () => void;
}
const proposals = new Map<string, RecordValue>();
const windows = new Map<number, WindowAuthority>();
function refused(reason: TerminalLinkRefusal): Result<OpenTerminalLinkValue> { return ok({ kind: "refused", reason }); }

function consume(id: string, reason: ClosedReason): Pending | undefined {
  const record = proposals.get(id);
  if (record?.kind !== "pending") return undefined;
  clearTimeout(record.timer);
  record.releaseAbort();
  windows.get(record.windowId)?.pending.delete(id);
  proposals.set(id, { kind: "closed", windowId: record.windowId, consentId: record.consentId, reason });
  if (!record.window.isDestroyed()) record.window.close();
  return record;
}
function cancel(id: string, reason: ClosedReason): void {
  const record = consume(id, reason);
  record?.settle(reason === "terminal_link_proposal_expired" ? refused(reason) : ok({ kind: "cancelled" }));
}
function authorityFor(sender: WebContents): WindowAuthority {
  const existing = windows.get(sender.id);
  if (existing !== undefined) return existing;
  const trusted = new Set<string>();
  const pending = new Set<string>();
  let generation = 0;
  const clear = (): void => {
    generation += 1;
    for (const id of pending) cancel(id, "terminal_link_proposal_cancelled");
    trusted.clear();
  };
  const navigate = (_event: Electron.Event, _url: string, _inPlace: boolean, isMainFrame: boolean): void => { if (isMainFrame) clear(); };
  const destroyed = (): void => { clear(); windows.delete(sender.id); };
  sender.on("did-start-navigation", navigate);
  sender.once("destroyed", destroyed);
  const authority: WindowAuthority = {
    trusted, pending, generation: () => generation,
    dispose: () => { clear(); sender.removeListener("did-start-navigation", navigate); sender.removeListener("destroyed", destroyed); },
  };
  windows.set(sender.id, authority);
  return authority;
}
export function __resetTerminalLinkTrustForTests(): void {
  for (const authority of windows.values()) authority.dispose();
  windows.clear(); proposals.clear();
}
async function openUrl(url: string, host: TerminalLinkHost, asked: boolean): Promise<Result<OpenTerminalLinkValue>> {
  try { await shell.openExternal(url); return ok({ kind: "opened", host, asked }); }
  catch { return refused("terminal_link_open_failed"); }
}
function propose(parent: WebContents, url: string, host: TerminalLinkHost, signal: AbortSignal): Promise<Result<OpenTerminalLinkValue>> {
  const authority = authorityFor(parent);
  if (authority.pending.size >= PENDING_PER_WINDOW) return Promise.resolve(refused("terminal_link_proposal_limit"));
  if (proposals.size >= PROPOSAL_RECORD_LIMIT) {
    for (const [id, record] of proposals) { if (record.kind === "closed") { proposals.delete(id); break; } }
    if (proposals.size >= PROPOSAL_RECORD_LIMIT) return Promise.resolve(refused("terminal_link_proposal_limit"));
  }
  const proposal: TerminalLinkProposal = { id: randomUUID(), url, host, expiresAt: Date.now() + TERMINAL_LINK_PROPOSAL_TTL_MS };
  let window: BrowserWindow;
  try { window = createTerminalLinkConsentWindow(parent, proposal); }
  catch { return Promise.resolve(refused("terminal_link_consent_unavailable")); }
  return new Promise(resolve => {
    const abort = (): void => cancel(proposal.id, "terminal_link_proposal_cancelled");
    const timer = setTimeout(() => cancel(proposal.id, "terminal_link_proposal_expired"), TERMINAL_LINK_PROPOSAL_TTL_MS);
    timer.unref();
    proposals.set(proposal.id, { kind: "pending", windowId: parent.id, consentId: window.webContents.id, parent,
      proposal, window, timer, signal, releaseAbort: () => signal.removeEventListener("abort", abort), settle: resolve });
    authority.pending.add(proposal.id);
    window.once("closed", abort);
    window.webContents.once("destroyed", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || parent.isDestroyed() || window.isDestroyed()) abort();
  });
}
export function registerTerminalLinkHandlers(): Array<() => void> {
  const unregisterCleanup = globalCleanup.add(__resetTerminalLinkTrustForTests, "terminal-link-authority");
  return [
    () => { __resetTerminalLinkTrustForTests(); void unregisterCleanup(); },
    registerHandler({
      channel: CH.terminal.openLink, domain: "studio", inputSchema: openTerminalLinkInputSchema, outputSchema: openTerminalLinkValueSchema,
      handle: async (input, ctx): Promise<Result<OpenTerminalLinkValue>> => {
        if (ctx.event.sender.isDestroyed() || ctx.signal.aborted) return ok({ kind: "cancelled" });
        const decision = isUserOpenableTerminalLink(input.url, TERMINAL_LINK_MAX_LENGTH);
        if (decision.kind === "refused") return refused(decision.reason);
        const host = { ascii: decision.asciiHost, display: domainToUnicode(decision.asciiHost) || decision.asciiHost };
        if (authorityFor(ctx.event.sender).trusted.has(host.ascii)) return openUrl(decision.url, host, false);
        return propose(ctx.event.sender, decision.url, host, ctx.signal);
      },
    }),
    registerHandler({
      channel: CH.terminal.answerLink, domain: "studio", inputSchema: answerTerminalLinkInputSchema, outputSchema: openTerminalLinkValueSchema,
      handle: async (input, ctx): Promise<Result<OpenTerminalLinkValue>> => {
        const record = proposals.get(input.proposalId);
        if (record === undefined) return refused("terminal_link_proposal_unknown");
        if (record.consentId !== ctx.event.sender.id) return refused("terminal_link_proposal_other_window");
        if (record.kind === "closed") return refused(record.reason);
        if (Date.now() >= record.proposal.expiresAt) { cancel(input.proposalId, "terminal_link_proposal_expired"); return refused("terminal_link_proposal_expired"); }
        if (ctx.event.sender.isDestroyed() || ctx.signal.aborted || record.signal.aborted || record.parent.isDestroyed()) {
          cancel(input.proposalId, "terminal_link_proposal_cancelled"); return ok({ kind: "cancelled" });
        }
        // Consume before awaiting any effect. Closing this window cannot cancel an accepted answer.
        consume(input.proposalId, "terminal_link_proposal_already_answered");
        const { proposal } = record;
        let result: Result<OpenTerminalLinkValue>;
        if (input.choice === "cancel") result = ok({ kind: "declined", host: proposal.host });
        else if (input.choice === "copy") {
          try { clipboard.writeText(proposal.url); result = ok({ kind: "copied", host: proposal.host }); }
          catch { result = refused("terminal_link_copy_failed"); }
        } else {
          const decision = isUserOpenableTerminalLink(proposal.url, TERMINAL_LINK_MAX_LENGTH);
          if (decision.kind === "refused") result = refused(decision.reason);
          else {
            const authority = windows.get(record.windowId);
            const generation = authority?.generation();
            result = await openUrl(proposal.url, proposal.host, true);
            if (result.ok && result.data.kind === "opened" && input.rememberHost && !record.signal.aborted &&
              !ctx.signal.aborted && !record.parent.isDestroyed() && authority !== undefined &&
              authority.generation() === generation && windows.get(record.windowId) === authority) {
              if (authority.trusted.size < REMEMBERED_HOSTS_PER_WINDOW) authority.trusted.add(proposal.host.ascii);
              else result = ok({ ...result.data, rememberLimitReached: true });
            }
          }
        }
        record.settle(result);
        return result;
      },
    }),
  ];
}
