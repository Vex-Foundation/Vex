/**
 * IPC contracts for the user's own MCP servers (F12, Settings > Tools (MCP)).
 *
 * A token crosses this boundary only INTO main (`addUserMcpServer`,
 * `setUserMcpToken`) and is never part of any output: the list says only
 * whether a server has one.
 */

import { z } from "zod";

const id = z.string().uuid();

export const listUserMcpInputSchema = z.object({}).strict();

export const addUserMcpServerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    endpoint: z.string().trim().min(1).max(2_000),
    token: z.string().max(4_000).nullable(),
  })
  .strict();

export const removeUserMcpServerInputSchema = z.object({ serverId: id }).strict();

export const setUserMcpTokenInputSchema = z
  .object({ serverId: id, token: z.string().min(1).max(4_000).nullable() })
  .strict();

export const setUserMcpToolEnabledInputSchema = z.object({ toolId: id, enabled: z.boolean() }).strict();

export const setUserMcpToolAutoRunInputSchema = z.object({ toolId: id, autoRun: z.boolean() }).strict();

export const recheckUserMcpServerInputSchema = z
  .object({ serverId: id, reviewToolId: id.nullable().optional() })
  .strict();

export const userMcpToolDtoSchema = z
  .object({
    id,
    /** The name the model calls it by (`mcp_t…`), for transcript labels. */
    modelName: z.string().regex(/^mcp_t[0-9a-f]{16}$/),
    remoteName: z.string().min(1).max(200),
    description: z.string().max(1_000),
    readOnlyHint: z.boolean(),
    enabled: z.boolean(),
    autoRun: z.boolean(),
    status: z.enum(["active", "drifted", "unsupported"]),
    unsupportedReason: z.string().max(200).nullable(),
    /** The pinned input schema as JSON, cut for display. */
    schemaJson: z.string().max(4_100),
  })
  .strict();

export const userMcpServerDtoSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    endpoint: z.string().min(1).max(2_000),
    networkScope: z.enum(["public", "local"]),
    hasToken: z.boolean(),
    status: z.enum(["active", "error", "disabled"]),
    lastCheckedAt: z.string().nullable(),
    lastError: z.string().max(64).nullable(),
    tools: z.array(userMcpToolDtoSchema),
  })
  .strict();

export const userMcpListDtoSchema = z
  .object({
    servers: z.array(userMcpServerDtoSchema),
    enabledCount: z.number().int().min(0),
    maxEnabled: z.number().int().positive(),
    maxServers: z.number().int().positive(),
  })
  .strict();

export type AddUserMcpServerInput = z.infer<typeof addUserMcpServerInputSchema>;
export type RemoveUserMcpServerInput = z.infer<typeof removeUserMcpServerInputSchema>;
export type SetUserMcpTokenInput = z.infer<typeof setUserMcpTokenInputSchema>;
export type SetUserMcpToolEnabledInput = z.infer<typeof setUserMcpToolEnabledInputSchema>;
export type SetUserMcpToolAutoRunInput = z.infer<typeof setUserMcpToolAutoRunInputSchema>;
export type RecheckUserMcpServerInput = z.infer<typeof recheckUserMcpServerInputSchema>;
export type UserMcpToolDto = z.infer<typeof userMcpToolDtoSchema>;
export type UserMcpServerDto = z.infer<typeof userMcpServerDtoSchema>;
export type UserMcpListDto = z.infer<typeof userMcpListDtoSchema>;
