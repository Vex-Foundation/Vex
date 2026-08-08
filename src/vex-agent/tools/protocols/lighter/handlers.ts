import type { ProtocolHandler } from "../types.js";
import { LIGHTER_READ_HANDLERS } from "./handlers/read.js";

export const LIGHTER_HANDLERS: Record<string, ProtocolHandler> = {
  ...LIGHTER_READ_HANDLERS,
};
