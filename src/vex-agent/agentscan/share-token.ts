import { randomBytes } from "node:crypto";

export function generateShareToken(): string {
  return randomBytes(32).toString("base64url");
}
