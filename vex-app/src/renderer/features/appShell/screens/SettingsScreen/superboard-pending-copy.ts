/**
 * Pending Superboard linking errors arrive as machine detail (HTTP 404
 * not_found, share_token_conflict, …). Settings shows a human sentence.
 */

export function superboardPendingCopy(lastError: string | null): string {
  if (lastError === null || lastError.length === 0) return "Not linked yet.";
  const text = lastError.toLowerCase();
  if (text === "unauthorized" || text.includes("401")) {
    return "AgentScan isn't connected. Try again after it's linked.";
  }
  if (text === "quarantined") {
    return "AgentScan paused this install.";
  }
  if (text === "consent_revoked") {
    return "AgentScan access was revoked.";
  }
  if (text === "share_token_conflict" || text.includes("409")) {
    return "This key couldn't be linked.";
  }
  if (text.includes("429") || text.includes("rate_limited")) {
    return "Too many attempts. Wait a moment and try again.";
  }
  return "Couldn't link this key yet. Try again later.";
}
