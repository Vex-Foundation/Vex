/**
 * Launchpad-neutral retrieval terms for the shared image locker.
 *
 * The locker is ONE locker. Its bytes live in the desktop app's own store and
 * are consumed by every launchpad Vex supports, so this namespace deliberately
 * names no chain of its own: a picture is not a chain fact, and pinning the
 * locker to whichever launchpad happened to need it first is exactly the
 * mistake this namespace exists to undo.
 *
 * `chains` is the low-weight lexical field on each manifest. It carries the
 * chains a launch can currently reach, so a query like "picture for my
 * robinhood launch" still recalls the locker, without the descriptions
 * claiming the locker belongs to any one of them.
 */

export const LAUNCHPADS_CHAINS: readonly string[] = ["Robinhood", "Base"];
