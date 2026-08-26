import type { Result } from "../../../ipc/result.js";
import type {
  BoardIconReadInput,
  BoardIconReadResult,
} from "../../../schemas/board-icons.js";

/**
 * Board token icons - the logo for one card of an agent-composed board.
 *
 * ONE METHOD, and the three things it deliberately does not offer are the
 * point: no URL, no host, and no bytes cross this interface in either
 * direction. The renderer sends an opaque handle it read out of a persisted
 * board and receives a `data:` URL that main has already fetched, bounded,
 * sniffed and dimension-checked, or a NAMED ABSENCE.
 *
 * `read` does not fail when there is no icon. Roughly half of the pools a board
 * can carry have no profile artwork at all, so absence rides the ok path as
 * `{ kind: "absent" }` and the card draws its monogram. A failed `Result` from
 * this method means the input did not validate or the sender was not trusted -
 * nothing else.
 *
 * The unavailable outcomes (`busy`, `transport`, `not_mounted`) are held apart
 * from the absent ones because the remedy differs: an absence is settled for
 * that id, while an unavailable answer means nothing was learned and asking
 * again is reasonable.
 */
export interface BoardIconsBridge {
  readonly read: (
    input: BoardIconReadInput,
  ) => Promise<Result<BoardIconReadResult>>;
}
