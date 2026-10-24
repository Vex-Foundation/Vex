/**
 * The engine's seam for a user MCP server's bearer token (F12).
 *
 * Tokens live in the encrypted vault, which only the Electron main process
 * can open. Main registers a reader at startup (`setupAgentBridges`), in the
 * shape of `registerDexScreenerTransport`. The engine asks it once per
 * operation and keeps the token only for that operation.
 *
 * FAIL CLOSED. With no reader registered, or while the vault is locked, a
 * server that has a token cannot be reached: the answer is `locked`, never a
 * call without the token.
 */

export type UserMcpTokenRead =
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "none" }
  | { readonly kind: "locked" };

export type UserMcpTokenReader = (serverId: string) => Promise<UserMcpTokenRead>;

let reader: UserMcpTokenReader | null = null;

export function registerUserMcpTokenReader(next: UserMcpTokenReader): () => void {
  reader = next;
  return () => {
    if (reader === next) reader = null;
  };
}

/** The token for a server that has one; `locked` when it cannot be read now. */
export async function readUserMcpToken(serverId: string, hasToken: boolean): Promise<UserMcpTokenRead> {
  if (!hasToken) return { kind: "none" };
  if (reader === null) return { kind: "locked" };
  try {
    const read = await reader(serverId);
    // A server marked as having a token whose vault entry is gone fails
    // closed too: calling it without the token is not what the user set up.
    return read.kind === "token" ? read : { kind: "locked" };
  } catch {
    return { kind: "locked" };
  }
}
