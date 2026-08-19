import type { ProtocolHandler } from "../types.js";
import { LIGHTER_READ_HANDLERS } from "./handlers/read.js";
import { LIGHTER_WRITE_HANDLERS } from "./handlers/write.js";
import { LIGHTER_DEPOSIT_HANDLERS } from "./handlers/deposit.js";
import { LIGHTER_KEY_REGISTRATION_HANDLERS } from "./handlers/key-registration.js";
import { LIGHTER_WITHDRAWAL_HANDLERS } from "./handlers/withdrawal.js";

export const LIGHTER_HANDLERS: Record<string, ProtocolHandler> = {
  ...LIGHTER_READ_HANDLERS,
  ...LIGHTER_WRITE_HANDLERS,
  ...LIGHTER_DEPOSIT_HANDLERS,
  ...LIGHTER_KEY_REGISTRATION_HANDLERS,
  ...LIGHTER_WITHDRAWAL_HANDLERS,
};
