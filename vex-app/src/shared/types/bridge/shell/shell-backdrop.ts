import type { Result } from "../../../ipc/result.js";
import type {
  ShellBackdropClearResult,
  ShellBackdropPickResult,
  ShellBackdropReadResult,
} from "../../../schemas/shell-backdrop.js";

/**
 * The user's own backdrop under the glass shell - ONE image per installation.
 *
 * THREE METHODS, NONE OF WHICH TAKES AN ARGUMENT, and that is the contract:
 * `pick` opens the MAIN-owned file picker (the renderer neither sends nor
 * learns a path), and because there is exactly one backdrop there is no id
 * for `read` or `clear` to name. What comes back is an opaque id, the
 * validated size and mime, and the `app://vex/user-backdrop/<id>` URL the
 * app protocol serves the bytes from.
 *
 * A dismissed picker is NOT a failure: `pick` resolves ok with
 * `cancelled: true` and the unchanged current record. A failed `Result`
 * means the file was refused BY NAME (`shellBackdrop.too_large`,
 * `.unsupported_format`, `.undecodable`, ...), the store was unreachable,
 * the input did not validate, or the sender was not trusted.
 */
export interface ShellBackdropBridge {
  readonly pick: () => Promise<Result<ShellBackdropPickResult>>;
  readonly clear: () => Promise<Result<ShellBackdropClearResult>>;
  readonly read: () => Promise<Result<ShellBackdropReadResult>>;
}
