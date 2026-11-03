/**
 * THE HARNESS MARK - the string every part of the H3 shell harness carries at
 * runtime, so a production build that swallowed any of it can be told apart
 * from one that did not.
 *
 * `scripts/check-build-artifacts.mjs` (gate 14) fails the build when this
 * literal appears anywhere in `dist/`. It is a RUNTIME value on purpose: a
 * comment or a type is gone after minification, while a string the code
 * actually uses survives it. So the frame stamps it on its root element, the
 * stand-in bridge answers with it as its correlation id, and every fixture is
 * registered through `fixture()` below, whose global write is a side effect no
 * bundler may drop - a fixture module pulled into a bundle brings the mark
 * with it. Changing the literal means changing the gate's `H3_HARNESS_MARKS`
 * in the same commit.
 */

export const H3_HARNESS_MARK = "vex-h3-shell-harness";

type FixtureRegistry = Record<string, unknown>;

/**
 * Register one piece of fixture data under the mark and hand it back.
 *
 * The registry is also the way to read what a state is showing: in the
 * browser console, `window["vex-h3-shell-harness"]` lists every fixture the
 * loaded state registered, by name.
 */
export function fixture<T>(name: string, data: T): T {
  const host = globalThis as unknown as Record<string, FixtureRegistry | undefined>;
  const registry = (host[H3_HARNESS_MARK] ??= {});
  registry[name] = data;
  return data;
}
