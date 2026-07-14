import { err, type Result } from "@shared/ipc/result.js";
import { getSessionById } from "../../database/sessions-db.js";

export function unavailable(message: string, correlationId: string): Result<never> {
  return err({
    code: "internal.unexpected",
    domain: "hyperliquid",
    message,
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

export async function requireExistingHyperliquidSession(
  sessionId: string,
  correlationId: string,
): Promise<Result<never> | null> {
  const session = await getSessionById(sessionId);
  if (!session.ok) return session;
  if (session.data !== null) return null;
  return err({
    code: "validation.invalid_input",
    domain: "hyperliquid",
    message: "The requested session no longer exists.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}
