/**
 * THE HARNESS MARK - the string every part of the H3 shell harness carries at
 * runtime, so a production build that swallowed any of it can be told apart
 * from one that did not.
 *
 * `scripts/check-build-artifacts.mjs` (gate 14) fails the build when this
 * literal appears anywhere in `dist/`. It is a RUNTIME value on purpose: a
 * comment or a type is gone after minification, while a string the code
 * actually uses survives it. So the frame stamps it on its root element, the
 * stand-in bridge answers with it as its correlation id, and every fixture
 * builder writes it into the records it makes. Changing the literal means
 * changing the gate's `H3_HARNESS_MARKS` in the same commit.
 */

export const H3_HARNESS_MARK = "vex-h3-shell-harness";
