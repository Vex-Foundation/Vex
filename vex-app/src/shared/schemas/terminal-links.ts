import { z } from "zod";

/** Product bound in UTF-16 code units. Longer URLs are refused, never cut. */
export const TERMINAL_LINK_MAX_LENGTH = 4096;
/** Separate transport ceiling keeps the named product refusal reachable. */
export const TERMINAL_LINK_TRANSPORT_MAX = 65_536;
export const TERMINAL_LINK_PROPOSAL_TTL_MS = 120_000;

export const terminalLinkRefusalSchema = z.enum([
  "terminal_link_unparsable",
  "terminal_link_scheme_refused",
  "terminal_link_credentials_refused",
  "terminal_link_host_refused",
  "terminal_link_too_long",
  "terminal_link_open_failed",
  "terminal_link_copy_failed",
  "terminal_link_proposal_unknown",
  "terminal_link_proposal_expired",
  "terminal_link_proposal_already_answered",
  "terminal_link_proposal_other_window",
  "terminal_link_proposal_cancelled",
  "terminal_link_proposal_limit",
  "terminal_link_consent_unavailable",
]);
export type TerminalLinkRefusal = z.infer<typeof terminalLinkRefusalSchema>;

/** Both host spellings are shown for consent, without shortening either. */
export const terminalLinkHostSchema = z.object({
  ascii: z.string().min(1).max(TERMINAL_LINK_MAX_LENGTH),
  display: z.string().min(1).max(TERMINAL_LINK_MAX_LENGTH),
}).strict();
export type TerminalLinkHost = z.infer<typeof terminalLinkHostSchema>;

export const terminalLinkProposalSchema = z.object({
  id: z.string().uuid(),
  url: z.string().min(1).max(TERMINAL_LINK_MAX_LENGTH),
  host: terminalLinkHostSchema,
  expiresAt: z.number().int().positive(),
}).strict();
export type TerminalLinkProposal = z.infer<typeof terminalLinkProposalSchema>;

export const openTerminalLinkInputSchema = z.object({
  /** Preserve the exact terminal text through consent and opening. */
  url: z.string().min(1).max(TERMINAL_LINK_TRANSPORT_MAX),
}).strict();
export type OpenTerminalLinkInput = z.infer<typeof openTerminalLinkInputSchema>;

/** Preload-only control: the default public call remains directly awaitable. */
export const terminalLinkOpenOptionsSchema = z.object({ cancellable: z.literal(true) }).strict();
export type TerminalLinkOpenOptions = z.infer<typeof terminalLinkOpenOptionsSchema>;


/** Answers reference main-owned authority; they cannot replace its URL or host. */
export const answerTerminalLinkInputSchema = z.object({
  proposalId: z.string().uuid(),
  choice: z.enum(["open", "copy", "cancel"]),
  rememberHost: z.boolean(),
}).strict();
export type AnswerTerminalLinkInput = z.infer<typeof answerTerminalLinkInputSchema>;

/** Policy refusals are successful Results with a named reason, not transport errors. */
export const openTerminalLinkValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("opened"), host: terminalLinkHostSchema, asked: z.boolean(), rememberLimitReached: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("declined"), host: terminalLinkHostSchema }).strict(),
  z.object({ kind: z.literal("copied"), host: terminalLinkHostSchema }).strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
  z.object({ kind: z.literal("refused"), reason: terminalLinkRefusalSchema }).strict(),
]);
export type OpenTerminalLinkValue = z.infer<typeof openTerminalLinkValueSchema>;
