/**
 * Settings > Tools (MCP): TanStack Query hooks over the user MCP channels.
 *
 * Every write answers with the fresh list, which replaces the cached one, so
 * the section shows exactly what main stored.
 */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  AddUserMcpServerInput,
  RecheckUserMcpServerInput,
  RemoveUserMcpServerInput,
  SetUserMcpTokenInput,
  SetUserMcpToolAutoRunInput,
  SetUserMcpToolEnabledInput,
  UserMcpListDto,
} from "@shared/schemas/user-mcp.js";

export const userMcpKeys = { list: ["settings", "userMcp", "list"] as const };

export function useUserMcpList(): UseQueryResult<Result<UserMcpListDto>> {
  return useQuery({
    queryKey: userMcpKeys.list,
    queryFn: () => window.vex.settings.listUserMcp(),
    staleTime: 30_000,
  });
}

/** A write that replaces the cached list with the one main answered. */
function useUserMcpWrite<I>(call: (input: I) => Promise<Result<UserMcpListDto>>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (result) => {
      if (result.ok) client.setQueryData(userMcpKeys.list, result);
    },
  });
}

export const useAddUserMcpServer = () =>
  useUserMcpWrite((input: AddUserMcpServerInput) => window.vex.settings.addUserMcpServer(input));
export const useRemoveUserMcpServer = () =>
  useUserMcpWrite((input: RemoveUserMcpServerInput) => window.vex.settings.removeUserMcpServer(input));
export const useSetUserMcpToken = () =>
  useUserMcpWrite((input: SetUserMcpTokenInput) => window.vex.settings.setUserMcpToken(input));
export const useSetUserMcpToolEnabled = () =>
  useUserMcpWrite((input: SetUserMcpToolEnabledInput) => window.vex.settings.setUserMcpToolEnabled(input));
export const useSetUserMcpToolAutoRun = () =>
  useUserMcpWrite((input: SetUserMcpToolAutoRunInput) => window.vex.settings.setUserMcpToolAutoRun(input));
export const useRecheckUserMcpServer = () =>
  useUserMcpWrite((input: RecheckUserMcpServerInput) => window.vex.settings.recheckUserMcpServer(input));

/** The sentence of a refusal (`CODE: sentence`), without its code. */
export function userMcpErrorText(result: Result<unknown> | undefined): string | null {
  if (result === undefined || result.ok) return null;
  const message = result.error.message ?? "";
  const colon = message.indexOf(": ");
  if (colon > 0 && /^[A-Z_]+$/.test(message.slice(0, colon))) return message.slice(colon + 2);
  return message.length > 0 ? message : "That did not work.";
}
