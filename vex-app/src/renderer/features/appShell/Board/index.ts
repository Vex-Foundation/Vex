/**
 * BOARD - the public gate of the transcript's board surface.
 *
 * `BoardBlock` is the ONE entry point other features compose (the transcript
 * row renders it beside the assistant body). Everything else in this
 * directory - the chart adapter, the primitive, the formatters, the view
 * model - is an implementation detail owned here, reachable by colocated
 * tests and by nothing else.
 */

export { BoardBlock, type BoardBlockProps } from "./BoardBlock.js";
