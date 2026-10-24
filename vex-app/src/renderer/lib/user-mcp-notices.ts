/**
 * F12: turn the recheck worker's notices into notifications, and refresh the
 * Tools (MCP) list so Settings shows the change.
 *
 * One notification per server, tool set and day (`dedupKey`), so a server
 * that keeps the same change does not raise it every tick.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UserMcpChangedEvent } from "@shared/schemas/user-mcp.js";
import { notify } from "./notifications/index.js";
import { userMcpKeys } from "./api/user-mcp.js";

export function userMcpNoticeMessage(event: UserMcpChangedEvent): { readonly title: string; readonly message: string } {
  if (event.reason === "not_answering") {
    return {
      title: "MCP server not answering",
      message: `${event.serverName} has not answered three checks in a row, so its tools are off in chats until a check succeeds.`,
    };
  }
  const names = event.tools.slice(0, 5).join(", ");
  const more = event.tools.length > 5 ? ` and ${event.tools.length - 5} more` : "";
  return {
    title: "MCP tools changed",
    message: `${event.serverName} changed ${names}${more}. They are off until you review them in Settings > Tools (MCP).`,
  };
}

export function useUserMcpNotices(): void {
  const client = useQueryClient();
  useEffect(() => {
    // Optional-chained: partial test bridges must not crash the shell.
    const subscribe = window.vex?.engine?.onUserMcpChanged;
    if (subscribe === undefined) return;
    return subscribe((event) => {
      const { title, message } = userMcpNoticeMessage(event);
      const day = new Date().toISOString().slice(0, 10);
      notify({
        severity: "warning",
        scope: { kind: "global" },
        source: "user_mcp.recheck",
        dedupKey: `${event.serverId}:${event.reason}:${[...event.tools].sort().join(",")}:${day}`,
        title,
        message,
      });
      void client.invalidateQueries({ queryKey: userMcpKeys.list });
    });
  }, [client]);
}
