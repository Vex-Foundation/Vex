import type { ProtocolHandler } from "../types.js";
import { LIGHTER_READ_HANDLERS } from "./handlers/read.js";
import { LIGHTER_WRITE_HANDLERS } from "./handlers/write.js";

export const LIGHTER_HANDLERS: Record<string, ProtocolHandler> = {
  ...LIGHTER_READ_HANDLERS,
  ...LIGHTER_WRITE_HANDLERS,
};
