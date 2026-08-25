/**
 * Public gate for the board presentation tool.
 *
 * The handler is the only export. `./hydrate.ts` is an implementation detail
 * with one caller and stays private: a second caller would mean a second
 * answer to "which market facts a board shows".
 */

export { handleBoardCompose } from "./compose.js";
