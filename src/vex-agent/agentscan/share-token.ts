import { randomBytes } from "node:crypto";

export function generateShareToken(): string {
  return `vex_share_${randomBytes(32).toString("base64url")}`;
}
